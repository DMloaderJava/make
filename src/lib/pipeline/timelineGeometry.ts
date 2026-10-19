/**
 * Единая геометрия таймлайна, скролл, зум вокруг текущего времени и примагничивание (snap)
 * (Этап 5 п. 41–50; Этап 6 п. 59).
 *
 * Гарантирует, что шкала времени, дорожка Видео, дорожка Аудио и линия Playhead
 * используют одну и ту же систему координат `trackRect`, а клик в любую точку
 * переводится во время с точностью до пикселя.
 */

import type { SyncTimeline } from '../storage/db';

export const TIMELINE_TRACK_OFFSET = 72;
export const TIMELINE_BASE_WIDTH = 960;
export const TIMELINE_MIN_WIDTH = 760;
export const TIMELINE_ZOOM_MIN = 0.75;
export const TIMELINE_ZOOM_MAX = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface TimelineGeometryParams {
  duration: number;
  zoom: number;
  scrollLeft?: number;
  viewportWidth?: number;
  trackOffset?: number;
  baseWidth?: number;
  minWidth?: number;
}

export interface SegmentGeometry {
  leftPx: number;
  widthPx: number;
  rightPx: number;
  leftPercent: number;
  widthPercent: number;
}

export interface TimelineGapSpan {
  from: number;
  to: number;
  duration: number;
  prevPanelId: number;
  nextPanelId: number;
  geometry: SegmentGeometry;
}

export interface TimelineGeometry {
  duration: number;
  safeDuration: number;
  zoom: number;
  trackOffset: number;
  contentWidth: number;
  trackWidth: number;
  scrollLeft: number;
  viewportWidth: number;
  maxScrollLeft: number;
  /** Доля времени [0..1] на шкале [0..safeDuration]. */
  timeToRatio(time: number): number;
  /** Координата X внутри области дорожек [0..trackWidth] (без колонки заголовков). */
  timeToTrackPx(time: number): number;
  /** Координата X внутри общего контента [trackOffset..contentWidth]. */
  timeToContentPx(time: number): number;
  /** Координата X относительно видимого окна скроллера (с учётом scrollLeft). */
  timeToViewportPx(time: number): number;
  /** Обратный перевод X внутри дорожки [0..trackWidth] → время [0..safeDuration]. */
  trackPxToTime(trackX: number): number;
  /** Клик по clientX относительно getBoundingClientRect().left контента (уже включает -scrollLeft). */
  clientXFromContentToTime(clientX: number, contentRectLeft: number): number;
  /** Клик по clientX относительно getBoundingClientRect().left внешнего скроллера + scrollLeft. */
  clientXFromScrollerToTime(clientX: number, scrollerRectLeft: number, scrollLeft?: number): number;
  /** Геометрия сегмента [start..end] одинаковая для Видео и Аудио дорожек. */
  segmentGeometry(start: number, end: number, minWidthPercent?: number): SegmentGeometry;
}

export function computeTimelineGeometry(params: TimelineGeometryParams): TimelineGeometry {
  const trackOffset = params.trackOffset ?? TIMELINE_TRACK_OFFSET;
  const baseWidth = params.baseWidth ?? TIMELINE_BASE_WIDTH;
  const minWidth = params.minWidth ?? TIMELINE_MIN_WIDTH;
  const zoom = clamp(Number.isFinite(params.zoom) ? params.zoom : 1, TIMELINE_ZOOM_MIN, TIMELINE_ZOOM_MAX);
  const safeDuration = Number.isFinite(params.duration) && params.duration > 0 ? params.duration : 1;
  const contentWidth = Math.max(minWidth, Math.round(baseWidth * zoom));
  const trackWidth = Math.max(1, contentWidth - trackOffset);
  const viewportWidth = Math.max(1, params.viewportWidth ?? contentWidth);
  const maxScrollLeft = Math.max(0, contentWidth - viewportWidth);
  const scrollLeft = clamp(params.scrollLeft ?? 0, 0, maxScrollLeft);

  const timeToRatio = (time: number): number => {
    if (!Number.isFinite(time)) return 0;
    return clamp(time, 0, safeDuration) / safeDuration;
  };

  const timeToTrackPx = (time: number): number => {
    return timeToRatio(time) * trackWidth;
  };

  const timeToContentPx = (time: number): number => {
    return trackOffset + timeToTrackPx(time);
  };

  const timeToViewportPx = (time: number): number => {
    return timeToContentPx(time) - scrollLeft;
  };

  const trackPxToTime = (trackX: number): number => {
    if (!Number.isFinite(trackX)) return 0;
    const clampedX = clamp(trackX, 0, trackWidth);
    return (clampedX / trackWidth) * safeDuration;
  };

  const clientXFromContentToTime = (clientX: number, contentRectLeft: number): number => {
    return trackPxToTime(clientX - contentRectLeft - trackOffset);
  };

  const clientXFromScrollerToTime = (clientX: number, scrollerRectLeft: number, customScrollLeft?: number): number => {
    const sl = customScrollLeft !== undefined ? customScrollLeft : scrollLeft;
    return trackPxToTime(clientX - scrollerRectLeft + sl - trackOffset);
  };

  const segmentGeometry = (start: number, end: number, minWidthPercent = 0): SegmentGeometry => {
    const s = clamp(start, 0, safeDuration);
    const e = clamp(Math.max(s, end), 0, safeDuration);
    const leftRatio = s / safeDuration;
    const rawWidthRatio = (e - s) / safeDuration;
    const leftPx = leftRatio * trackWidth;
    const widthPx = Math.max(minWidthPercent > 0 ? (minWidthPercent / 100) * trackWidth : 0, rawWidthRatio * trackWidth);
    return {
      leftPx,
      widthPx,
      rightPx: leftPx + widthPx,
      leftPercent: leftRatio * 100,
      widthPercent: Math.max(minWidthPercent, rawWidthRatio * 100),
    };
  };

  return {
    duration: params.duration,
    safeDuration,
    zoom,
    trackOffset,
    contentWidth,
    trackWidth,
    scrollLeft,
    viewportWidth,
    maxScrollLeft,
    timeToRatio,
    timeToTrackPx,
    timeToContentPx,
    timeToViewportPx,
    trackPxToTime,
    clientXFromContentToTime,
    clientXFromScrollerToTime,
    segmentGeometry,
  };
}

