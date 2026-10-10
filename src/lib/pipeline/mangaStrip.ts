/**
 * Режим «лента» (manga strip / webtoon scroll).
 *
 * Идея: страницы манги не переключаются кадр за кадром (как в режиме панелей),
 * а склеиваются в одну длинную вертикальную полосу, по которой «плывёт» окно
 * просмотра. Окно остаётся размером с кадр (1920×1080 в экспорте), а лента
 * живёт в виртуальных координатах — поэтому её длина не упирается в лимит
 * canvas (32767 px по высоте): мы никогда не композитим ленту целиком,
 * а рисуем только пересекающиеся со окном страницы.
 *
 * Прокрутка привязана к аудио: пока звучит страница — окно стоит (или медленно
 * проезжает по слишком длинной странице), а к концу её аудио плавно переходит
 * к следующей. Переходы приходятся на «хвост» интервала, а не на его начало,
 * иначе зритель не успевал бы прочитать страницу.
 */

export type StripEase = 'linear' | 'easeInOut';

export interface StripSlot {
  /** Индекс изображения (страницы) в исходном массиве. */
  index: number;
  /** Координаты в виртуальной ленте (y — вниз от верха ленты). */
  x: number;
  y: number;
  width: number;
  height: number;
  sourceAspect: number;
}

export interface StripLayout {
  /** Ширина ленты в виртуальных пикселях. */
  width: number;
  totalHeight: number;
  slots: StripSlot[];
  /** Размер кадра, под который считалась раскладка. */
  frameWidth: number;
  frameHeight: number;
  /** Сколько px ленты помещается в кадр по высоте (чем больше — тем мельче картинка). */
  viewport: number;
  gap: number;
  /** Масштаб, с которым рисуется лента (>=1 — крупнее кадра, <1 — мельче). */
  scale: number;
}

export interface ScrollSpan {
  /** Индекс страницы (слота) в layout. */
  slotIndex: number;
  start: number;
  end: number;
  /**
   * Явный диапазон скролла (px ленты) для панели с y-bbox (v1.3.17): окно
   * приходит в startPx к началу звучания и доезжает до endPx к его концу.
   * Без них позиция считается по слоту целиком (страница как одна панель).
   */
  startPx?: number;
  endPx?: number;
}

/** Панель для ленты: достаточно id, страницы и (опционально) bbox/fullFrame. */
export interface StripPanelRef {
  id: number;
  imageIndex: number;
  bbox?: { x: number; y: number; width: number; height: number };
  fullFrame?: boolean;
}

/**
 * Y-диапазон панели в процентах высоты страницы, если он «настоящий».
 * null — панель на всю страницу: fullFrame, нет bbox, bbox 0..100 или битые числа.
 * X не учитывается — лента всегда на всю ширину.
 */
export function panelYRange(panel: StripPanelRef | undefined): { from: number; to: number } | null {
  if (!panel || panel.fullFrame === true || !panel.bbox) return null;
  const { y, height } = panel.bbox;
  if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return null;
  const from = Math.max(0, Math.min(100, y));
  const to = Math.max(0, Math.min(100, y + height));
  if (to <= from) return null;
  if (from <= 0 && to >= 100) return null;
  return { from, to };
}

/**
 * Диапазон скролла для y-полосы [from..to]% страницы: верх полосы — у верха
 * кадра в начале, низ полосы — у низа кадра в конце. Полоса ниже кадра —
 * одна точка (центр полосы по центру кадра).
 */
function rangeScrollPx(
  layout: StripLayout,
  slot: StripSlot,
  range: { from: number; to: number }
): { startPx: number; endPx: number } {
  const yTop = slot.y + slot.height * (range.from / 100);
  const yBot = slot.y + slot.height * (range.to / 100);
  const topPx = yTop;
  const botPx = yBot - layout.frameHeight;
  if (botPx <= topPx) {
    const center = clampScroll((yTop + yBot) / 2 - layout.frameHeight / 2, layout);
    return { startPx: center, endPx: center };
  }
  return { startPx: clampScroll(topPx, layout), endPx: clampScroll(botPx, layout) };
}

type TimelineSeg = { panelId: number; imageIndex?: number; audioStart: number; audioEnd: number };

/**
 * id → панель: O(1) вместо panels.find в цикле по таймлайну.
 * Кэш по ссылке на массив: Preview зовёт timeAtScroll на каждое событие колеса
 * с тем же массивом панелей (React-состояние, иммутабельно) — индекс строится
 * один раз. Защита от мутации на месте — пересборка при смене длины.
 */
const PANEL_INDEX_CACHE = new WeakMap<object, { length: number; map: Map<number, unknown> }>();

