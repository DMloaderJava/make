import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkLaunchers, findErrorlevelInBlocks } from '../scripts/check-launchers.mjs';

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