/**
 * Вычисляет новый `scrollLeft` при изменении масштаба (zoom) вокруг `anchorTime` (обычно `currentTime`)
 * (Этап 5 п. 44, 45). Не сбрасывает скролл в начало!
 */
export function computeZoomAroundTime(params: {
  anchorTime: number;
  duration: number;
  oldZoom: number;
  newZoom: number;
  oldScrollLeft: number;
  viewportWidth: number;
  trackOffset?: number;
  centerAnchor?: boolean;
}): { zoom: number; scrollLeft: number; playheadContentPx: number } {
  const oldGeom = computeTimelineGeometry({
    duration: params.duration,
    zoom: params.oldZoom,
    scrollLeft: params.oldScrollLeft,
    viewportWidth: params.viewportWidth,
    trackOffset: params.trackOffset,
  });
  const newGeom = computeTimelineGeometry({
    duration: params.duration,
    zoom: params.newZoom,
    scrollLeft: 0,
    viewportWidth: params.viewportWidth,
    trackOffset: params.trackOffset,
  });

  const playheadNewContentPx = newGeom.timeToContentPx(params.anchorTime);

  let targetScrollLeft: number;
  if (params.centerAnchor) {
    targetScrollLeft = playheadNewContentPx - params.viewportWidth / 2;
  } else {
    // Сохраняем экранную позицию точки anchorTime внутри видимого окна (или центрируем, если она была за экраном)
    const oldViewportOffset = oldGeom.timeToViewportPx(params.anchorTime);
    const wasVisible = oldViewportOffset >= oldGeom.trackOffset && oldViewportOffset <= params.viewportWidth;
    const desiredOffset = wasVisible ? oldViewportOffset : params.viewportWidth / 2;
    targetScrollLeft = playheadNewContentPx - desiredOffset;
  }

  // P1 п. 12: не округляем scrollLeft, чтобы при зум-цикле не накапливалась погрешность
  const clampedScrollLeft = clamp(targetScrollLeft, 0, newGeom.maxScrollLeft);
  return {
    zoom: newGeom.zoom,
    scrollLeft: clampedScrollLeft,
    playheadContentPx: playheadNewContentPx,
  };
}

/**
 * Автоматическая прокрутка горизонтального контейнера за playhead при воспроизведении (Этап 5 п. 43, P1 п. 13).
 * При выходе за правую/левую границу плавно интерполирует scrollLeft: `scrollLeft += (target - scrollLeft) * 0.2`.
 */
