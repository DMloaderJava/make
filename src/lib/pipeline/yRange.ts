/**
 * Y-диапазон панели в процентах высоты страницы — общий примитив для
 * формата сценария (scenarioFormat.ts) и ленты (mangaStrip.ts).
 *
 * Отдельный модуль без зависимостей: сценарий не тянет ленту, лента не тянет
 * формат сценария, а правило «что считать полосой» одно на оба.
 */

export type YRange = { from: number; to: number };

type Bbox = { x: number; y: number; width: number; height: number };

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
