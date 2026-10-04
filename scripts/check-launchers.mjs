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

/** Ищет `%ERRORLEVEL%` на строках, которые находятся внутри блока. */
export function findErrorlevelInBlocks(name, text) {
  const problems = [];
  let depth = 0;

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();

    // Комментарии не влияют ни на структуру, ни на поиск.
    if (/^(::|rem\b)/i.test(trimmed)) return;

    let scan = line;
    if (/^\s*echo\b/i.test(scan)) {
      scan = ''; // echo — не структурная строка: скобки в тексте не считаем
    } else {
      scan = scan.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, ''); // кавычки и строки for /f
    }

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

    for (const ch of scan) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
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
      // `npx npm …` и `call npm.cmd …` — тоже npm-вызовы: без префиксов они бы
      // выпали из проверки флагов (в текущих лаунчерах их нет, но правило должно
      // работать на будущее).
      if (!/^\s*(?:call\s+)?(?:npx\s+)?npm(?:\.cmd)?\s+(?:ci|install)\b/.test(line)) return;
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
