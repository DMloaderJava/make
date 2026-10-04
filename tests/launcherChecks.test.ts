import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkLaunchers, findErrorlevelInBlocks, findErrorlevelInEchoBlocks, findLabelCommentsInBlocks, findParenthesesInEchoBlocks } from '../scripts/check-launchers.mjs';

/**
 * Тесты на скрипт проверки .bat: он выполняется в CI и должен ловить реальные
 * ловушки cmd, не давая ложных срабатываний на легитимных конструкциях.
 * Поведение проверок зафиксировано здесь, потому что без pwsh их иначе
 * не проверить локально.
 */

const shell = (lines: string[]) => '@echo off\n' + lines.join('\n') + '\n';

test('%ERRORLEVEL% вне блока — норма, внутри блока — ошибка (с отступом и без)', () => {
  const topLevel = shell([
    'setlocal',
    'where node >nul 2>nul',
    'if %ERRORLEVEL% NEQ 0 exit /b 1',
  ]);
  assert.deepEqual(findErrorlevelInBlocks('top.bat', topLevel), []);

  const indented = shell([
    'setlocal',
    'if not exist node_modules (',
    '    if %ERRORLEVEL% NEQ 0 exit /b 1',
    ')',
  ]);
  assert.equal(findErrorlevelInBlocks('indented.bat', indented).length, 1);

  // Именно этот случай пропускала прежняя проверка «строка начинается с пробелов».
  const noIndent = shell([
    'setlocal',
    'if not exist node_modules (',
    'if %ERRORLEVEL% NEQ 0 exit /b 1',
    ')',
  ]);
  assert.equal(findErrorlevelInBlocks('noindent.bat', noIndent).length, 1);

  const sameLine = shell([
    'setlocal',
    'if exist x ( if %ERRORLEVEL% NEQ 0 exit /b 1 )',
  ]);
  assert.equal(findErrorlevelInBlocks('sameline.bat', sameLine).length, 1);
});

test('echo со скобками внутри блока не сбивает счёт глубины, комментарии не считаются', () => {
  const withEcho = shell([
    'setlocal',
    'if exist x (',
    '    echo (текст в скобках)',
    '    if %ERRORLEVEL% NEQ 0 exit /b 1',
    ')',
  ]);
  const problems = findErrorlevelInBlocks('echo.bat', withEcho);
  assert.equal(problems.length, 1, 'должна быть найдена ровно одна проблема');
  assert.match(problems[0], /%ERRORLEVEL% внутри блока/);

  const comments = shell([
    'setlocal',
    'if exist x (',
    '    :: %ERRORLEVEL% здесь упомянут текстом',
    '    rem и здесь тоже %ERRORLEVEL%',
    ')',
  ]);
  assert.deepEqual(findErrorlevelInBlocks('comments.bat', comments), []);
});

test('!ERRORLEVEL! внутри блока с enabledelayedexpansion — норма', () => {
  const good = shell([
    'setlocal enabledelayedexpansion',
    'if exist x (',
    '    if !ERRORLEVEL! NEQ 0 exit /b 1',
    ')',
  ]);
  assert.deepEqual(findErrorlevelInBlocks('good.bat', good), []);
  assert.deepEqual(checkLaunchers(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}.bat`, good]))), []);
});

test('npm-вызовы требуют оба флага, !VAR! требует delayed expansion', () => {
  const npm = shell(['setlocal', 'call npm ci --legacy-peer-deps --no-audit']);
  const five = (text: string) => Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}.bat`, i === 0 ? text : shell(['setlocal'])]));

  const npmProblems = checkLaunchers(five(npm));
  assert.equal(npmProblems.length, 1);
  assert.match(npmProblems[0], /--no-audit --no-fund/);

  const bang = shell(['setlocal', 'if exist x (', '    if !ERRORLEVEL! NEQ 0 echo bad', ')']);
  const bangProblems = checkLaunchers(five(bang));
  assert.equal(bangProblems.length, 1);
  assert.match(bangProblems[0], /enabledelayedexpansion/);

  // Префиксы npx/call и Windows-форма npm.cmd не должны прятать вызов от проверки.
  const npx = shell(['setlocal', 'npx npm ci --legacy-peer-deps --no-audit']);
  const npxProblems = checkLaunchers(five(npx));
  assert.equal(npxProblems.length, 1, 'npx npm ci без --no-fund должен ловиться');
  assert.match(npxProblems[0], /--no-audit --no-fund/);

  const cmd = shell(['setlocal', 'call npm.cmd install --no-audit']);
  const cmdProblems = checkLaunchers(five(cmd));
  assert.equal(cmdProblems.length, 1, 'call npm.cmd install без --no-fund должен ловиться');

  // .sh проверяются тем же правилом флагов: иначе --no-fund мог бы пропасть
  // из install.sh/start-*.sh незамеченным.
  const shFive = (text: string) => ({ ...five(shell(['setlocal'])), 'install.sh': text });
  const shBad = checkLaunchers(shFive('npm ci --legacy-peer-deps --no-audit\n'));
  assert.equal(shBad.length, 1);
  assert.match(shBad[0], /install\.sh.*--no-audit --no-fund/);
  const shGood = checkLaunchers(shFive('npm ci --legacy-peer-deps --no-audit --no-fund\n'));
  assert.deepEqual(shGood, []);
});

