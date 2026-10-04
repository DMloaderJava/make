#!/usr/bin/env node
/**
 * Проверки .bat-лаунчеров, которые нельзя сделать одним регекспом по строке.
 *
 *  1. Все `npm ci` / `npm install` — и в .bat, и в .sh — используют оба флага
 *     `--no-audit --no-fund` (флаги не должны расходиться между ОС).
 *  2. Файл, использующий `!VAR!`, включает `setlocal enabledelayedexpansion`
 *     (иначе cmd.exe считает `!VAR!` литеральной строкой).
 *  3. `%ERRORLEVEL%` не используется внутри блоков `if (...)` / `for (...) do (...)`:
 *     cmd раскрывает проценты один раз при разборе всей скобки, то есть ДО
 *     выполнения команд внутри неё. Именно на этом лаунчеры «падали» после
 *     успешной установки.
 *  4. Внутри блоков нет меток: ни `::` (это метка, а не комментарий), ни `:метка`.
 *     cmd не поддерживает метки в скобочных блоках: две `::` подряд дают «The
 *     system cannot find the drive specified», метка последней строкой блока —
 *     «) was unexpected at this time», метка перед пустой строкой — «The syntax of
 *     the command is incorrect». Внутри блоков — только `rem`.
 *  5. В `echo` внутри блоков нет круглых скобок: на старых версиях cmd скобка в
 *     тексте сообщения может оборвать блок.
 *  6. В `echo` внутри блоков нет `%ERRORLEVEL%`: проценты раскрываются один раз
 *     при разборе скобки, поэтому echo напечатает код от предыдущей команды, а не
 *     от той, что выполнилась строкой выше. Нужен `!ERRORLEVEL!` (при
 *     `setlocal enabledelayedexpansion`) или вывод вне блока.
 *
 * Для правила 3 считается глубина скобок; из подсчёта исключаются комментарии
 * (`::`, `rem`), строки `echo` и содержимое кавычек. Это эвристика (без полного
 * парсера cmd), но она ловит и вариант без отступа — в отличие от проверки
 * «строка начинается с пробелов». Поведение закреплено тестами:
 * tests/launcherChecks.test.ts.
 *
 * Запускается через `npm run verify` — локально и в CI на обеих ОС.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Глубина вложенности скобок к позиции `upTo` (начиная с базовой `base`). */
function depthAt(scan, upTo, base) {
  let depth = base;
  for (let i = 0; i < upTo; i++) {
    if (scan[i] === '(') depth++;
    else if (scan[i] === ')') depth = Math.max(0, depth - 1);
  }
  return depth;
}

/**
 * Построчный разбор .bat с подсчётом глубины скобок.
 *
 * Правила подсчёта (общие для всех проверок ниже): комментарии (`::`, `rem`) и
 * строки `echo` не влияют на структуру; из строки вырезаются кавычки и строки
 * `for /f`, чтобы скобки в тексте не сбивали счёт.
 */
function forEachCodeLine(text, callback) {
  let depth = 0;

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    const isComment = /^(::|rem\b)/i.test(trimmed);
    const isEcho = /^\s*echo\b/i.test(trimmed);

    let scan = '';
    if (!isComment) {
      scan = isEcho ? '' : line.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    }

    callback({ index, line, trimmed, scan, depth, isComment, isEcho });

    if (!isComment && !isEcho) {
      for (const ch of scan) {
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
      }
    }
  });
}

/** Ищет `%ERRORLEVEL%` на строках, которые находятся внутри блока. */
export function findErrorlevelInBlocks(name, text) {
  const problems = [];

  forEachCodeLine(text, ({ index, trimmed, scan, depth, isComment }) => {
    if (isComment) return;

    let from = 0;
    let found = scan.indexOf('%ERRORLEVEL%', from);
    while (found !== -1) {
      if (depthAt(scan, found, depth) > 0) {
        problems.push(
          `${name}:${index + 1}: %ERRORLEVEL% внутри блока — нужен !ERRORLEVEL! и setlocal enabledelayedexpansion — ${trimmed}`
        );
      }
      from = found + 1;
      found = scan.indexOf('%ERRORLEVEL%', from);
    }
  });

  return problems;
}

/**
 * Метки внутри блока `(...)`: и `::` (это метка, а не комментарий), и `:метка`.
 * cmd не поддерживает метки внутри скобочных блоков — разбор ломается
 * по-разному в зависимости от версии Windows. Внутри блоков пишем `rem`,
 * `::` оставляем на верхнем уровне, а `goto`/метки — вне блоков.
 */
/**
 * Скобки в `echo` внутри блока: современный cmd понимает, что после echo идёт
 * литерал, но на старых версиях (и части редакций Server) скобка в тексте ломает
 * разбор блока. Внутри блоков такие сообщения лучше писать без скобок.
 */
