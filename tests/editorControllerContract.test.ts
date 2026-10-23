import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P0-1: контракт контроллера редактора.
 *
 * Контроллер отдаёт `EditorController` через spread'ы (`...state, ...nle, ...`).
 * Это убирает ручной список из 120 полей, но создаёт риск: если два хука
 * вернут одно и то же имя, второй молча перекроет первый — без ошибки
 * типов и без падения тестов. Здесь этот риск зафиксирован: наборы ключей
 * всех источников обязаны быть непересекающимися.
 */

const dir = join(process.cwd(), 'src/components/studio/editor');

/** Имена, которые хук отдаёт наружу: последний `return {...}` в файле. */
function returnedKeys(file: string): string[] {
  const source = readFileSync(join(dir, file), 'utf8');
  const matches = [...source.matchAll(/return \{([^}]*)\};/g)];
  const last = matches.at(-1);
  if (!last) return [];
  return last[1]
    .split(',')
    .map((part) => part.trim().split(':')[0].trim())
    .filter((key) => /^[A-Za-z_]\w*$/.test(key));
}

const hookFiles = readdirSync(dir)
  .filter((file) => /^useEditor.*\.ts$/.test(file) && !file.endsWith('Controller.ts'))
  .sort();

test('P0-1: контроллер собирает EditorController через spread, а не вручную', () => {
  const source = readFileSync(join(dir, 'useEditorController.ts'), 'utf8');
  const ret = source.slice(source.lastIndexOf('  return {'));
  for (const spread of ['...state', '...derived', '...loader', '...playback', '...nle', '...exportHook']) {
    assert.ok(ret.includes(spread), `в return контроллера нет ${spread}`);
  }
  assert.match(ret, /contextValue,/, 'посчитанное в контроллере должно остаться явным');
});

test('P0-1: ни один хук не перекрывает ключи другого через spread', () => {
  const owners = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of hookFiles) {
    for (const key of returnedKeys(file)) {
      const previous = owners.get(key);
      if (previous) clashes.push(`${key}: ${previous} ↔ ${file}`);
      else owners.set(key, file);
    }
  }
  assert.deepEqual(clashes, [], `дубли ключей между хуками: ${clashes.join('; ')}`);
  assert.ok(owners.size > 100, `ожидались все поля контроллера, получено ${owners.size}`);
});

test('P0-1: в контроллере нет пустых деструктуризаций хуков', () => {
  const source = readFileSync(join(dir, 'useEditorController.ts'), 'utf8');
  assert.ok(!/const \{\s*\} =/.test(source), 'осталась пустая деструктуризация `const { } = hook`');
});

test('P0-1: каждый модуль редактора не длиннее 400 строк', () => {
  const tooBig: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const lines = readFileSync(join(dir, file), 'utf8').split('\n').length;
    if (lines > 400) tooBig.push(`${file}: ${lines}`);
  }
  assert.deepEqual(tooBig, [], `превышен лимит P0-1 (400 строк): ${tooBig.join(', ')}`);
});
