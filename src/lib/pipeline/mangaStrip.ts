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
  const viewport = Math.max(1, options.viewport ?? frameHeight);
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

  /** Куда окно приходит, когда страница начинает звучать. */
  const entryY = (slotIndex: number): number => {
    const slot = layout.slots[slotIndex];
    if (!slot) return 0;
    // Длинную страницу читаем с верха, короткую — с центра.
    return isLong(slot) && panInside ? clampScroll(slot.y, layout) : targetScrollForSlot(layout, slotIndex);
  };

  /** Где окно оказывается к концу звучания страницы. */
  const exitY = (slotIndex: number): number => {
    const slot = layout.slots[slotIndex];
    if (!slot) return 0;
    const top = clampScroll(slot.y, layout);
    const bottom = clampScroll(slot.y + slot.height - layout.frameHeight, layout);
    return isLong(slot) && panInside && bottom > top ? bottom : targetScrollForSlot(layout, slotIndex);
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
  const entries = ordered.map(span => entryY(span.slotIndex));
  for (let i = 1; i < entries.length; i++) {
    const slot = layout.slots[ordered[i].slotIndex];
    if (!slot) continue;
    const prevExit = exitY(ordered[i - 1].slotIndex);
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

    if (isLong(slot) && panInside) {
      // Страница длиннее кадра: пока звучит озвучка — медленно проезжаем её
      // сверху вниз (вебтун-чтение).
      pushKey(span.start, entries[i], 'linear');
      pushKey(transitionStart, exitY(span.slotIndex), 'linear');
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
      pushKey(span.end, exitY(span.slotIndex), 'linear');
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
  for (const segment of timeline) {
    // imageIndex есть прямо в сегменте таймлайна; panels нужны лишь для старых
    // сегментов без него (или когда панель переехала на другую страницу).
    const imageIndex = typeof segment.imageIndex === 'number'
      ? segment.imageIndex
      : panels?.find(p => p.id === segment.panelId)?.imageIndex;
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

/** Дефолты режима ленты (используются и в UI, и в экспорте). */
export const STRIP_DEFAULTS = {
  viewportRatio: 1, // viewport = frameHeight
  gap: 24,
  transition: 0.8,
  kenBurnsAmount: 0.03,
} as const;

export function resolveStripViewport(frameHeight: number, viewport?: number): number {
  if (!viewport || viewport <= 0) return frameHeight * STRIP_DEFAULTS.viewportRatio;
  return viewport;
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
  panels?: Array<{ id: number; imageIndex: number }>;
  options: StripSceneOptions;
}): StripScene {
  const { sizes, images, timeline, panels, options } = params;
  const layout = computeStripLayout(sizes, options);
  const spans = buildScrollSpans(timeline, panels);
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
  panels?: Array<{ id: number; imageIndex: number }>;
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
