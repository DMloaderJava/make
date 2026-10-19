/**
 * Единая чистая функция расчёта камеры и кадра (`sampleCameraFrame`) для Preview и видеокодеров,
 * а также утилиты навигации по страницам, диагностики ресурсов слота и дедупликации Canvas-кадров
 * (Этап 7, пункты 61–70; Этап 9, пункт 81; Итерация 2.2 Б-2.1, Б-2.2).
 *
 * Инвариант текстовых слоёв Preview = Export (Б-2.1, Б-2.2):
 * - В фазах `'intro'` и `'outro'` и в режиме `'panels'`, и в режиме `'strip'` используется
 *   единый слой `drawIntroOverlay` / `drawOutroOverlay` (из `./overlayText`).
 * - В режиме `'strip'` для фаз `'panel' | 'gap'` плашка `drawDialogue` отключена и в Preview,
 *   и в Export («чистый вебтун без плашек»).
 */

import type { PanelData, SyncTimeline } from '../storage/db';
import {
  DEFAULT_INTRO_OVERLAY_TEXT,
  DEFAULT_OUTRO_OVERLAY_TEXT,
  drawDialogue,
  drawIntroOverlay,
  drawOutroOverlay,
  wrapOverlayText,
} from './overlayText';

export {
  DEFAULT_INTRO_OVERLAY_TEXT,
  DEFAULT_OUTRO_OVERLAY_TEXT,
  drawDialogue,
  drawIntroOverlay,
  drawOutroOverlay,
  wrapOverlayText,
};
import {
  clampScroll,
  sampleScroll,
  scrollDirectionAt,
  type ScrollKeyframe,
  type StripScene,
} from './mangaStrip';
import { resolveActiveTimelineMoment, type ActiveTimelineMoment } from './projectClock';
import { yRangeFromBbox } from './yRange';

export interface StripCameraContext {
  scene?: StripScene | null;
  keyframes?: ScrollKeyframe[];
}

export interface CameraFrameSample {
  time: number;
  phase: 'intro' | 'panel' | 'gap' | 'outro';
  renderMode: 'panels' | 'strip';
  activePanelId: number | null;
  activeImageIndex: number | null;
  activePanelIndex: number;
  activeClipId: string | null;
  /** Прогресс внутри активного сегмента (0..1). */
  panelProgress: number;
  /** Синоним panelProgress для совместимости. */
  segmentProgress: number;
  /** Вертикальный диапазон активной панели в процентах [from, to] (0..100). */
  yRange: [number, number];
  /** Положение камеры по Y в пикселях ленты (для режима 'strip'). */
  stripScrollY: number;
  /** Направление движения ленты ('down' | 'idle' | 'up') (Этап 7 п. 64). */
  stripScrollDirection: 'down' | 'idle' | 'up';
  /** Режим движения камеры ('drift' | 'hold' | 'pan') (Задача 11). */
  cameraMotion: 'drift' | 'hold' | 'pan';
  /** Разрешённый момент таймлайна. */
  moment: ActiveTimelineMoment;
  /** Отображаемая панель. */
  displayPanel: PanelData | null;
  /** Линейное ли движение камеры в этот момент (внутри реплики — да, на паузе/смене страницы — удержание, Этап 7 п. 68). */
  isLinearPass: boolean;
  /** Подпись кадра для дедупликации перерисовки Canvas в requestAnimationFrame (Этап 7 п. 69). */
  frameSignature: string;
}

/**
 * Вычисляет параметры камеры и кадра в момент времени `time` (Этап 9 п. 81; Итерация 2 Задачи 8, 11).
 * Используется и в интерактивном Preview, и во всех путях экспорта видео,
 * гарантируя совпадение траектории камеры.
 */
