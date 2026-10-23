import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Исходник «редактора» целиком: page.tsx + контроллер и хуки в
 * src/components/studio/editor/.
 *
 * После P0-1 редактор разделён на слои, поэтому структурные тесты, которые
 * проверяли наличие обработчика/пропа в page.tsx, читают весь модуль: инвариант
 * («EditorPage передаёт onReorderPanel в Timeline») остался тем же, изменилось
 * только место, где он записан.
 */
export function readEditorSource(): string {
  const parts: string[] = [];
  const pagePath = resolve(process.cwd(), 'src/app/editor/[id]/page.tsx');
  parts.push(readFileSync(pagePath, 'utf-8'));
  const dir = resolve(process.cwd(), 'src/components/studio/editor');
  for (const entry of readdirSync(dir).sort()) {
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      parts.push(readFileSync(join(dir, entry), 'utf-8'));
    }
  }
  return parts.join('\n');
}
