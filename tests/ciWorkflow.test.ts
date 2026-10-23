import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P0-4: структура `.github/workflows/ci.yml` проверяется машинно, а не глазами.
 *
 * Регресс, который этот файл закрывает: шаг «Проверить, что артефакт desktop
 * собрался» однажды оказался в job `verify`, где `electron-builder` не
 * запускается и `release/` пуст — шаг падал с exit 1 на обеих ОС, и весь CI
 * был красным при зелёных локальных проверках.
 *
 * YAML разбирается без внешних зависимостей: у jobs в этом файле ровно один
 * уровень вложенности (`  имя:`), поэтому достаточно разрезать по нему.
 */

const root = process.cwd();
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

/** Тело job'а по имени (без шапки `jobs:`). */
function jobBody(name: string): string {
  const lines = ci.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `в ci.yml нет job'а ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // следующий job — строка с отступом ровно 2 пробела и `:`
    if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

const verifyJob = jobBody('verify');
const desktopJob = jobBody('desktop');

test('ci: desktop-артефакты проверяются только там, где идёт упаковка', () => {
  assert.ok(
    !/electron-builder/.test(verifyJob),
    'job verify не собирает desktop — electron-builder там запускаться не должен'
  );
  assert.ok(
    !/Проверить, что артефакт desktop собрался/.test(verifyJob),
    'проверка артефакта desktop попала в job verify — там release/ пуст и шаг упадёт'
  );
  assert.ok(
    !/ls -A release/.test(verifyJob),
    'job verify не создаёт release/ — проверка артефакта desktop там всегда упадёт'
  );
  assert.ok(
    /electron-builder --publish never/.test(desktopJob),
    'job desktop должен запускать electron-builder'
  );
  assert.ok(
    /Проверить, что артефакт desktop собрался/.test(desktopJob),
    'job desktop должен явно проверять, что release/ не пуст'
  );
});

test('ci: smoke-артефакты выгружаются всегда и с ограниченным сроком', () => {
  assert.match(verifyJob, /name: smoke-\$\{\{ matrix\.os \}\}/);
  assert.match(verifyJob, /if: always\(\)/);
  assert.match(verifyJob, /artifacts\/smoke-editor/);
  assert.match(verifyJob, /retention-days: 14/);
});

test('ci: verify идёт матрицей ubuntu+windows с потолком времени', () => {
  assert.match(verifyJob, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(verifyJob, /fail-fast: false/);
  assert.match(verifyJob, /timeout-minutes: \d+/);
  const timeout = Number(/timeout-minutes: (\d+)/.exec(verifyJob)?.[1]);
  assert.ok(timeout > 0 && timeout <= 25, `потолок CI по ТЗ — не больше 25 минут, сейчас ${timeout}`);
});

test('ci: полный smoke только на Linux, на Windows — сокращённый', () => {
  assert.match(verifyJob, /npm run smoke:editor\n/);
  assert.match(verifyJob, /npm run smoke:editor -- --quick/);
  assert.match(verifyJob, /runner\.os == 'Linux'/);
  assert.match(verifyJob, /runner\.os == 'Windows'/);
});

test('ci: в verify входят проверки согласованности', () => {
  for (const script of ['check:versions', 'check:providers', 'check:tests', 'check:launchers']) {
    assert.ok(verifyJob.includes(`npm run ${script}`), `verify должен запускать ${script}`);
  }
});

test('ci: desktop-артефакты не блокируют сборку из-за формата файла', () => {
  // Формат зависит от ОС (AppImage на Linux, portable exe на Windows),
  // поэтому загрузка не падает, а полноту release/ проверяет отдельный шаг.
  assert.match(desktopJob, /if-no-files-found: warn/);
  assert.ok(
    !/^\s*if-no-files-found: error\s*$/m.test(desktopJob),
    'строгий if-no-files-found ломает CI при смене layout артефактов electron-builder'
  );
});
