/**
 * Общий модуль отрисовки текстовых оверлеев интро, аутро и реплик на Canvas
 * для Preview и Export (Итерация 2.2: Б-2.1, Б-2.2).
 *
 * Гарантирует побитовое совпадение вызовов `ctx.fillText(text, x, y)` между
 * предпросмотром (`Preview.tsx`) и видеоэкспортом (`assembleVideo.ts`).
 *
 * Архитектурное решение по Б-2.2:
 * - Режим `strip` («вертикальная лента») — это чистый вебтун без плашек `drawDialogue`:
 *   облачка с репликами уже нарисованы на самой полосе манги, а субтитры при необходимости
 *   отображаются отдельным слоем (`showSubtitles`). Поэтому в фазах `'panel' | 'gap'`
 *   режима `'strip'` плашка `drawDialogue` не рисуется ни в Preview, ни в Export.
 * - В фазах `'intro'` и `'outro'` оба режима (`'panels'` и `'strip'`) рисуют титульный/финальный
 *   текст через единые функции `drawIntroOverlay` и `drawOutroOverlay`.
 */

export const DEFAULT_INTRO_OVERLAY_TEXT = 'Добро пожаловать в мир манги...';
export const DEFAULT_OUTRO_OVERLAY_TEXT = 'Спасибо за просмотр! Подписывайтесь!';

/**
 * Разбивает строку по словам так, чтобы каждая строка укладывалась в `maxWidth`.
 */
export function wrapOverlayText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const normalized = (text ?? '').trim();
  if (!normalized) return [];
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Рисует титульный оверлей интро (затемнённая подложка + до 3 строк текста по центру).
 * Вызывается одинаково в `Preview.tsx` и `assembleVideo.ts` при `sample.phase === 'intro'`.
 */
export function drawIntroOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text?: string | null
): void {
  const effectiveText = (text && text.trim()) ? text.trim() : DEFAULT_INTRO_OVERLAY_TEXT;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, h * 0.6, w, h * 0.4);

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(w * 0.035)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapOverlayText(ctx, effectiveText, w * 0.8);
  let y = h * 0.7;
  const lineStep = Math.floor(w * 0.04);
  for (const line of lines.slice(0, 3)) {
    ctx.fillText(line, w / 2, y);
    y += lineStep;
  }
}

/**
 * Рисует финальный оверлей аутро (затемнённая подложка + до 3 строк текста по центру).
 * Вызывается одинаково в `Preview.tsx` и `assembleVideo.ts` при `sample.phase === 'outro'`.
 */
export function drawOutroOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text?: string | null
): void {
  const effectiveText = (text && text.trim()) ? text.trim() : DEFAULT_OUTRO_OVERLAY_TEXT;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, h * 0.6, w, h * 0.4);

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(w * 0.035)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapOverlayText(ctx, effectiveText, w * 0.8);
  let y = h * 0.65;
  const lineStep = Math.floor(w * 0.04);
  for (const line of lines.slice(0, 3)) {
    ctx.fillText(line, w / 2, y);
    y += lineStep;
  }
}

/**
 * Рисует плашку реплики панели в режиме `'panels'` (фазы `'panel' | 'gap'`).
 * В режиме `'strip'` не вызывается (Б-2.2: чистый вебтун без плашек `drawDialogue`).
 */
export function drawDialogue(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dialogue: string,
  character: string,
  withName = true
): void {
  const cleanDialogue = (dialogue ?? '').trim();
  if (!cleanDialogue) return;

  ctx.fillStyle = 'rgba(22,22,26,0.92)';
  const boxY = h * 0.78;
  const boxH = h * 0.18;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(w * 0.08, boxY, w * 0.84, boxH, 10);
  } else {
    ctx.rect(w * 0.08, boxY, w * 0.84, boxH);
  }
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#E8B44C';
  ctx.font = '12px Inter, system-ui, sans-serif';
  if (withName && character) {
    ctx.fillText(character, w / 2, boxY + 16);
  }

  ctx.fillStyle = '#F5F5F7';
  ctx.font = '18px Inter, system-ui, sans-serif';
  const lines = wrapOverlayText(ctx, cleanDialogue, w * 0.76);
  let y = boxY + (withName ? 44 : 36);
  for (const line of lines.slice(0, 2)) {
    ctx.fillText(line, w / 2, y);
    y += 26;
  }
}
