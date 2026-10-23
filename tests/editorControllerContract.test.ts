import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * P0-1: контракт контроллера редактора.
 *
 * Контроллер отдаёт `EditorController` через spread'ы (`...state, ...nle, ...`).
 * Это убирает ручной список из 120 полей, но создаёт риск: если два хука
 * вернут одно и то же имя, второй молча перекроет первый — без ошибки
 * типов и без падения тестов.
 *
 * Разбор идёт настоящим парсером TypeScript (он же и так в devDependencies),
 * а не регулярками: `return {...}` может содержать вложенные объекты,
 * шаблонные строки с `}` и комментарии, и текстовый поиск на этом врёт.
 */

const dir = join(process.cwd(), 'src/components/studio/editor');

type ReturnShape = {
  /** Имена, которые хук отдаёт наружу (shorthand и `key: value`). */
  keys: string[];
  /** Имена из `...spread`. */
  spreads: string[];
};

/** Разбирает файл и достаёт форму последнего `return { ... }` (AST, не regex). */
function returnShape(file: string): ReturnShape {
  const path = join(dir, file);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true);

  // Собираем кандидатов в массив: TypeScript сузил бы `let last = null`
  // до `null` и после замыкания считал бы его `never`.
  const objectReturns: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      objectReturns.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const last: ts.ObjectLiteralExpression | undefined = objectReturns[objectReturns.length - 1];
  if (!last) return { keys: [], spreads: [] };

  const shape: ReturnShape = { keys: [], spreads: [] };
  for (const prop of last.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const text = prop.expression.getText(source);
      if (/^[A-Za-z_]\w*$/.test(text)) shape.spreads.push(text);
      continue;
    }
    // shorthand (`project`) и `key: value` / `key` с комментариями
    if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
      shape.keys.push(prop.name.text);
    }
  }
  return shape;
}

const hookFiles = readdirSync(dir)
  .filter((file) => /^useEditor.*\.ts$/.test(file) && !file.endsWith('Controller.ts'))
  .sort();

/**
 * Поля, без которых экран редактора не собирается. Список намеренно короткий
 * и стабильный: это контракт с представлением, а не «сколько всего полей».
 * Раньше здесь стояло `owners.size > 100` — эвристика, которая ломалась бы
 * при осознанном укрупнении состояния.
 */
const CRITICAL_KEYS = [
  'project',
  'images',
  'tl',
  'duration',
  'srtDraft',
  'contextValue',
  'selectedId',
  'setSelectedId',
  'updateProject',
  'reloadProject',
  'isProjectLoading',
  'saveStatus',
  'notice',
  'audioBlobs',
  'audioDurations',
  'handleExport',
  'handleSeek',
  'handleImportAudio',
  'handleToggleTrackLock',
  'handleAddImages',
];

test('P0-1: контроллер собирает EditorController через spread, а не вручную', () => {
  const { keys, spreads } = returnShape('useEditorController.ts');
  for (const source of [
    'state',
    'derived',
    'loader',
    'playback',
    'persistence',
    'imagesHook',
    'srtOps',
    'dialogue',
    'audioOps',
    'audioImport',
    'scenario',
    'exportHook',
    'nle',
  ]) {
    assert.ok(spreads.includes(source), `в return контроллера нет ...${source}`);
  }
  assert.ok(keys.includes('contextValue'), 'посчитанное в контроллере должно остаться явным');
  assert.ok(keys.includes('selectedPanel'), 'selectedPanel считается в контроллере');
});

test('P0-1: ни один хук не перекрывает ключи другого через spread', () => {
  const owners = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of hookFiles) {
    const { keys } = returnShape(file);
    for (const key of keys) {
      const previous = owners.get(key);
      if (previous) clashes.push(`${key}: ${previous} ↔ ${file}`);
      else owners.set(key, file);
    }
  }
  assert.deepEqual(clashes, [], `дубли ключей между хуками: ${clashes.join('; ')}`);
});

test('P0-1: контроллер отдаёт все поля, от которых зависит представление', () => {
  const owners = new Map<string, string>();
  for (const file of hookFiles) {
    for (const key of returnShape(file).keys) owners.set(key, file);
  }
  for (const key of returnShape('useEditorController.ts').keys) owners.set(key, 'useEditorController.ts');

  const missing = CRITICAL_KEYS.filter((key) => !owners.has(key));
  assert.deepEqual(missing, [], `EditorController не отдаёт: ${missing.join(', ')}`);
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