function panelIndex<P extends { id: number }>(panels: P[] | undefined): Map<number, P> {
  if (!panels) return new Map();
  const cached = PANEL_INDEX_CACHE.get(panels);
  if (cached && cached.length === panels.length) return cached.map as Map<number, P>;
  const map = new Map<number, P>();
  for (const p of panels) map.set(p.id, p);
  PANEL_INDEX_CACHE.set(panels, { length: panels.length, map });
  return map;
}

/** Страница сегмента: из таймлайна, fallback — панель (старые сегменты без imageIndex). */
function segImageIndex(seg: TimelineSeg, byId: Map<number, { imageIndex: number }>): number | undefined {
  return typeof seg.imageIndex === 'number' ? seg.imageIndex : byId.get(seg.panelId)?.imageIndex;
}

const WHOLE_PAGE = { from: 0, to: 100 } as const;

function sameRange(a: { from: number; to: number }, b: { from: number; to: number }): boolean {
  return Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.to - b.to) < 1e-6;
}

export interface ScrollKeyframe {
  time: number;
  y: number;
  ease: StripEase;
}

export interface StripLayoutOptions {
  frameWidth: number;
  frameHeight: number;
  /**
   * Сколько пикселей ленты видно в кадре по высоте. По умолчанию — высота кадра
   * (страницы ложатся в кадр ровно по ширине). Значения < heightF кадрируют
   * сильнее (крупный план), > height показывают больше контекста.
   */
  viewport?: number;
  /** Отступ между страницами в px ленты. */
  gap?: number;
  /** Минимальная/максимальная высота отрисованной страницы (защита от панорам 1px и бесконечных полос). */
  minSlotHeight?: number;
  maxSlotHeight?: number;
}

const DEFAULT_MIN_SLOT = 240;
const DEFAULT_MAX_SLOT = 12000;

/** Складывает страницы в вертикальную ленту в виртуальных координатах. */
export function computeStripLayout(
  sizes: Array<{ width: number; height: number }>,
  options: StripLayoutOptions
): StripLayout {
  const frameWidth = Math.max(1, options.frameWidth);
  const frameHeight = Math.max(1, options.frameHeight);
  const viewport = clampStripViewport(frameHeight, Math.max(1, options.viewport ?? frameHeight));
  const gap = Math.max(0, options.gap ?? 24);
  // scale переводит «ширину кадра» в ширину ленты: viewport = frameHeight → 1.
  const scale = frameHeight / viewport;
  const width = frameWidth * scale;

  // Масштаб применяется ровно один раз (раньше minSlotHeight умножался дважды,
  // из-за чего при viewport < кадра минимум «раздувался» в scale² раз).
  const minSlotHeight = (options.minSlotHeight ?? DEFAULT_MIN_SLOT) * scale;
  const maxSlotHeight = (options.maxSlotHeight ?? DEFAULT_MAX_SLOT) * scale;

  const slots: StripSlot[] = [];
  let y = 0;
  sizes.forEach((size, index) => {
    const sourceAspect = size.height / Math.max(1, size.width);
    const height = Math.min(maxSlotHeight, Math.max(minSlotHeight, width * sourceAspect));
    slots.push({ index, x: 0, y, width, height, sourceAspect });
    y += height + gap;
  });

  const totalHeight = Math.max(0, y - (slots.length > 0 ? gap : 0));
  return { width, totalHeight, slots, frameWidth, frameHeight, viewport, gap, scale };
}

/** Максимально допустимая позиция скролла (чтобы не уехать в пустоту за конец ленты). */
export function maxScrollY(layout: StripLayout): number {
  return Math.max(0, layout.totalHeight - layout.frameHeight);
}

export function clampScroll(y: number, layout: StripLayout): number {
  return Math.min(maxScrollY(layout), Math.max(0, y));
}

/** Целевая позиция окна для страницы: центр страницы по центру кадра. */
export function targetScrollForSlot(layout: StripLayout, slotIndex: number): number {
  const slot = layout.slots[slotIndex];
  if (!slot) return 0;
  return clampScroll(slot.y + slot.height / 2 - layout.frameHeight / 2, layout);
}

/** Страницы, пересекающиеся с окном [scrollY, scrollY + frameHeight]. */
export function visibleSlots(layout: StripLayout, scrollY: number): StripSlot[] {
  const top = scrollY;
  const bottom = scrollY + layout.frameHeight;
  return layout.slots.filter(slot => slot.y < bottom && slot.y + slot.height > top);
}

