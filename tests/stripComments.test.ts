import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments } from './helpers/stripComments';

/**
 * Хелпер для структурных проверок: комментарии не должны выглядеть как код.
 */

test('stripComments: строчный комментарий удаляется', () => {
  assert.equal(stripComments('const a = 1; // alert(x)\n'), 'const a = 1; \n');
});

test('stripComments: блочный комментарий удаляется, переводы строк сохраняются', () => {
  assert.equal(stripComments('a;\n/* alert(1)\n confirm(2) */\nb;'), 'a;\n\n\nb;');
});

test('stripComments: строки и шаблоны не трогаются', () => {
  const code = 'const s = "http://x // не комментарий";\nconst t = `confirm(1)`;\n';
  assert.equal(stripComments(code), code);
});

test('stripComments: экранированная кавычка не закрывает строку', () => {
  const code = 'const s = "a \\" // b"; // alert(1)\n';
  assert.equal(stripComments(code), 'const s = "a \\" // b"; \n');
});