export function findParenthesesInEchoBlocks(name, text) {
  const problems = [];

  forEachCodeLine(text, ({ index, line, trimmed, depth, isEcho }) => {
    if (isEcho && depth > 0 && /[()]/.test(line)) {
      problems.push(
        `${name}:${index + 1}: скобки в echo внутри блока — на части версий cmd это ломает разбор; перепишите без скобок — ${trimmed}`
      );
    }
  });

  return problems;
}

export function findLabelCommentsInBlocks(name, text) {
  const problems = [];

  forEachCodeLine(text, ({ index, trimmed, depth }) => {
    if (depth === 0 || !trimmed.startsWith(':')) return;

    if (trimmed.startsWith('::')) {
      problems.push(
        `${name}:${index + 1}: «::» внутри блока — это метка, а не комментарий; нужен rem — ${trimmed}`
      );
    } else {
      problems.push(
        `${name}:${index + 1}: метка «${trimmed.split(/[\s(]/)[0]}» внутри блока — cmd не поддерживает метки в скобочных блоках; вынесите goto из блока — ${trimmed}`
      );
    }
  });

  return problems;
}

/**
 * `%ERRORLEVEL%` в `echo` внутри блока: та же ловушка, что и в `if %ERRORLEVEL%`,
 * только без падения скрипта — проценты раскрываются при разборе скобки, и в
 * сообщении печатается код от предыдущей команды, а не от выполненной выше по
 * блоку. Проверка 3 такие строки не видит: для `echo` структурный `scan` пуст.
 */
export function findErrorlevelInEchoBlocks(name, text) {
  const problems = [];

  forEachCodeLine(text, ({ index, trimmed, depth, isEcho }) => {
    if (isEcho && depth > 0 && /%ERRORLEVEL%/i.test(trimmed)) {
      problems.push(
        `${name}:${index + 1}: %ERRORLEVEL% в echo внутри блока раскроется до выполнения — нужен !ERRORLEVEL! или вывод вне блока — ${trimmed}`
      );
    }
  });

  return problems;
}

/** @param {{[file: string]: string}} files имя → содержимое */
export function checkLaunchers(files) {
  const problems = [];
  const names = Object.keys(files).sort();
  const bats = names.filter(name => name.endsWith('.bat'));

  // Страховка от «проверка ничего не проверила»: без файлов все регекспы молчат.
  if (bats.length < 5) {
    problems.push(`найдено ${bats.length} .bat-файлов — ожидали минимум 5 (проверка не должна проходить молча)`);
  }

  for (const name of names) {
    const text = files[name];

    text.split(/\r?\n/).forEach((line, index) => {
      // `npx npm …`, `call npm.cmd …`, `start /wait npm …` и
      // `start /wait "Заголовок окна" npm …` — тоже npm-вызовы: без префиксов они
      // бы выпали из проверки флагов (в текущих лаунчерах их нет, но правило
      // должно работать на будущее). Оговорка: вызов через `call :метка`
      // статически не разворачивается — это осознанное ограничение.
      if (!/^\s*(?:call\s+)?(?:start\s+(?:\/wait\s+)?(?:"[^"]*"\s+)?)?(?:npx\s+)?npm(?:\.cmd)?\s+(?:ci|install)\b/.test(line)) return;
      if (!/--no-audit/.test(line) || !/--no-fund/.test(line)) {
        problems.push(`${name}:${index + 1}: npm-вызов без --no-audit --no-fund — ${line.trim()}`);
      }
    });

    // Правила 2–3 — только для cmd: в bash нет ни !VAR!, ни %ERRORLEVEL%.
    if (name.endsWith('.bat')) {
      if (/![A-Za-z_][A-Za-z0-9_]*!/.test(text) && !/enabledelayedexpansion/.test(text)) {
        problems.push(`${name}: использует !VAR!, но не включает setlocal enabledelayedexpansion`);
      }

      problems.push(...findErrorlevelInBlocks(name, text));
      problems.push(...findLabelCommentsInBlocks(name, text));
      problems.push(...findParenthesesInEchoBlocks(name, text));
      problems.push(...findErrorlevelInEchoBlocks(name, text));
    }
  }

  return problems;
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const files = {};
  for (const file of readdirSync('.').filter(f => f.endsWith('.bat') || f.endsWith('.sh'))) {
    files[file] = readFileSync(file, 'utf8');
  }

  const problems = checkLaunchers(files);
  // .sh-лаунчеры тоже часть поставки: если их вдруг не окажется, правило флагов
  // проверит только половину файлов — пусть это будет явная ошибка, а не тишина.
  const shCount = Object.keys(files).filter(name => name.endsWith('.sh')).length;
  if (shCount < 3) {
    problems.push(`найдено ${shCount} .sh-файлов — ожидали минимум 3 (проверка не должна проходить молча)`);
  }
  if (problems.length > 0) {
    console.error(`check:launchers — ${problems.length} проблем:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
  }
  const batCount = Object.keys(files).filter(name => name.endsWith('.bat')).length;
  console.log(`check:launchers — ok: ${batCount} .bat + ${shCount} .sh, правила npm-флагов, delayed expansion и ERRORLEVEL соблюдены`);
}