/** Какая страница занимает центр окна (для подсветки/подписей). */
export function pageIndexAtScroll(layout: StripLayout, scrollY: number): number | null {
  if (layout.slots.length === 0) return null;
  const center = scrollY + layout.frameHeight / 2;
  let best: StripSlot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of layout.slots) {
    const slotCenter = slot.y + slot.height / 2;
    const distance = Math.abs(slotCenter - center);
    if (distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best ? best.index : null;
}

export interface ScrollKeyframeOptions {
  /** Длительность перехода к следующей странице, сек. */
  transition?: number;
  /** Медленно проезжать по странице, которая выше кадра (webtoon-чтение). */
  panInside?: boolean;
  /** Не начинать переход раньше, чем через N секунд после старта страницы. */
  minHold?: number;
}

/**
 * Строит траекторию скролла по интервалам озвучки страниц.
 *
 * Каждая страница «держится» в кадре почти весь свой интервал, и только в
 * последние `transition` секунд окно уезжает к следующей. Длинные страницы
 * проезжаются сверху вниз за время звучания (как в вебтуне).
 */
export function buildScrollKeyframes(
  spans: ScrollSpan[],
  layout: StripLayout,
  options: ScrollKeyframeOptions = {}
): ScrollKeyframe[] {
  const transition = Math.max(0, options.transition ?? STRIP_DEFAULTS.transition);
  const panInside = options.panInside !== false;
  const minHold = Math.max(0, options.minHold ?? 0.4);

  const ordered = [...spans].sort((a, b) => a.start - b.start);
  if (ordered.length === 0) return [{ time: 0, y: 0, ease: 'linear' }];

  const isLong = (slot: StripSlot): boolean => slot.height > layout.frameHeight + 1;

  const hasPx = (span: ScrollSpan): boolean =>
    typeof span.startPx === 'number' && typeof span.endPx === 'number';

  /** Куда окно приходит, когда страница (панель) начинает звучать. */
  const entryY = (span: ScrollSpan): number => {
    if (hasPx(span)) return clampScroll(panInside ? span.startPx! : (span.startPx! + span.endPx!) / 2, layout);
    const slot = layout.slots[span.slotIndex];
    if (!slot) return 0;
    // Длинную страницу читаем с верха, короткую — с центра.
    return isLong(slot) && panInside ? clampScroll(slot.y, layout) : targetScrollForSlot(layout, span.slotIndex);
  };

  /** Где окно оказывается к концу звучания страницы (панели). */
  const exitY = (span: ScrollSpan): number => {
    if (hasPx(span)) return clampScroll(panInside ? span.endPx! : (span.startPx! + span.endPx!) / 2, layout);
    const slot = layout.slots[span.slotIndex];
    if (!slot) return 0;
    const top = clampScroll(slot.y, layout);
    const bottom = clampScroll(slot.y + slot.height - layout.frameHeight, layout);
    return isLong(slot) && panInside && bottom > top ? bottom : targetScrollForSlot(layout, span.slotIndex);
  };

  const keys: ScrollKeyframe[] = [];

  /**
   * Ключ с тем же временем не должен затирать уже стоящий easing: на стыке двух
   * длинных страниц переход (easeInOut) и старт следующей страницы совпадают по
   * времени, и «последний победил» превращал плавный переход в резкий linear.
   */
  const pushKey = (time: number, y: number, ease: StripEase): void => {
    const last = keys[keys.length - 1];
    if (last && Math.abs(last.time - time) < 1e-4) {
      if (Math.abs(last.y - y) < 1e-3) return; // то же время и та же позиция — оставляем прежний ease
      keys[keys.length - 1] = { time, y, ease };
      return;
    }
    keys.push({ time, y, ease });
  };

  // Точки входа страниц с поправкой на «незаметный переход»: если две короткие
  // страницы дают совпадающую позицию окна, смена страницы визуально не читается.
  // В таком случае смещаем вход следующей страницы так, чтобы она въезжала
  // сверху, а не появлялась в той же точке.
  // Панели с явным диапазоном (y-bbox) не нуджим: их позиция задана автором.
  const entries = ordered.map(span => entryY(span));
  for (let i = 1; i < entries.length; i++) {
    if (hasPx(ordered[i])) continue;
    const slot = layout.slots[ordered[i].slotIndex];
    if (!slot) continue;
    const prevExit = exitY(ordered[i - 1]);
    if (Math.abs(entries[i] - prevExit) < 8) {
      const nudged = clampScroll(slot.y - Math.min(layout.gap, 8), layout);
      if (Math.abs(nudged - prevExit) >= 8) entries[i] = nudged;
    }
  }

  // До первой страницы окно уже стоит в точке входа — иначе ролик начинается с рывка.
  pushKey(0, entries[0], 'linear');

  ordered.forEach((span, i) => {
    const slot = layout.slots[span.slotIndex];
    const next = ordered[i + 1];
    const duration = Math.max(0, span.end - span.start);
    if (!slot || duration <= 0) return;

    const transitionLength = Math.min(transition, Math.max(0, duration - minHold));
    const transitionStart = Math.max(span.start, span.end - transitionLength);

    if (hasPx(span)) {
      // Панель с y-диапазоном: проезжаем ровно её полосу (для короткой
      // полосы startPx === endPx — окно стоит на её центре).
      pushKey(span.start, entries[i], 'linear');
      pushKey(transitionStart, exitY(span), 'linear');
    } else if (isLong(slot) && panInside) {
      // Страница длиннее кадра: пока звучит озвучка — медленно проезжаем её
      // сверху вниз (вебтун-чтение).
      pushKey(span.start, entries[i], 'linear');
      pushKey(transitionStart, exitY(span), 'linear');
    } else {
      // Для короткой страницы entryY == target, НО нудж выше мог сдвинуть
      // entries[i]. Раньше здесь брался target — и ключ удержания с тем же
      // временем (span.start) затирал переход, посчитанный на span.end:
      // переход «въезд страницы» пропадал, если обе страницы короткие и стоят
      // в одном и том же месте окна (4–8 px движения читаются как рывок).
      pushKey(span.start, entries[i], 'linear');
      pushKey(transitionStart, entries[i], 'linear');
    }

    if (next) {
      // Переход к следующей странице — на «хвосте» интервала, с мягким сглаживанием.
      // Ведём в точку входа следующей страницы (для длинной это её верх).
      pushKey(span.end, entries[i + 1], 'easeInOut');
    } else {
      // Последняя страница: окно остаётся ТАМ ЖЕ, где закончился проезд,
      // а не откатывается к центру (иначе на длинном вебтуне — рывок вверх).
      pushKey(span.end, exitY(span), 'linear');
    }
  });

  return normalizeKeyframes(keys);
}

/** Убирает ключи с одинаковым временем (кроме первого) и сортирует по времени. */
export function normalizeKeyframes(keys: ScrollKeyframe[]): ScrollKeyframe[] {
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const out: ScrollKeyframe[] = [];
  for (const key of sorted) {
    if (out.length === 0) {
      out.push(key);
      continue;
    }
    const last = out[out.length - 1];
    if (Math.abs(last.time - key.time) < 1e-4) {
      out[out.length - 1] = key;
    } else {
      out.push(key);
    }
  }
  return out;
}

export function easeScroll(kind: StripEase, t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  if (kind === 'easeInOut') return clamped * clamped * (3 - 2 * clamped); // smoothstep
  return clamped;
}

/** Позиция скролла в момент времени (сек). */
export function sampleScroll(keys: ScrollKeyframe[], time: number): number {
  if (keys.length === 0) return 0;
  if (time <= keys[0].time) return keys[0].y;

  for (let i = 0; i < keys.length - 1; i++) {
    const from = keys[i];
    const to = keys[i + 1];
    if (time > to.time) continue;
    const span = to.time - from.time;
    if (span <= 1e-6) return to.y;
    const t = easeScroll(to.ease, (time - from.time) / span);
    return from.y + (to.y - from.y) * t;
  }
  return keys[keys.length - 1].y;
}

export interface StripRenderOptions {
  layout: StripLayout;
  /** Изображения страниц по индексу слота (может быть меньше — пропуски игнорируются). */
  images: Array<CanvasImageSource | null | undefined>;
  scrollY: number;
  /** Рамка вокруг активной страницы (по умолчанию выключена — как просили в ревью). */
  highlightSlot?: number | null;
  highlightColor?: string;
  /**
   * Амплитуда лёгкого Ken Burns (0 — выключен). В ленте сильный зум мешает
   * чтению, поэтому по умолчанию 0.03: 1.0 → 1.03 за весь ролик.
   */
  kenBurnsAmount?: number;
  /** Вертикальный индикатор прогресса (правый скроллбар). В экспорт не включать. */
  showProgress?: boolean;
  progress?: number;
  background?: string;
}

/** Рисует видимое окно ленты. Лента целиком НЕ композитится — только видимые страницы. */
export function renderStripFrame(ctx: CanvasRenderingContext2D, options: StripRenderOptions): void {
  const { layout } = options;
  const { frameWidth: w, frameHeight: h } = layout;
  const scrollY = clampScroll(options.scrollY, layout);
  const background = options.background ?? '#0B0B0C';

  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  const amount = Math.max(0, options.kenBurnsAmount ?? 0.03);
  const zoom = 1 + amount * (maxScrollY(layout) > 0 ? Math.min(1, Math.max(0, scrollY / maxScrollY(layout))) : 0);
  if (zoom !== 1) {
    ctx.translate(w / 2, h / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-w / 2, -h / 2);
  }

  // Жёсткая обрезка по кадру: страницы на границах окна (и лёгкий зум Ken Burns)
  // не должны вылезать за пределы кадра или оставлять артефакты по краям.
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  // Лента центрируется по горизонтали: при viewport < frameHeight она шире кадра
  const x = (w - layout.width) / 2;

  for (const slot of visibleSlots(layout, scrollY)) {
    const image = options.images[slot.index];
    if (!image) continue;
    const dy = slot.y - scrollY;
    ctx.drawImage(image, x, dy, slot.width, slot.height);
  }

  if (options.highlightSlot !== null && options.highlightSlot !== undefined) {
    const slot = layout.slots[options.highlightSlot];
    if (slot) {
      ctx.strokeStyle = options.highlightColor ?? '#E8B44C';
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.9;
      ctx.strokeRect(x + 1, slot.y - scrollY + 1, slot.width - 2, slot.height - 2);
      ctx.globalAlpha = 1;
    }
  }

  if (options.showProgress) {
    const progress = Math.min(1, Math.max(0, options.progress ?? 0));
    const trackTop = 16;
    const trackHeight = h - trackTop * 2;
    const trackX = w - 12;
    const thumbHeight = Math.max(28, trackHeight * (h / Math.max(h, layout.totalHeight)));
    const thumbY = trackTop + (trackHeight - thumbHeight) * progress;
    ctx.fillStyle = 'rgba(38,38,44,0.85)';
    roundedRect(ctx, trackX, trackTop, 4, trackHeight, 2);
    ctx.fill();
    ctx.fillStyle = '#E8B44C';
    roundedRect(ctx, trackX, thumbY, 4, thumbHeight, 2);
    ctx.fill();
  }

  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  // roundRect есть в современных браузерах, но не в старых Electron/WebKit
  if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === 'function') {
    (ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/**
 * Собирает интервалы озвучки по страницам: страница звучит от начала первой
 * своей панели до конца последней.
 */
export function buildScrollSpans(
  timeline: Array<{ panelId: number; imageIndex?: number; audioStart: number; audioEnd: number }>,
  panels?: Array<{ id: number; imageIndex: number }>
): ScrollSpan[] {
  const byPage = new Map<number, { start: number; end: number }>();
  const byId = panelIndex(panels);
  for (const segment of timeline) {
    // imageIndex есть прямо в сегменте таймлайна; panels нужны лишь для старых
    // сегментов без него (или когда панель переехала на другую страницу).
    const imageIndex = segImageIndex(segment, byId);
    if (imageIndex === undefined) continue;
    const current = byPage.get(imageIndex);
    if (!current) {
      byPage.set(imageIndex, { start: segment.audioStart, end: segment.audioEnd });
    } else {
      current.start = Math.min(current.start, segment.audioStart);
      current.end = Math.max(current.end, segment.audioEnd);
    }
  }

  return [...byPage.entries()]
    .map(([slotIndex, span]) => ({ slotIndex, start: span.start, end: span.end }))
    .sort((a, b) => a.start - b.start);
}

/**
 * Интервалы скролла для сцены ленты (v1.3.17).
 *
 * - Если ни у одной панели нет y-диапазона (fullFrame / bbox 0..100 / старые
 *   проекты) — ровно buildScrollSpans: страница читается целиком, поведение
 *   старых проектов не меняется.
 * - Иначе интервалы строятся по порядку таймлайна: подряд идущие реплики с той
 *   же страницей и тем же диапазоном сливаются в один интервал (несколько
 *   реплик под одним «Изображение 1 [0..30%]» — один проезд полосы, а не
 *   «вниз-вверх-вниз»). Реплика без диапазона на такой странице — отдельный
 *   интервал на всю страницу (0..100%). Интервалы не пересекаются по времени,
 *   поэтому keyframes не дёргаются на смешанных страницах.
 */
export function buildStripScrollSpans(
  timeline: TimelineSeg[],
  layout: StripLayout,
  panels?: StripPanelRef[]
): ScrollSpan[] {
  const byId = panelIndex(panels);
  const hasRanged = timeline.some(seg => panelYRange(byId.get(seg.panelId)) !== null);
  if (!hasRanged) return buildScrollSpans(timeline, panels);

  const slotByImage = new Map(layout.slots.map((slot, i) => [slot.index, i]));
  const ordered = [...timeline].sort((a, b) => a.audioStart - b.audioStart);
  const out: ScrollSpan[] = [];
  // Диапазон каждого интервала (параллельно out) — для слияния соседних реплик.
  const outRanges: Array<{ from: number; to: number }> = [];
  for (const seg of ordered) {
    const imageIndex = segImageIndex(seg, byId);
    const slotIndex = imageIndex === undefined ? undefined : slotByImage.get(imageIndex);
    if (slotIndex === undefined) continue;
    const range = panelYRange(byId.get(seg.panelId)) ?? WHOLE_PAGE;
    const last = out[out.length - 1];
    if (last && last.slotIndex === slotIndex && sameRange(outRanges[outRanges.length - 1], range)) {
      last.end = Math.max(last.end, seg.audioEnd);
      continue;
    }
    if (range === WHOLE_PAGE) {
      // Реплика на всю страницу — без явных px: buildScrollKeyframes ведёт её
      // старой постраничной логикой (вход/выход, нудж соседних коротких страниц).
      out.push({ slotIndex, start: seg.audioStart, end: seg.audioEnd });
      outRanges.push(range);
      continue;
    }
    const { startPx, endPx } = rangeScrollPx(layout, layout.slots[slotIndex], range);
    out.push({ slotIndex, start: seg.audioStart, end: seg.audioEnd, startPx, endPx });
    outRanges.push(range);
  }
  return out;
}

/** Дефолты режима ленты (используются и в UI, и в экспорте). */
export const STRIP_DEFAULTS = {
  viewportRatio: 1, // viewport = frameHeight
  gap: 24,
  transition: 0.8,
  kenBurnsAmount: 0.03,
} as const;

/** Границы масштаба страницы (zoom = высота кадра / высота окна) — те же, что у ползунка UI. */
export const STRIP_ZOOM_MIN = 0.5;
export const STRIP_ZOOM_MAX = 1.7;

/**
 * Клампит высоту окна ленты в допустимый зум.
 *
 * Настройки ленты приходят из проекта/IDB, где значение могло оказаться любым
 * (ползунок зажимает только своё отображение): без клампа одно битое число
 * растягивало или сжимало всю ленту.
 */
export function clampStripViewport(frameHeight: number, viewport: number): number {
  const min = frameHeight / STRIP_ZOOM_MAX;
  const max = frameHeight / STRIP_ZOOM_MIN;
  return Math.min(max, Math.max(min, viewport));
}

export function resolveStripViewport(frameHeight: number, viewport?: number): number {
  if (!viewport || viewport <= 0 || !Number.isFinite(viewport)) {
    return frameHeight * STRIP_DEFAULTS.viewportRatio;
  }
  return clampStripViewport(frameHeight, viewport);
}

export interface StripSceneOptions extends StripLayoutOptions {
  /** Длительность перехода между страницами, сек. */
  transition?: number;
  /** Медленно проезжать страницы выше кадра. */
  panInside?: boolean;
  /** Амплитуда лёгкого Ken Burns (0 — выключить). */
  kenBurnsAmount?: number;
  /** Подсветка страницы с озвучкой (по умолчанию выключена). */
  highlight?: boolean;
  highlightColor?: string;
}

/**
 * Единый маппинг «панель ⇄ диапазон пикселей скролла».
 * Для каждой панели таймлайна — страница (слот), на которой она лежит, и
 * диапазон скролла, в котором эта страница читается: длинная страница —
 * полный диапазон [верх, низ], короткая — одна точка (центр).
 */
export interface PanelScrollSpan {
  panelId: number;
  imageIndex: number;
  slotIndex: number;
  startPx: number;
  endPx: number;
}

/**
 * Строит PanelScrollSpan для каждой панели таймлайна.
 * Изображение панели берётся из сегмента (imageIndex), fallback — panels.
 * Если у панели есть y-диапазон (bbox не на всю высоту, не fullFrame) —
 * диапазон считается по её полосе внутри страницы, иначе — по странице целиком.
 */
export function buildPanelScrollSpans(
  timeline: Array<{ panelId: number; imageIndex?: number; audioStart: number; audioEnd: number }>,
  layout: StripLayout,
  panels?: StripPanelRef[]
): PanelScrollSpan[] {
  const out: PanelScrollSpan[] = [];
  const byId = panelIndex(panels);
  for (const seg of timeline) {
    const panel = byId.get(seg.panelId);
    const imageIndex = segImageIndex(seg, byId);
    if (imageIndex === undefined) continue;
    const slotIndex = layout.slots.findIndex(s => s.index === imageIndex);
    if (slotIndex === -1) continue;
    const slot = layout.slots[slotIndex];
    // Панель с y-диапазоном: свой диапазон внутри страницы (v1.3.17).
    const range = panelYRange(panel);
    if (range) {
      out.push({ panelId: seg.panelId, imageIndex, slotIndex, ...rangeScrollPx(layout, slot, range) });
      continue;
    }
    const top = clampScroll(slot.y, layout);
    const bottom = clampScroll(slot.y + slot.height - layout.frameHeight, layout);
    const center = targetScrollForSlot(layout, slotIndex);
    out.push({
      panelId: seg.panelId,
      imageIndex,
      slotIndex,
      startPx: bottom > top ? top : center,
      endPx: bottom > top ? bottom : center,
    });
  }
  return out;
}

/**
 * Обратный маппинг: позиция скролла → audioStart панели, к которой приехал
 * скролл.
 * - Если у панелей страницы есть y-диапазоны (v1.3.17) — реплики группируются
 *   по диапазону (реплика без диапазона = вся страница 0..100%). Выбирается
 *   самая узкая полоса, содержащая центр окна (полоса точнее, чем «вся
 *   страница»); если центр вне всех полос — ближайшая по вертикали. Несколько
 *   реплик с одной полосой делят её пропорционально длительности озвучки.
 * - Иначе — до границы панели: последняя панель страницы, чья озвучка уже
 *   началась в момент targetTime (положение скролла внутри диапазона
 *   страницы линейно переводится в время диапазона озвучки).
 * @returns null, если ленты/таймлайна нет или на странице нет панелей.
 */
export function timeAtScroll(
  layout: StripLayout,
  timeline: Array<{ panelId: number; imageIndex?: number; audioStart: number; audioEnd: number }>,
  scrollY: number,
  panels?: StripPanelRef[]
): number | null {
  if (layout.slots.length === 0 || timeline.length === 0) return null;
  // Страница в центре окна (как pageIndexAtScroll, но с доступом к слоту).
  const center = scrollY + layout.frameHeight / 2;
  let slot: StripSlot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const s of layout.slots) {
    const d = Math.abs(s.y + s.height / 2 - center);
    if (d < bestDistance) {
      slot = s;
      bestDistance = d;
    }
  }
  if (!slot) return null;
  const imageIndex = slot.index;
  // Вызывается на каждое событие колеса: индекс панелей кэшируется по массиву.
  const byId = panelIndex(panels);
  const segs = timeline
    .filter(t => segImageIndex(t, byId) === imageIndex)
    .sort((a, b) => a.audioStart - b.audioStart);
  if (segs.length === 0) return null;

  // Страница с y-диапазонами: группы реплик по полосе (без диапазона — 0..100).
  const segRanges = segs.map(seg => panelYRange(byId.get(seg.panelId)));
  if (segRanges.some(range => range !== null)) {
    const groupMap = new Map<string, { range: { from: number; to: number }; segs: TimelineSeg[] }>();
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const range = segRanges[i] ?? WHOLE_PAGE;
      const key = `${range.from}:${range.to}`;
      const group = groupMap.get(key);
      if (group) group.segs.push(seg);
      else groupMap.set(key, { range, segs: [seg] });
    }
    const groups = [...groupMap.values()];

    const relPct = ((center - slot.y) / Math.max(1e-6, slot.height)) * 100;
    let best = groups[0];
    let bestKey: [number, number, number] = [Number.POSITIVE_INFINITY, 0, 0];
    for (const g of groups) {
      const inside = relPct >= g.range.from && relPct <= g.range.to;
      // Внутри: [0, ширина, расстояние до центра] — узкая полоса точнее.
      // Снаружи: [1, расстояние до края, 0] — ближайшая по вертикали.
      const key: [number, number, number] = inside
        ? [0, g.range.to - g.range.from, Math.abs(relPct - (g.range.from + g.range.to) / 2)]
        : [1, Math.min(Math.abs(relPct - g.range.from), Math.abs(relPct - g.range.to)), 0];
      const better = key[0] !== bestKey[0]
        ? key[0] < bestKey[0]
        : key[1] !== bestKey[1]
          ? key[1] < bestKey[1] - 1e-9
          : key[2] < bestKey[2] - 1e-9;
      if (better) {
        best = g;
        bestKey = key;
      }
    }

    if (best.segs.length === 1) return best.segs[0].audioStart;
    // Несколько реплик на одной полосе: положение окна внутри диапазона
    // скролла полосы → доля суммарной длительности их озвучки.
    const { startPx, endPx } = rangeScrollPx(layout, slot, best.range);
    const f = endPx > startPx ? Math.min(1, Math.max(0, (scrollY - startPx) / (endPx - startPx))) : 0;
    const total = best.segs.reduce((acc, seg) => acc + Math.max(0, seg.audioEnd - seg.audioStart), 0);
    if (total <= 0) return best.segs[0].audioStart;
    let acc = 0;
    for (const seg of best.segs) {
      acc += Math.max(0, seg.audioEnd - seg.audioStart);
      if (f * total < acc) return seg.audioStart;
    }
    return best.segs[best.segs.length - 1].audioStart;
  }

  const pageStart = segs[0].audioStart;
  const pageEnd = segs[segs.length - 1].audioEnd;
  const top = clampScroll(slot.y, layout);
  const bottom = clampScroll(slot.y + slot.height - layout.frameHeight, layout);
  const targetTime = bottom > top
    ? pageStart + Math.min(1, Math.max(0, (scrollY - top) / (bottom - top))) * (pageEnd - pageStart)
    : pageStart;

  // Снап на границу панели: последняя панель, чей старт не позже targetTime.
  let result = segs[0].audioStart;
  for (const s of segs) {
    if (targetTime >= s.audioStart) result = s.audioStart;
    else break;
  }
  return result;
}

/**
 * Готовая сцена ленты: раскладка + траектория скролла + рендер кадра по времени.
 * Один и тот же объект используется превью и обоими бэкендами экспорта, чтобы
 * картинка в редакторе совпадала с итоговым видео.
 */
export interface StripScene {
  layout: StripLayout;
  keyframes: ScrollKeyframe[];
  scrollAt(time: number): number;
  render(ctx: CanvasRenderingContext2D, time: number, extras?: { showProgress?: boolean; progress?: number }): void;
}

export function createStripScene(params: {
  sizes: Array<{ width: number; height: number }>;
  images: Array<CanvasImageSource | null | undefined>;
  timeline: Array<{ panelId: number; imageIndex?: number; audioStart: number; audioEnd: number }>;
  panels?: StripPanelRef[];
  options: StripSceneOptions;
}): StripScene {
  const { sizes, images, timeline, panels, options } = params;
  const layout = computeStripLayout(sizes, options);
  // Панели с y-bbox получают свой интервал скролла — лента едет по ним.
  const spans = buildStripScrollSpans(timeline, layout, panels);
  const keyframes = buildScrollKeyframes(spans, layout, {
    transition: options.transition ?? STRIP_DEFAULTS.transition,
    panInside: options.panInside,
  });

  return {
    layout,
    keyframes,
    scrollAt: (time: number) => sampleScroll(keyframes, time),
    render: (ctx, time, extras) => {
      const scrollY = sampleScroll(keyframes, time);
      renderStripFrame(ctx, {
        layout,
        images,
        scrollY,
        kenBurnsAmount: options.kenBurnsAmount ?? STRIP_DEFAULTS.kenBurnsAmount,
        highlightSlot: options.highlight ? pageIndexAtScroll(layout, scrollY) : null,
        highlightColor: options.highlightColor,
        showProgress: extras?.showProgress === true,
        progress: extras?.progress,
      });
    },
  };
}

export interface StripMediaOptions {
  /** data-URL'ы или OPFS-ключи страниц (как в options.images бэкендов). */
  images: string[];
  /** Уже загруженные изображения по тому же ключу. */
  loaded: Map<string, HTMLImageElement>;
  timeline: Array<{ panelId: number; imageIndex?: number; audioStart: number; audioEnd: number }>;
  /** Панели с bbox/fullFrame — без bbox лента читает страницы целиком. */
  panels?: StripPanelRef[];
  frameWidth: number;
  frameHeight: number;
  /** Сколько px ленты помещается в кадр (по умолчанию — высота кадра). */
  viewport?: number;
  /** Отступ между страницами, px. */
  gap?: number;
}

/**
 * Единственная точка сборки сцены ленты для превью и обоих бэкендов экспорта.
 * Раньше сборка была продублирована в assembleVideo и videoEncoder — баг в
 * одной ветке не воспроизводился в другой. Теперь параметры и значения по
 * умолчанию (Ken Burns, отсутствие подсветки) заданы здесь.
 */
export function createStripSceneFromMedia(media: StripMediaOptions): StripScene | null {
  if (media.images.length === 0) return null;

  const sizes = media.images.map(src => {
    const img = media.loaded.get(src);
    return { width: img?.naturalWidth || 1000, height: img?.naturalHeight || 1400 };
  });

  return createStripScene({
    sizes,
    images: media.images.map(src => media.loaded.get(src) ?? null),
    timeline: media.timeline,
    panels: media.panels,
    options: {
      frameWidth: media.frameWidth,
      frameHeight: media.frameHeight,
      viewport: resolveStripViewport(media.frameHeight, media.viewport),
      gap: media.gap ?? STRIP_DEFAULTS.gap,
      transition: STRIP_DEFAULTS.transition,
      kenBurnsAmount: STRIP_DEFAULTS.kenBurnsAmount,
      highlight: false,
    },
  });
}
