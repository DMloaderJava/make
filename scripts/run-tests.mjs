#!/usr/bin/env node
/**
 * Запуск всех unit-тестов без ручного списка файлов в package.json.
 *
 * Раньше `npm test` перечислял 33 файла строкой. Новый `tests/foo.test.ts`,
 * забытый в этом списке, молча не запускался в CI — то есть тест существовал,
 * но ничего не проверял. Теперь набор собирается рекурсивно по маске
 * `tests/**\/*.test.ts`.
 *
 * Почему не `tsx --test tests/**\/*.test.ts`: оболочки по-разному раскрывают
 * glob (cmd.exe не раскрывает вовсе, npm-скрипты идут через sh). Поэтому файлы
 * находятся в Node, а `tsx` запускается с явным списком — поведение одинаково
 * на Linux, macOS и Windows.
 *
 * Дополнительные аргументы пробрасываются в тест-раннер:
 *   npm test -- providerRegistry     # только файлы, чьё имя содержит строку
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const testsDir = resolve('tests');

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `tests/fixtures` — не тесты, а общее окружение для них.
      if (entry === 'fixtures' || entry === 'node_modules') continue;
      files.push(...collect(full));
    } else if (entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

const filters = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
const flags = process.argv.slice(2).filter(arg => arg.startsWith('-'));
const all = collect(testsDir);
const selected = filters.length > 0
  ? all.filter(file => filters.some(filter => file.includes(filter)))
  : all;

if (selected.length === 0) {
  console.error(
    filters.length > 0
      ? `Не найдено ни одного теста по фильтру: ${filters.join(', ')}`
      : 'В tests/ нет файлов *.test.ts'
  );
  process.exit(1);
}

const relativeFiles = selected.map(file => relative(process.cwd(), file));
console.log(`Тесты: ${relativeFiles.length} файл(ов)${filters.length ? ` (фильтр: ${filters.join(', ')})` : ''}`);

const cli = require.resolve('tsx/cli');
const child = spawn(process.execPath, [cli, '--test', ...flags, ...relativeFiles], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', code => process.exit(code ?? 1));
child.on('error', error => {
  console.error('Не удалось запустить tsx:', error);
  process.exit(1);
});