export function sampleCameraFrame(params: {
  time: number;
  renderMode: 'panels' | 'strip';
  panels: readonly PanelData[];
  timeline: readonly SyncTimeline[];
  introDuration: number;
  outroDuration: number;
  introAudioDuration?: number | null;
  outroAudioDuration?: number | null;
  strip?: StripCameraContext | null;
  stripScene?: StripScene | null;
  viewportWidth?: number;
  viewportHeight?: number;
  debugOverlay?: boolean;
}): CameraFrameSample {
  const {
    time,
    renderMode,
    panels,
    timeline,
    introDuration,
    outroDuration,
    introAudioDuration,
    outroAudioDuration,
    strip,
    stripScene,
    viewportWidth = 0,
    viewportHeight = 0,
    debugOverlay = false,
  } = params;

  const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);
  const moment = resolveActiveTimelineMoment(
    timeline,
    panels,
    safeTime,
    introDuration,
    outroDuration
  );
  const panelById = new Map<number, PanelData>(panels.map(p => [p.id, p]));
  const activePanel =
    moment.activePanelId !== null
      ? panelById.get(moment.activePanelId) ?? null
      : moment.displaySegment
        ? panelById.get(moment.displaySegment.panelId) ?? null
        : panels[0] ?? null;

  const rangeObj = activePanel ? yRangeFromBbox(activePanel.bbox, activePanel.fullFrame) : null;
  const yRange: [number, number] = rangeObj ? [rangeObj.from, rangeObj.to] : [0, 100];

  const scene = stripScene ?? strip?.scene ?? null;
  const keyframes = scene?.keyframes ?? strip?.keyframes;

  const hasIntroAudio =
    typeof introAudioDuration === 'number' &&
    Number.isFinite(introAudioDuration) &&
    introAudioDuration > 0 &&
    introDuration > 0;
  const hasOutroAudio =
    typeof outroAudioDuration === 'number' &&
    Number.isFinite(outroAudioDuration) &&
    outroAudioDuration > 0 &&
    outroDuration > 0;

  // На правой границе интро (t === introDuration) при наличии introAudioDuration > 0
  // фиксируем точку завершения интро-проезда (Задача 11, Тест 2 и 3).
  const isAtIntroEndWithAudio =
    hasIntroAudio &&
    safeTime > 0 &&
    Math.abs(safeTime - introDuration) <= 1e-6;

  let panelProgress = 0;
  let stripScrollY = 0;
  let stripScrollDirection: 'down' | 'idle' | 'up' = 'idle';
  let cameraMotion: 'drift' | 'hold' | 'pan' = 'hold';
  let isLinearPass = false;

  if (moment.phase === 'intro' || isAtIntroEndWithAudio) {
    const slot0 = scene?.layout.slots[0];
    const slot0Top = slot0 && scene ? clampScroll(slot0.y, scene.layout) : 0;
    const slot0MaxY =
      slot0 && scene
        ? clampScroll(slot0.y + Math.max(0, slot0.height - scene.layout.frameHeight), scene.layout)
        : keyframes && keyframes.length > 0
          ? Math.max(...keyframes.map(k => k.y))
          : 1000;

    if (hasIntroAudio) {
      cameraMotion = 'drift';
      const activeWindow = Math.min(introDuration, introAudioDuration!);
      const driftProgress = activeWindow > 1e-6 ? Math.min(1, Math.max(0, safeTime / activeWindow)) : 1;
      panelProgress = driftProgress;
      stripScrollY = slot0Top + driftProgress * (slot0MaxY - slot0Top);
      stripScrollDirection = safeTime < activeWindow - 1e-4 && slot0MaxY > slot0Top + 0.5 ? 'down' : 'idle';
      isLinearPass = safeTime <= activeWindow + 1e-4;
    } else {
      cameraMotion = 'hold';
      panelProgress = 0;
      stripScrollY = 0;
      stripScrollDirection = 'idle';
      isLinearPass = false;
    }
  } else if (moment.phase === 'outro') {
    const lastEnd = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : Math.max(0, introDuration);
    const outroElapsed = Math.max(0, safeTime - lastEnd);
    const slots = scene?.layout.slots ?? [];
    const slotLast = slots.length > 0 ? slots[slots.length - 1] : undefined;
    const slotLastTop = slotLast && scene ? clampScroll(slotLast.y, scene.layout) : 0;
    const slotLastMaxY =
      slotLast && scene
        ? clampScroll(slotLast.y + Math.max(0, slotLast.height - scene.layout.frameHeight), scene.layout)
        : keyframes && keyframes.length > 0
          ? keyframes[keyframes.length - 1].y
          : 1000;

    if (hasOutroAudio) {
      cameraMotion = 'drift';
      const activeWindow = Math.min(outroDuration, outroAudioDuration!);
      const driftProgress = activeWindow > 1e-6 ? Math.min(1, Math.max(0, outroElapsed / activeWindow)) : 1;
      panelProgress = driftProgress;
      stripScrollY = slotLastTop + driftProgress * (slotLastMaxY - slotLastTop);
      stripScrollDirection = outroElapsed < activeWindow - 1e-4 && slotLastMaxY > slotLastTop + 0.5 ? 'down' : 'idle';
      isLinearPass = outroElapsed <= activeWindow + 1e-4;
    } else {
      cameraMotion = 'hold';
      panelProgress = 1;
      stripScrollY = scene ? scene.scrollAt(lastEnd) : keyframes ? sampleScroll(keyframes, lastEnd) : 0;
      stripScrollDirection = 'idle';
      isLinearPass = false;
    }
  } else {
    const activeSeg = moment.activeSegment ?? moment.displaySegment;
    const segDur = activeSeg ? Math.max(1e-6, activeSeg.audioEnd - activeSeg.audioStart) : 1;
    const isFullFramePanel = activePanel?.fullFrame === true;
    const isPostLastHold = moment.phase === 'panel' && moment.activeSegment === null;

    if (isFullFramePanel) {
      // P1 п. 13: для fullFrame-панели камера стоит (contain), panelProgress = 0
      panelProgress = 0;
    } else if (isPostLastHold || moment.phase === 'gap') {
      panelProgress = 1;
    } else if (moment.phase === 'panel' && activeSeg) {
      panelProgress = Math.max(0, Math.min(1, (safeTime - activeSeg.audioStart) / segDur));
    } else {
      panelProgress = 0;
    }

    if (keyframes && keyframes.length > 0) {
      stripScrollY = scene ? scene.scrollAt(safeTime) : sampleScroll(keyframes, safeTime);
      stripScrollDirection =
        moment.phase === 'gap' || isPostLastHold ? 'idle' : scrollDirectionAt(keyframes, safeTime);
    }
    if (moment.phase === 'gap' || isPostLastHold || (renderMode === 'panels' && isFullFramePanel)) {
      cameraMotion = 'hold';
      isLinearPass = false;
    } else {
      cameraMotion = stripScrollDirection !== 'idle' || renderMode === 'panels' ? 'pan' : 'hold';
      isLinearPass = moment.phase === 'panel';
    }
  }

  const activeSeg = moment.activeSegment ?? moment.displaySegment;
  const activeImageIndex = activePanel?.imageIndex ?? activeSeg?.imageIndex ?? null;
  const roundedScroll = Math.round(stripScrollY * 100) / 100;
  const roundedProgress = Math.round(panelProgress * 1000) / 1000;
  const layoutSig = scene ? `${scene.layout.viewport}:${scene.layout.gap}` : 'nostrip';
  const frameSignature = [
    renderMode,
    layoutSig,
    moment.phase,
    cameraMotion,
    moment.activePanelId ?? 'none',
    activeImageIndex ?? 'none',
    renderMode === 'strip' ? roundedScroll : roundedProgress,
    yRange[0],
    yRange[1],
    viewportWidth,
    viewportHeight,
    debugOverlay ? 'dbg' : 'std',
  ].join('|');

  return {
    time: safeTime,
    phase: moment.phase,
    renderMode,
    activePanelId: moment.activePanelId,
    activeImageIndex,
    activePanelIndex: moment.activePanelIndex,
    activeClipId: moment.activeClipId,
    panelProgress,
    segmentProgress: panelProgress,
    yRange,
    stripScrollY,
    stripScrollDirection,
    cameraMotion,
    moment,
    displayPanel: activePanel,
    isLinearPass,
    frameSignature,
  };
}

