/**
 * Формат якоря «Изображение N [X..Y%]» — общий для сценария (scenario.ts) и
 * импорта файлов по якорям (importPlan.ts).
 *
 * Модуль без побочных эффектов и без зависимостей от проекта/хранилища:
 * импорт не тянет applyScenarioToProject, db и rebuildSrt. Единственная
 * зависимость — panelYRange из mangaStrip (тоже чистый, без импортов),
 * чтобы кламп bbox в сценарии и в ленте был одной функцией.
 */

import { panelYRange } from './mangaStrip';

/** Подпись изображения в сценарии: «Изображение N». */
export const SCENARIO_IMAGE_LABEL = 'Изображение';

/** Число процентов из сценария: «20», «20.5», «20,5», «-10». */
const RANGE_NUM = '(-?\\d+(?:[.,]\\d+)?)';

/**
 * «Изображение N» с опциональным y-диапазоном «[X..Y%]» (знак % опционален,
 * пробелы внутри скобок допустимы). Допускаем «:»/«-» после подписи и «.»/«:» в конце.
 */
export const IMAGE_LINE_REGEX = new RegExp(
  `^${SCENARIO_IMAGE_LABEL}\\s*[:\\-]?\\s*(\\d+)\\s*` +
  `(?:\\[\\s*${RANGE_NUM}\\s*%?\\s*\\.\\.\\s*${RANGE_NUM}\\s*%?\\s*\\])?` +
  `\\s*[.:]?$`,
  'i'
);

/** Строка начинается как «Изображение N [» — но диапазон не разобран. */
const IMAGE_LINE_BROKEN_RANGE_REGEX = new RegExp(
  `^${SCENARIO_IMAGE_LABEL}\\s*[:\\-]?\\s*(\\d+)\\s*\\[`,
  'i'
);

export type YRange = { from: number; to: number };

/**
 * Результат разбора якоря:
 * - null — строка вообще не якорь (не начинается с «Изображение N»);
 * - ok — номер (0-индекс) и диапазон (null — вся картинка);
 * - error — текст ошибки БЕЗ префикса «Строка N:» (его добавляет вызывающий)
 *   и номер изображения для подавления каскада ошибок (null — номер неверный).
 */
export type ImageAnchorParse =
  | { kind: 'ok'; imageIndex: number; yRange: YRange | null }
  | { kind: 'error'; message: string; imageIndex: number | null };

function parseRangeNum(raw: string): number {
  return parseFloat(raw.replace(',', '.'));
}

/** Разбирает «Изображение N» / «Изображение N [X..Y%]». */
export function parseImageAnchor(text: string): ImageAnchorParse | null {
  const line = text.trim();
  const match = line.match(IMAGE_LINE_REGEX);
  if (match) {
    const n = parseInt(match[1], 10);
    if (n < 1) {
      return { kind: 'error', message: `номер «${SCENARIO_IMAGE_LABEL}» должен быть ≥ 1`, imageIndex: null };
    }
    const imageIndex = n - 1;
    const fromRaw = match[2];
    const toRaw = match[3];
    if (fromRaw === undefined || toRaw === undefined) return { kind: 'ok', imageIndex, yRange: null };
    const from = parseRangeNum(fromRaw);
    const to = parseRangeNum(toRaw);
    if (from < 0 || to > 100) {
      return { kind: 'error', message: `диапазон [${from}..${to}%] вне 0..100`, imageIndex };
    }
    if (from >= to) {
      return { kind: 'error', message: `в [${from}..${to}%] начало должно быть меньше конца`, imageIndex };
    }
    return { kind: 'ok', imageIndex, yRange: { from, to } };
  }

  // «Изображение N [abc..20%]» — номер есть, диапазон битый.
  const broken = line.match(IMAGE_LINE_BROKEN_RANGE_REGEX);
  if (broken) {
    const n = parseInt(broken[1], 10);
    return {
      kind: 'error',
      message: `не разобран y-диапазон — формат «${SCENARIO_IMAGE_LABEL} ${Math.max(1, n)} [0..30%]» (числа от 0 до 100)`,
      imageIndex: n >= 1 ? n - 1 : null,
    };
  }
  return null;
}

/** Число для записи диапазона: 1 знак после запятой, без «.0» (20, 20.5, 7.3). */
export function formatRangeNum(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** Диапазон покрывает всю высоту картинки — это то же, что «без диапазона». */
export function isWholeRange(range: YRange): boolean {
  return range.from <= 0 && range.to >= 100;
}

/**
 * Y-диапазон панели в виде, который парсер гарантированно примет обратно.
 * Клампит bbox в 0..100 (vision может отдать y=90, height=20 → [90..110%]),
 * fullFrame / 0..100 / битые числа → null (пишется без скобок). Если после
 * округления до 0.1 полоса схлопнулась ([50..50%]) — расширяет её до 0.1,
 * а не теряет: иначе узкая полоса стала бы «всей картинкой».
 */
export function serializableYRange(panel: {
  bbox?: { x: number; y: number; width: number; height: number };
  fullFrame?: boolean;
}): { from: string; to: string } | null {
  const range = panelYRange({ id: 0, imageIndex: 0, bbox: panel.bbox, fullFrame: panel.fullFrame });
  if (!range) return null;
  let from = Number(formatRangeNum(range.from));
  let to = Number(formatRangeNum(range.to));
  if (to <= from) {
    if (from + 0.1 <= 100) to = Math.round((from + 0.1) * 10) / 10;
    else from = Math.round((to - 0.1) * 10) / 10;
  }
  if (isWholeRange({ from, to })) return null;
  return { from: formatRangeNum(from), to: formatRangeNum(to) };
}

/** «Изображение N» / «Изображение N [X..Y%]» из уже сериализованного диапазона. */
export function formatImageAnchor(imageIndex: number, range: { from: string; to: string } | null): string {
  return range
    ? `${SCENARIO_IMAGE_LABEL} ${imageIndex + 1} [${range.from}..${range.to}%]`
    : `${SCENARIO_IMAGE_LABEL} ${imageIndex + 1}`;
}

/**
 * Каноничный якорь панели — ровно заголовок, который пишет serializeScenario.
 * Две записи одного якоря («[0..30]», «[ 0 .. 30 % ]», «[0..30,0%]», bbox
 * y=0/height=30.00001) дают одну строку, поэтому её можно сравнивать напрямую.
 */
export function panelAnchor(panel: {
  imageIndex: number;
  bbox?: { x: number; y: number; width: number; height: number };
  fullFrame?: boolean;
}): string {
  return formatImageAnchor(panel.imageIndex, serializableYRange(panel));
}

/** Каноничный якорь для разобранного «Изображение N [X..Y%]» (null — вся картинка). */
export function anchorFor(imageIndex: number, yRange: YRange | null): string {
  return panelAnchor({
    imageIndex,
    bbox: yRange ? { x: 0, y: yRange.from, width: 100, height: yRange.to - yRange.from } : undefined,
  });
}