test('«::» внутри блока — ошибка (это метка, а не комментарий), rem — норма', () => {
  const labelInside = shell([
    'setlocal',
    'if exist x (',
    '    :: комментарий меткой',
    '    echo шаг',
    ')',
  ]);
  const problems = findLabelCommentsInBlocks('label.bat', labelInside);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /это метка, а не комментарий/);

  // Две подряд — тот самый случай, который даёт «cannot find the drive specified».
  const twoLabels = shell(['setlocal', 'if exist x (', '    :: раз', '    :: два', '    echo шаг', ')']);
  assert.equal(findLabelCommentsInBlocks('two.bat', twoLabels).length, 2);

  // Одиночная метка в блоке ломает разбор так же, как `::`: cmd не поддерживает
  // метки в скобочных блоках.
  const singleLabel = shell([
    'setlocal',
    'if exist x (',
    '    :loop',
    '    echo шаг',
    ')',
  ]);
  const singleProblems = findLabelCommentsInBlocks('single.bat', singleLabel);
  assert.equal(singleProblems.length, 1);
  assert.match(singleProblems[0], /метка «:loop» внутри блока/);

  const safe = shell([
    'setlocal',
    ':: верхний уровень — можно',
    ':MENU',
    'if exist x (',
    '    rem внутри блока — можно',
    '    echo (скобки в echo не считаются)',
    ')',
  ]);
  assert.deepEqual(findLabelCommentsInBlocks('safe.bat', safe), []);

  // И то же правило в общем прогоне: файл с «::» в блоке не проходит проверку.
  const five = (text: string) => Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}.bat`, i === 0 ? text : shell(['setlocal'])]));
  assert.equal(checkLaunchers(five(labelInside)).length, 1);
});

test('скобки в echo внутри блока — ошибка (старые cmd), вне блока и в комментариях — норма', () => {
  const inside = shell([
    'setlocal',
    'if exist x (',
    '    echo [INFO] Запускаю режим (быстрый)',
    '    echo шаг',
    ')',
  ]);
  const problems = findParenthesesInEchoBlocks('paren.bat', inside);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /скобки в echo внутри блока/);

  const safe = shell([
    'setlocal',
    'echo (вне блока можно)',
    'if exist x (',
    '    echo без скобок',
    '    rem (скобки в комментарии не считаются)',
    '    :: и здесь (тоже)',
    ')',
  ]);
  assert.deepEqual(findParenthesesInEchoBlocks('safe.bat', safe), []);

  // Правило подключено к общему прогону, а не живёт отдельной функцией.
  const five = (text: string) => Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}.bat`, i === 0 ? text : shell(['setlocal'])]));
  assert.equal(checkLaunchers(five(inside)).length, 1);
});

test('echo %ERRORLEVEL% внутри блока — ошибка (раскроется до выполнения), !ERRORLEVEL! — норма', () => {
  const inside = shell([
    'setlocal enabledelayedexpansion',
    'if exist x (',
    '    echo %ERRORLEVEL%',
    '    echo шаг',
    ')',
  ]);
  const problems = findErrorlevelInEchoBlocks('echoerr.bat', inside);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /%ERRORLEVEL% в echo внутри блока/);

  // Проверка 3 (по структуре) такие строки не видит — для echo структурный scan пуст,
  // поэтому правило живёт отдельной функцией и подключено к общему прогону.
  assert.deepEqual(findErrorlevelInBlocks('echoerr.bat', inside), []);
  const five = (text: string) => Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}.bat`, i === 0 ? text : shell(['setlocal'])]));
  assert.equal(checkLaunchers(five(inside)).length, 1);

  const safe = shell([
    'setlocal enabledelayedexpansion',
    'echo %ERRORLEVEL%',
    'if exist x (',
    '    echo !ERRORLEVEL!',
    ')',
  ]);
  assert.deepEqual(findErrorlevelInEchoBlocks('safe.bat', safe), []);
});

test('npm-вызов с префиксом start /wait тоже проверяется', () => {
  const five = (text: string) => Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`l${i}.bat`, i === 0 ? text : shell(['setlocal'])]));
  const problems = checkLaunchers(five(shell(['setlocal', 'start /wait npm ci --legacy-peer-deps --no-audit'])));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /--no-audit --no-fund/);

  // У `start` первым аргументом может идти заголовок окна — он не должен прятать вызов.
  const titled = checkLaunchers(five(shell(['setlocal', 'start /wait "Установка зависимостей" npm ci --legacy-peer-deps --no-audit'])));
  assert.equal(titled.length, 1, 'npm-вызов с заголовком окна у start должен ловиться');
  assert.match(titled[0], /--no-audit --no-fund/);
});

test('репозиторные .sh проходят проверку флагов npm', () => {
  // Правила cmd (!VAR!, %ERRORLEVEL%) к bash не применяются, но npm-вызовы
  // должны быть с обоими флагами — тем же правилом, что и .bat.
  const shFiles: Record<string, string> = {};
  for (const file of readdirSync('.').filter(f => f.endsWith('.sh'))) {
    shFiles[file] = readFileSync(file, 'utf8');
  }
  assert.ok(Object.keys(shFiles).length >= 3, 'в репозитории должно быть минимум 3 .sh');
  const problems = checkLaunchers({ ...fiveBatStub(), ...shFiles });
  assert.deepEqual(problems, []);
});

/** Заглушки .bat, чтобы не читать их повторно: минимум 5 нужен только для счётчика. */
function fiveBatStub(): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`stub${i}.bat`, 'setlocal enabledelayedexpansion\n']));
}

test('checkLaunchers: пустой список файлов не проходит молча', () => {
  const problems = checkLaunchers({});
  assert.equal(problems.length, 1);
  assert.match(problems[0], /минимум 5/);
});

test('репозиторные .bat проходят проверку', () => {
  const files: Record<string, string> = {};
  for (const file of readdirSync('.').filter(f => f.endsWith('.bat'))) {
    files[file] = readFileSync(file, 'utf8');
  }
  assert.ok(Object.keys(files).length >= 5, 'в репозитории должно быть минимум 5 .bat');
  assert.deepEqual(checkLaunchers(files), []);
});