/**
 * Прямоугольник отрисовки `ctx.drawImage(img, ox, oy, dw, dh)` для режима `panels`
 * по Правилу 0 (`yRange` + `panelProgress`).
 */
export interface PanelCameraDrawRect {
  ox: number;
  oy: number;
  dw: number;
  dh: number;
}

/**
 * Вычисляет гео-прямоугольник отрисовки для режима `panels` по `yRange` и `panelProgress`
 * (Итерация 2.1, Б1: побитовое совпадение Preview и Export в режиме `panels`).
 */
export function computePanelCameraDrawRect(params: {
  imgWidth: number;
  imgHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  yRange: [number, number];
  progress: number;
}): PanelCameraDrawRect {
  const { imgWidth, imgHeight, canvasWidth: w, canvasHeight: h, yRange, progress } = params;
  const safeImgW = Math.max(1, imgWidth);
  const safeImgH = Math.max(1, imgHeight);
  const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const fromPct = Math.max(0, Math.min(100, yRange[0] ?? 0));
  const toPct = Math.max(fromPct, Math.min(100, yRange[1] ?? 100));

  // Масштабируем по ширине с гарантией вертикального запаса (cover + проезд по полосе yRange)
  const baseScale = Math.max(w / safeImgW, (h * 1.2) / safeImgH);
  const dw = safeImgW * baseScale;
  const dh = safeImgH * baseScale;
  const maxScrollY = Math.max(0, dh - h);

  const startScrollY = (fromPct / 100) * maxScrollY;
  const endScrollY = (toPct / 100) * maxScrollY;
  const scrollY = startScrollY + p * (endScrollY - startScrollY);

  const ox = (w - dw) / 2;
  const oy = -Math.max(0, Math.min(maxScrollY, scrollY));
  return { ox, oy, dw, dh };
}

