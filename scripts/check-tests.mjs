#!/usr/bin/env node
/**
 * Проверка, что README не врёт про число файлов тестов (и заодно про
 * количество прогоняемых файлов).
 *
 * Раннер `scripts/run-tests.mjs` собирает `tests/**\/*.test.ts` сам, поэтому
 * «33 файла» в документации устаревают молча. Число в README держим в
 * маркерах и сверяем здесь: `npm run check:tests` (в `verify`), запись —
 * `npm run gen:tests`.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const README = join(root, 'README.md');
const START = '<!-- tests:files:start -->';
const END = '<!-- tests:files:end -->';

function collectTestFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectTestFiles(full, acc);
    else if (entry.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

const files = collectTestFiles(join(root, 'tests'));
const readme = readFileSync(README, 'utf8');
const startIndex = readme.indexOf(START);
const endIndex = readme.indexOf(END);

if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
  console.error(
    `check:tests — в README нет маркеров ${START} … ${END}; добавьте их вокруг числа тестовых файлов`
  );
  process.exit(1);
}

const currentValue = readme.slice(startIndex + START.length, endIndex).trim();
const actual = String(files.length);
const write = process.argv.includes('--write');

if (write) {
  const next =
    readme.slice(0, startIndex + START.length) + actual + readme.slice(endIndex);
  writeFileSync(README, next);
  console.log(`gen:tests — ok: в README записано «${actual}» файлов тестов`);
  process.exit(0);
}

if (currentValue !== actual) {
  console.error(
    `check:tests — README утверждает «${currentValue}» файлов тестов, фактически ${actual}.\n` +
      'Запустите `npm run gen:tests`, чтобы обновить README.'
  );
  process.exit(1);
}

console.log(`check:tests — ok: ${actual} файлов тестов совпадают с README`);