export function computeAutoFollowScrollLeft(params: {
  currentTime: number;
  duration: number;
  zoom: number;
  scrollLeft: number;
  viewportWidth: number;
  trackOffset?: number;
  rightMarginPx?: number;
  smoothing?: number;
}): number {
  const geom = computeTimelineGeometry(params);
  if (geom.maxScrollLeft <= 0) return 0;

  const alpha = params.smoothing !== undefined ? clamp(params.smoothing, 0.01, 1) : 0.2;
  const margin = params.rightMarginPx ?? 64;
  const playheadContentX = geom.timeToContentPx(params.currentTime);
  const visibleLeft = geom.scrollLeft + geom.trackOffset;
  const visibleRight = geom.scrollLeft + geom.viewportWidth - margin;

  if (playheadContentX > visibleRight) {
    const target = clamp(
      playheadContentX - geom.trackOffset - Math.max(48, (geom.viewportWidth - geom.trackOffset) * 0.25),
      0,
      geom.maxScrollLeft
    );
    const smoothed = geom.scrollLeft + (target - geom.scrollLeft) * alpha;
    return clamp(smoothed, 0, geom.maxScrollLeft);
  }
  if (playheadContentX < visibleLeft) {
    const target = clamp(playheadContentX - geom.trackOffset - 24, 0, geom.maxScrollLeft);
    const smoothed = geom.scrollLeft + (target - geom.scrollLeft) * alpha;
    return clamp(smoothed, 0, geom.maxScrollLeft);
  }
  return geom.scrollLeft;
}

/**
 * Вычисляет блоки пауз (gap) между сегментами таймлайна для визуализации (Этап 5 п. 48).
 */
export function computeTimelineGaps(
  timeline: readonly SyncTimeline[],
  geometry: TimelineGeometry
): TimelineGapSpan[] {
  const gaps: TimelineGapSpan[] = [];
  for (let i = 0; i < timeline.length - 1; i++) {
    const prev = timeline[i];
    const next = timeline[i + 1];
    const gapDuration = next.audioStart - prev.audioEnd;
    if (gapDuration > 1e-3) {
      gaps.push({
        from: prev.audioEnd,
        to: next.audioStart,
        duration: gapDuration,
        prevPanelId: prev.panelId,
        nextPanelId: next.panelId,
        geometry: geometry.segmentGeometry(prev.audioEnd, next.audioStart),
      });
    }
  }
  return gaps;
}

/**
 * Вычисляет согласованные интервалы интро и аутро для обеих дорожек (Этап 5 п. 49).
 */
export function computeIntroOutroSegments(
  timeline: readonly SyncTimeline[],
  introDuration: number,
  outroDuration: number,
  geometry: TimelineGeometry
): {
  intro: { start: number; end: number; geometry: SegmentGeometry };
  outro: { start: number; end: number; geometry: SegmentGeometry };
} {
  const safeIntro = Math.max(0, Number.isFinite(introDuration) ? introDuration : 0);
  const safeOutro = Math.max(0, Number.isFinite(outroDuration) ? outroDuration : 0);
  const outroStart = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : safeIntro;
  const outroEnd = outroStart + safeOutro;

  return {
    intro: {
      start: 0,
      end: safeIntro,
      geometry: geometry.segmentGeometry(0, safeIntro, safeIntro > 0 ? 1.5 : 0),
    },
    outro: {
      start: outroStart,
      end: outroEnd,
      geometry: geometry.segmentGeometry(outroStart, outroEnd, safeOutro > 0 ? 1.5 : 0),
    },
  };
}

/**
 * Примагничивание (snap) времени к границам `audioStart`, `audioEnd`, сменам изображений,
 * `0`, `introDuration` и `duration` (Этап 6 п. 59).
 */
export interface SnapTarget {
  time: number;
  kind: 'zero' | 'intro-end' | 'audio-start' | 'audio-end' | 'image-boundary' | 'outro-end';
  panelId?: number;
  imageIndex?: number;
}

export function collectSnapTargets(
  timeline: readonly SyncTimeline[],
  introDuration: number,
  totalDuration: number
): SnapTarget[] {
  const targets: SnapTarget[] = [{ time: 0, kind: 'zero' }];
  if (introDuration > 0) {
    targets.push({ time: introDuration, kind: 'intro-end' });
  }
  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    const prev = timeline[i - 1];
    const isImageBoundary = !prev || prev.imageIndex !== seg.imageIndex;
    targets.push({
      time: seg.audioStart,
      kind: isImageBoundary ? 'image-boundary' : 'audio-start',
      panelId: seg.panelId,
      imageIndex: seg.imageIndex,
    });
    targets.push({
      time: seg.audioEnd,
      kind: 'audio-end',
      panelId: seg.panelId,
      imageIndex: seg.imageIndex,
    });
  }
  if (totalDuration > 0) {
    targets.push({ time: totalDuration, kind: 'outro-end' });
  }
  return targets;
}

export function snapTimeToTargets(
  time: number,
  targets: readonly SnapTarget[],
  toleranceSec: number = 0.15
): { time: number; snapped: boolean; target: SnapTarget | null } {
  let best: SnapTarget | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const t of targets) {
    const dist = Math.abs(t.time - time);
    if (dist <= toleranceSec && dist < bestDist) {
      best = t;
      bestDist = dist;
    }
  }
  if (best) {
    return { time: best.time, snapped: true, target: best };
  }
  return { time, snapped: false, target: null };
}