/**
 * Рисует панель в режиме `panels` по `sample.yRange` и `sample.panelProgress`
 * одинаково в `Preview.tsx` и `assembleVideo.ts` (`renderPanel`).
 */
export function drawPanelWithCamera(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource & { width: number; height: number },
  w: number,
  h: number,
  yRange: [number, number],
  progress: number
): PanelCameraDrawRect {
  const rect = computePanelCameraDrawRect({
    imgWidth: img.width || w,
    imgHeight: img.height || h,
    canvasWidth: w,
    canvasHeight: h,
    yRange,
    progress,
  });
  ctx.drawImage(img, rect.ox, rect.oy, rect.dw, rect.dh);
  return rect;
}

/**
 * Находит первый сегмент таймлайна, привязанный к указанной странице `imageIndex`,
 * и возвращает его `panelId` и время `seekTime` для перехода по клику на миниатюру страницы
 * (Этап 7, пункт 67).
 */
export function resolveFirstSegmentForPage(
  imageIndex: number,
  panels: readonly PanelData[],
  timeline: readonly SyncTimeline[]
): { panelId: number; seekTime: number } | null {
  const sortedPanels = [...panels].sort((a, b) => a.order - b.order || a.id - b.id);
  const matchingPanels = sortedPanels.filter(p => p.imageIndex === imageIndex);
  if (matchingPanels.length === 0) return null;

  const matchingIds = new Set(matchingPanels.map(p => p.id));
  const seg = timeline.find(s => matchingIds.has(s.panelId));
  if (seg) {
    return { panelId: seg.panelId, seekTime: seg.audioStart };
  }

  return { panelId: matchingPanels[0].id, seekTime: 0 };
}

export interface SlotResourceDiagnostics {
  hasImage: boolean;
  hasAudio: boolean;
  missingImageMessage: string | null;
  missingAudioMessage: string | null;
}

/**
 * Отдельная диагностика отсутствующего изображения и отсутствующего аудио для активного слота
 * (Этап 7, пункт 70).
 */
export function diagnoseSlotResources(params: {
  panel: PanelData | null;
  hasImageResource: boolean;
  hasAudioResource: boolean;
}): SlotResourceDiagnostics {
  const { panel, hasImageResource, hasAudioResource } = params;
  if (!panel) {
    return {
      hasImage: true,
      hasAudio: true,
      missingImageMessage: null,
      missingAudioMessage: null,
    };
  }

  const pageNum = panel.imageIndex + 1;
  const hasDialogue = Boolean((panel.dialogue || '').trim());

  const missingImageMessage = !hasImageResource
    ? `Отсутствует изображение страницы №${pageNum} (для панели #${panel.id}). Проверьте хранилище изображений.`
    : null;

  const missingAudioMessage =
    hasDialogue && !hasAudioResource
      ? `Отсутствует озвучка панели #${panel.id} («${panel.character || 'Персонаж'}»). Озвучьте панель через TTS или импортируйте аудио.`
      : null;

  return {
    hasImage: hasImageResource,
    hasAudio: !hasDialogue || hasAudioResource,
    missingImageMessage,
    missingAudioMessage,
  };
}

/**
 * Дедупликатор отрисовки Canvas по подписи кадра (`frameSignature`) (Этап 7 п. 69):
 * пропускает лишние вызовы `draw`, если состояние кадра не изменилось.
 */
export class CanvasFrameDeduplicator {
  private lastSignature: string | null = null;
  private drawnCount = 0;
  private skippedCount = 0;

  shouldDraw(signature: string): boolean {
    if (this.lastSignature === signature) {
      this.skippedCount += 1;
      return false;
    }
    this.lastSignature = signature;
    this.drawnCount += 1;
    return true;
  }

  invalidate(): void {
    this.lastSignature = null;
  }

  getStats(): { drawn: number; skipped: number } {
    return { drawn: this.drawnCount, skipped: this.skippedCount };
  }
}
