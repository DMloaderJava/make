/**
 * Y-диапазон панели в процентах высоты страницы — общий примитив для
 * формата сценария (scenarioFormat.ts) и ленты (mangaStrip.ts).
 *
 * Правило процентов (Этап 4 п. 31–35):
 * 1. Проценты [from..to%] всегда задаются внутри ОДНОГО конкретного изображения
 *    (от верха этого слота `slot.y` до его низа `slot.y + slot.height`).
 * 2. Допустимы только значения `0 <= from < to <= 100`.
 * 3. Проценты — строго пространственные якоря (`startPx..endPx`) и НЕ влияют
 *    на длительность клипа (длительность определяется исключительно аудио: `audioStart..audioEnd`).
 */

export type YRange = { from: number; to: number };

type Bbox = { x: number; y: number; width: number; height: number };

export type YRangeValidation =
  | { ok: true; range: YRange }
  | { ok: false; error: string };

/**
 * Строгая валидация процентного диапазона `0 <= from < to <= 100` (Этап 4 п. 32).
 */
export function validateYRange(from: number, to: number): YRangeValidation {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return { ok: false, error: 'Границы процентного диапазона должны быть конечными числами' };
  }
  if (from < 0 || to > 100) {
    return { ok: false, error: `диапазон [${from}..${to}%] вне 0..100` };
  }
  if (from >= to) {
    return { ok: false, error: `в [${from}..${to}%] начало должно быть меньше конца` };
  }
  return { ok: true, range: { from, to } };
}

/**
 * Нормализует текстовую запись диапазона (`[ 0 .. 30 % ]`, `[12,5..40]`, `0..30%`)
 * в каноническую форму `[0..30%]` / `[12.5..40%]` (Этап 4 п. 33).
 */
export function normalizeRangeText(raw: string): { ok: true; range: YRange; canonical: string } | { ok: false; error: string } {
  const trimmed = (raw || '').trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  const match = trimmed.match(/^(-?\d+(?:[.,]\d+)?)\s*%?\s*\.\.\s*(-?\d+(?:[.,]\d+)?)\s*%?$/);
  if (!match) {
    return { ok: false, error: `Не удалось разобрать диапазон «${raw}» (ожидается формат [X..Y%])` };
  }
  const from = parseFloat(match[1].replace(',', '.'));
  const to = parseFloat(match[2].replace(',', '.'));
  const v = validateYRange(from, to);
  if (!v.ok) return v;
  const fmt = (n: number) => {
    const r = Math.round(n * 10) / 10;
    return String(Object.is(r, -0) ? 0 : r);
  };
  return {
    ok: true,
    range: v.range,
    canonical: `[${fmt(from)}..${fmt(to)}%]`,
  };
}

/**
 * Полоса из bbox, если она «настоящая». null — вся страница: fullFrame, нет
 * bbox, битые числа, нулевая высота или 0..100 после клампа. X не учитывается —
 * лента всегда на всю ширину.
 */
export function yRangeFromBbox(bbox: Bbox | undefined, fullFrame?: boolean): YRange | null {
  if (fullFrame === true || !bbox) return null;
  const { y, height } = bbox;
  if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return null;
  const from = Math.max(0, Math.min(100, y));
  const to = Math.max(0, Math.min(100, y + height));
  if (to <= from) return null;
  if (isWholeRange({ from, to })) return null;
  return { from, to };
}

/** Диапазон покрывает всю высоту картинки — это то же, что «без диапазона». */
export function isWholeRange(range: YRange): boolean {
  return range.from <= 0 && range.to >= 100;
}

/**
 * Ключ полосы с точностью формата сценария (0.1%). Две панели — одна полоса,
 * если ключи равны: [30..60] из парсера и [30.000001..59.999999] из vision
 * сливаются. Ключ (а не эпсилон) транзитивен — группировка детерминирована.
 */
export function rangeKey(range: YRange): string {
  const r = (n: number) => {
    const v = Math.round(n * 10) / 10;
    return Object.is(v, -0) ? 0 : v;
  };
  return `${r(range.from)}:${r(range.to)}`;
}

/** Та же полоса (с точностью 0.1%) — правило одно для слияния spans и для timeAtScroll. */
export function sameRange(a: YRange, b: YRange): boolean {
  return rangeKey(a) === rangeKey(b);
}
