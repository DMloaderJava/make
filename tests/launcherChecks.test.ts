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
});

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
