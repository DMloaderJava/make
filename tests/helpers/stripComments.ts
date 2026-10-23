/**
 * Убирает комментарии из исходника, не трогая содержимое строк и шаблонов.
 *
 * Нужно структурным тестам, которые ищут в коде вызовы (`alert(`, `confirm(`):
 * упоминание в комментарии — это не вызов, и падать на нём нельзя.
 */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let state: State = 'code';

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
      continue;
    }

    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }

    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }

    // Внутри строки: проверяем только закрывающую кавычку и экранирование.
    out += ch;
    if (ch === '\\') {
      if (next !== undefined) out += next;
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
    }
    i += 1;
  }

  return out;
}
