"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PanelData } from '@/lib/pipeline/extractPanels';
import { drawContain } from '@/lib/pipeline/draw';
import type { SyncTimeline } from '@/lib/storage/db';
import {
  STRIP_DEFAULTS,
  clampScroll,
  createStripSceneFromMedia,
  maxScrollY,
  resolveStripViewport,
  type StripScene,
} from '@/lib/pipeline/mangaStrip';
import {
  CanvasFrameDeduplicator,
  diagnoseSlotResources,
  drawDialogue,
  drawIntroOverlay,
  drawOutroOverlay,
  drawPanelWithCamera,
  resolveFirstSegmentForPage,
  sampleCameraFrame,
  type CameraFrameSample,
} from '@/lib/pipeline/cameraSampler';
import type { ProjectClock } from '@/lib/pipeline/projectClock';
import { renderExportFrameToCanvas } from '@/lib/pipeline/assembleVideo';
import { yRangeFromBbox } from '@/lib/pipeline/yRange';
import { isImageDrawable, loadImageElement } from '@/lib/pipeline/loadImage';

export interface PreviewFrameRenderParams {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  time: number;
  renderMode: 'panels' | 'strip';
  images: string[];
  loadedImages: Map<string, HTMLImageElement>;
  panels: PanelData[];
  timeline: SyncTimeline[];
  introText?: string;
  outroText?: string;
  introDuration?: number;
  outroDuration?: number;
  introAudioDuration?: number | null;
  outroAudioDuration?: number | null;
  duration?: number;
  stripScene?: StripScene | null;
  debugOverlay?: boolean;
  fallbackPanel?: PanelData | null;
  showProgressBar?: boolean;
}

/**
 * Единая чистая функция отрисовки кадра Preview на Canvas (Итерация 2.2, Б-2.1 и Б-2.2):
 * - В режиме `'panels'`:
 *   - `phase === 'intro'` → `drawPanelWithCamera` + `drawIntroOverlay(introText)` (НЕ `drawDialogue`);
 *   - `phase === 'outro'` → `drawPanelWithCamera` + `drawOutroOverlay(outroText)` (НЕ `drawDialogue`);
 *   - `phase === 'panel' | 'gap'` → `drawPanelWithCamera` + `drawDialogue(dialogue, character, true)`.
 * - В режиме `'strip'`:
 *   - `stripScene.render` + на `'intro' | 'outro'` те же `drawIntroOverlay` / `drawOutroOverlay`;
 *   - на `'panel' | 'gap'` плашка `drawDialogue` отключена (Б-2.2: чистый вебтун без плашек, полное совпадение с Export).
 */
/**
 * Вычисляет строковый ключ-селектор состояния шапки `Preview` для `useSyncExternalStore`
 * (Задача 3.1.3 / Н-3.3: `{ phase, activePanelId, activeImageIndex, stripScrollDirection, yRange }`).
 */
export function computePreviewHeaderSelectorKey(sample: CameraFrameSample): string {
  return `${sample.phase}|${sample.activePanelId ?? 'none'}|${sample.activeImageIndex ?? 'none'}|${sample.stripScrollDirection}|${Math.round(
    sample.yRange[0]
  )}:${Math.round(sample.yRange[1])}`;
}

export function drawPreviewFrameToCanvas(params: PreviewFrameRenderParams): CameraFrameSample {
  const {
    ctx,
    width: w,
    height: h,
    time: frameTime,
    renderMode,
    images,
    loadedImages,
    panels,
    timeline,
    introText = '',
    outroText = '',
    introDuration = 0,
    outroDuration = 0,
    introAudioDuration = null,
    outroAudioDuration = null,
    duration = 0,
    stripScene = null,
    debugOverlay = false,
    fallbackPanel = null,
    showProgressBar = true,
  } = params;

  const sample = sampleCameraFrame({
    time: frameTime,
    renderMode,
    panels,
    timeline,
    introDuration,
    outroDuration,
    introAudioDuration,
    outroAudioDuration,
    stripScene,
    viewportWidth: w,
    viewportHeight: h,
    debugOverlay,
  });

  // --- Режим ленты: вертикальный скролл через sample.stripScrollY (Задача 8; Итерация 2.2 Б-2.1, Б-2.2) ---
  if (renderMode === 'strip' && stripScene) {
    const scrollY = sample.stripScrollY;
    const maxScroll = maxScrollY(stripScene.layout);
    stripScene.render(ctx, frameTime, {
      scrollY,
      showProgress: showProgressBar,
      progress:
        maxScroll > 0
          ? scrollY / maxScroll
          : duration > 0 && isFinite(duration)
            ? frameTime / duration
            : 0,
    });
    // Б-2.1: на интро/аутро поверх ленты рисуется тот же оверлей текста, что и в экспорте.
    // Б-2.2: на panel/gap плашка drawDialogue не рисуется (чистый вебтун без плашек).
    if (sample.phase === 'intro') {
      drawIntroOverlay(ctx, w, h, introText);
    } else if (sample.phase === 'outro') {
      drawOutroOverlay(ctx, w, h, outroText);
    }
    return sample;
  }

  const currentPanel = sample.displayPanel ?? fallbackPanel ?? panels[0] ?? null;

  if (!currentPanel && sample.phase !== 'intro' && sample.phase !== 'outro') {
    ctx.fillStyle = '#0B0B0C';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8A8A93';
    ctx.font = '14px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('Нет панелей', w / 2, h / 2);
    return sample;
  }

  const imgIdx =
    currentPanel?.imageIndex ??
    sample.moment.displaySegment?.imageIndex ??
    (sample.phase === 'outro' ? Math.max(0, images.length - 1) : 0);
  const imgUrl = images[imgIdx];
  const img = imgUrl ? loadedImages.get(imgUrl) : undefined;

  ctx.fillStyle = '#0B0B0C';
  ctx.fillRect(0, 0, w, h);

  if (img) {
    if (currentPanel?.fullFrame) {
      drawContain(ctx, img, w, h);
    } else {
      const progress =
        (sample.phase === 'intro' || sample.phase === 'outro') && sample.cameraMotion === 'hold'
          ? 0
          : sample.panelProgress;
      drawPanelWithCamera(ctx, img, w, h, sample.yRange, progress);
    }
  }

  ctx.fillStyle = 'rgba(11,11,12,0.25)';
  ctx.fillRect(0, 0, w, h);

  // Б-2.1: в режиме panels на intro рисуем introText, на outro — outroText, на panel/gap — drawDialogue
  if (sample.phase === 'intro') {
    drawIntroOverlay(ctx, w, h, introText);
  } else if (sample.phase === 'outro') {
    drawOutroOverlay(ctx, w, h, outroText);
  } else if (currentPanel) {
    // Вспомогательные рамки bbox и подписи процентов — только при включённом debugOverlay (Этап 7 п. 63)
    if (debugOverlay && !currentPanel.fullFrame) {
      const bbox = currentPanel.bbox;
      const bx = (bbox.x / 100) * w;
      const by = (bbox.y / 100) * h;
      const bw = (bbox.width / 100) * w;
      const bh = (bbox.height / 100) * h;
      const range = yRangeFromBbox(bbox, currentPanel.fullFrame);
      const rangeTag = range ? ` [${Math.round(range.from)}..${Math.round(range.to)}%]` : '';
      const label = `${currentPanel.character || `Панель #${currentPanel.id}`}${rangeTag}`;

      ctx.strokeStyle = '#E8B44C';
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6);
      else ctx.rect(bx, by, bw, bh);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.font = '12px Inter';
      const tagW = Math.min(240, ctx.measureText(label).width + 20);
      ctx.fillStyle = '#16161A';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, Math.max(4, by - 22), tagW, 18, 20);
      else ctx.rect(bx, Math.max(4, by - 22), tagW, 18);
      ctx.fill();
      ctx.fillStyle = '#F5F5F7';
      ctx.textAlign = 'left';
      ctx.fillText(label, bx + 10, Math.max(4, by - 22) + 12);
    }

    drawDialogue(ctx, w, h, currentPanel.dialogue, currentPanel.character, true);
  }

  if (showProgressBar && duration > 0 && isFinite(duration)) {
    const pw = (frameTime / duration) * w;
    ctx.fillStyle = '#E8B44C';
    ctx.fillRect(0, h - 2, Math.max(0, Math.min(w, pw)), 2);
  }

  return sample;
}

interface PreviewProps {
  images: string[];
  panels: PanelData[];
  currentPanelIndex: number;
  timeline: SyncTimeline[];
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  /** Единый генератор времени (Задача 1): Preview подписывается на clock и читает clock.getTime() в rAF. */
  clock?: ProjectClock;
  /** Режим рендера проекта: постранично или вертикальная лента. */
  renderMode?: 'panels' | 'strip';
  /** Высота видимой части ленты в px кадра 1080 (по умолчанию — сам кадр). */
  stripViewport?: number;
  /** Отступ между страницами ленты, px кадра 1080. */
  stripGap?: number;
  /** Ручной скролл ленты: seek к панели, к которой приехал скролл. */
  onSeek?: (time: number) => void;
  /** Выбор панели (при клике по миниатюре страницы или кнопке «К активному клипу», Этап 7 п. 65, 67). */
  onSelectPanel?: (panelId: number) => void;
  /** ID выбранной панели на таймлайне/инспекторе для двусторонней визуальной подсветки клипов изображения и аудио (Этап 7 п. 62). */
  selectedPanelId?: number | null;
  /** ID озвученных панелей для раздельной диагностики отсутствия картинки vs аудио (Этап 7 п. 70). */
  audioPanelIds?: number[] | Set<number>;
  /** Текст интро проекта для отображения на фазе 'intro' (Итерация 2.2 Б-2.1). */
  introText?: string;
  /** Текст аутро проекта для отображения на фазе 'outro' (Итерация 2.2 Б-2.1). */
  outroText?: string;
  introDuration?: number;
  outroDuration?: number;
  introAudioDuration?: number | null;
  outroAudioDuration?: number | null;
  /** Сохраняемый флаг debugOverlay из settings проекта (P1 п. 10). */
  debugOverlay?: boolean;
  onToggleDebugOverlay?: (next: boolean) => void;
}

const FRAME_W = 1280;
const FRAME_H = 720;
/** Высота кадра, в координатах которого хранятся настройки ленты (экспорт 1920×1080). */
const EXPORT_FRAME_H = 1080;

export function Preview({
  images,
  panels,
  currentPanelIndex,
  timeline,
  currentTime,
  duration,
  isPlaying,
  onPlayPause,
  clock,
  renderMode = 'panels',
  stripViewport,
  stripGap,
  onSeek,
  onSelectPanel,
  selectedPanelId = null,
  audioPanelIds,
  introText = '',
  outroText = '',
  introDuration = 0,
  outroDuration = 0,
  introAudioDuration = null,
  outroAudioDuration = null,
  debugOverlay: debugOverlayProp,
  onToggleDebugOverlay,
}: PreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<Map<string, HTMLImageElement>>(new Map());
  /** Вспомогательные рамки bbox и подписи процентов отображаются только в debugOverlay (Этап 7 п. 63, P1 п. 10). */
  const [localDebugOverlay, setLocalDebugOverlay] = useState(false);
  const debugOverlay = debugOverlayProp ?? localDebugOverlay;
  // Итерация 2.1 (Задача 5): локальный useState clockTime используется только для текстовой подписи formatTime в JSX;
  // в rAF камера читает clock.getTime() напрямую.
  const [clockTime, setClockTime] = useState(currentTime);

  const userScrollingRef = useRef(false);
  const dragRef = useRef<{ startY: number; startScroll: number } | null>(null);
  const wheelIdleTimer = useRef<number | undefined>(undefined);
  const wheelTargetRef = useRef<number | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const frameDedupRef = useRef(new CanvasFrameDeduplicator());
  const stripStateRef = useRef({
    stripScene: null as ReturnType<typeof createStripSceneFromMedia>,
    currentTime: 0,
    onSeek: undefined as ((t: number) => void) | undefined,
  });

  useEffect(() => {
    frameDedupRef.current.invalidate();
  }, [stripViewport, stripGap]);

  const audioSet = useMemo(
    () => (audioPanelIds instanceof Set ? audioPanelIds : new Set(audioPanelIds ?? [])),
    [audioPanelIds]
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const map = new Map<string, HTMLImageElement>();
      // Прогрессивно: как только страница декодирована — сразу показываем её,
      // не ожидая всю пачку. Длинная webtoon-полоса декодируется секундами,
      // и раньше превью оставалось пустым до истечения общего таймаута.
      for (const src of images) {
        if (cancelled) return;
        if (!src) continue;
        if (map.has(src)) continue;
        const img = await loadImageElement(src, { crossOrigin: 'anonymous' });
        if (cancelled) return;
        map.set(src, img);
        setLoaded(new Map(map));
        frameDedupRef.current.invalidate();
        if (!isImageDrawable(img)) {
          // Таймаут страховки: дорисовываем кадр, когда файл всё-таки догрузится.
          img.addEventListener(
            'load',
            () => {
              frameDedupRef.current.invalidate();
              scheduleDrawRef.current();
            },
            { once: true }
          );
        }
      }
      frameDedupRef.current.invalidate();
      setLoaded(new Map(map));
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [images]);

  /**
   * Сцена ленты строится тем же кодом, что и в экспорте, поэтому превью и
   * итоговое видео совпадают. Настройки заданы в координатах 1080p — переносим
   * их на превью-кадр 720p.
   */
  const stripScene = useMemo(() => {
    if (renderMode !== 'strip' || images.length === 0) return null;
    const ratio = FRAME_H / EXPORT_FRAME_H;
    return createStripSceneFromMedia({
      images,
      loaded,
      timeline,
      panels: panels.map(p => ({
        id: p.id,
        imageIndex: p.imageIndex,
        bbox: p.bbox,
        fullFrame: p.fullFrame,
      })),
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      viewport: resolveStripViewport(EXPORT_FRAME_H, stripViewport) * ratio,
      gap: (stripGap ?? STRIP_DEFAULTS.gap) * ratio,
    });
  }, [renderMode, images, loaded, timeline, panels, stripViewport, stripGap]);

  useEffect(() => {
    frameDedupRef.current.invalidate();
  }, [renderMode, stripViewport, stripGap, images.length]);

  // Этап 3.1 (Н-3.3): единый селектор состояния шапки через useSyncExternalStore по ProjectClock.
  // Примечание: индикатор [X..Y%] показывает статические границы среза активной панели (внутри одной полосы
  // эти границы константны), а при смене фазы, активной панели, страницы или направления прокрутки
  // селектор обновляет шапку синхронно с clock без расхождения live/fallback состояний.
  const subscribeHeaderStore = useCallback(
    (onStoreChange: () => void) => (clock ? clock.subscribe(() => onStoreChange()) : () => {}),
    [clock]
  );
  const getHeaderSelectorKey = useCallback(() => {
    const t = clock ? clock.getTime() : currentTime;
    const s = sampleCameraFrame({
      time: t,
      renderMode,
      panels,
      timeline,
      introDuration,
      outroDuration,
      introAudioDuration,
      outroAudioDuration,
      stripScene,
      viewportWidth: FRAME_W,
      viewportHeight: FRAME_H,
      debugOverlay,
    });
    return computePreviewHeaderSelectorKey(s);
  }, [
    clock,
    currentTime,
    renderMode,
    panels,
    timeline,
    introDuration,
    outroDuration,
    introAudioDuration,
    outroAudioDuration,
    stripScene,
    debugOverlay,
  ]);
  const headerSelectorKey = useSyncExternalStore(
    subscribeHeaderStore,
    getHeaderSelectorKey,
    getHeaderSelectorKey
  );

  const cameraSample = useMemo(
    () =>
      sampleCameraFrame({
        time: clock ? clock.getTime() : currentTime,
        renderMode,
        panels,
        timeline,
        introDuration,
        outroDuration,
        introAudioDuration,
        outroAudioDuration,
        stripScene,
        viewportWidth: FRAME_W,
        viewportHeight: FRAME_H,
        debugOverlay,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      headerSelectorKey,
      clock,
      currentTime,
      renderMode,
      panels,
      timeline,
      introDuration,
      outroDuration,
      introAudioDuration,
      outroAudioDuration,
      stripScene,
      debugOverlay,
    ]
  );

  const activePanel = useMemo(() => {
    if (cameraSample.displayPanel) return cameraSample.displayPanel;
    if (cameraSample.activePanelId !== null) {
      const byClock = panels.find(p => p.id === cameraSample.activePanelId);
      if (byClock) return byClock;
    }
    return panels[currentPanelIndex] ?? null;
  }, [cameraSample.displayPanel, cameraSample.activePanelId, panels, currentPanelIndex]);

  const selectedPanel = useMemo(
    () => (selectedPanelId !== null ? panels.find(p => p.id === selectedPanelId) ?? null : null),
    [panels, selectedPanelId]
  );

  // Раздельная диагностика отсутствующего изображения и отсутствующего аудио (Этап 7 п. 70)
  const slotDiagnostics = useMemo(() => {
    if (!activePanel) return null;
    const hasImg = Boolean(images[activePanel.imageIndex]);
    const seg = timeline.find(s => s.panelId === activePanel.id);
    const hasAud =
      audioSet.size > 0
        ? audioSet.has(activePanel.id) ||
          (activePanel.sourceAudioPanelId !== undefined &&
            audioSet.has(activePanel.sourceAudioPanelId))
        : Boolean(seg && !seg.isEstimated);
    return diagnoseSlotResources({
      panel: activePanel,
      hasImageResource: hasImg,
      hasAudioResource: hasAud,
    });
  }, [activePanel, images, timeline, audioSet]);

  // Итерация 2.2 (P1-3): стабильный performSeek через useCallback
  const performSeek = useCallback(
    (targetTime: number) => {
      if (clock) {
        clock.seek(targetTime, 'seek');
      }
      onSeek?.(targetTime);
    },
    [clock, onSeek]
  );

  // Реф актуальных параметров рендера для чтения в едином rAF без пересоздания подписки на clock (Итерация 2.2 P1-3)
  const renderParamsRef = useRef({
    currentTime,
    duration,
    renderMode,
    images,
    loaded,
    panels,
    timeline,
    introText,
    outroText,
    introDuration,
    outroDuration,
    introAudioDuration,
    outroAudioDuration,
    stripScene,
    debugOverlay,
    activePanel,
  });

  useEffect(() => {
    renderParamsRef.current = {
      currentTime,
      duration,
      renderMode,
      images,
      loaded,
      panels,
      timeline,
      introText,
      outroText,
      introDuration,
      outroDuration,
      introAudioDuration,
      outroAudioDuration,
      stripScene,
      debugOverlay,
      activePanel,
    };
    stripStateRef.current = {
      stripScene,
      currentTime: clock ? clock.getTime() : currentTime,
      onSeek: performSeek,
    };
  });

  // Новая страница догрузилась (или её декодирование завершилось позже) —
  // сбрасываем дедупликацию кадра и перерисовываем текущий момент, иначе
  // превью остаётся пустым до первого seek/play.
  useEffect(() => {
    frameDedupRef.current.invalidate();
    scheduleDrawRef.current();
  }, [loaded, stripScene]);

  /**
   * Ручной скролл ленты (колесо): scrollY → timeAtScroll → onSeek к позиции
   * времени на ProjectClock (Этап 4 п. 40).
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || renderMode !== 'strip') return;
    const onWheel = (e: WheelEvent) => {
      const state = stripStateRef.current;
      if (!state.stripScene || !state.onSeek) return;
      e.preventDefault();
      userScrollingRef.current = true;
      const scale = FRAME_H / Math.max(1, canvas.clientHeight);
      const currentSample = sampleCameraFrame({
        time: clock ? clock.getTime() : state.currentTime,
        renderMode: 'strip',
        panels,
        timeline,
        introDuration,
        outroDuration,
        introAudioDuration,
        outroAudioDuration,
        stripScene: state.stripScene,
      });
      const current = wheelTargetRef.current ?? currentSample.stripScrollY;
      wheelTargetRef.current = clampScroll(current + e.deltaY * scale, state.stripScene.layout);

      if (wheelFrameRef.current === null) {
        const animate = () => {
          const latest = stripStateRef.current;
          if (!latest.stripScene || !latest.onSeek || wheelTargetRef.current === null) {
            wheelFrameRef.current = null;
            return;
          }
          const latestSample = sampleCameraFrame({
            time: clock ? clock.getTime() : latest.currentTime,
            renderMode: 'strip',
            panels,
            timeline,
            introDuration,
            outroDuration,
            introAudioDuration,
            outroAudioDuration,
            stripScene: latest.stripScene,
          });
          const actual = latestSample.stripScrollY;
          const targetScroll = wheelTargetRef.current;
          const nextScroll = actual + (targetScroll - actual) * 0.24;
          const targetTime = latest.stripScene.timeAtScroll(nextScroll);
          if (targetTime !== null) latest.onSeek(targetTime);
          if (Math.abs(targetScroll - nextScroll) > 1) {
            wheelFrameRef.current = window.requestAnimationFrame(animate);
          } else {
            wheelTargetRef.current = null;
            wheelFrameRef.current = null;
          }
        };
        wheelFrameRef.current = window.requestAnimationFrame(animate);
      }
      window.clearTimeout(wheelIdleTimer.current);
      wheelIdleTimer.current = window.setTimeout(() => {
        userScrollingRef.current = false;
      }, 150);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      if (wheelFrameRef.current !== null) window.cancelAnimationFrame(wheelFrameRef.current);
      wheelFrameRef.current = null;
      wheelTargetRef.current = null;
    };
  }, [clock, renderMode, panels, timeline, introDuration, outroDuration, introAudioDuration, outroAudioDuration]);

  // Итерация 2.2 (P1-2): handleStripPointerDown читает clock?.getTime() и sampleCameraFrame напрямую
  const handleStripPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!stripScene) return;
    const nowTime = clock ? clock.getTime() : renderParamsRef.current.currentTime;
    const nowSample = sampleCameraFrame({
      time: nowTime,
      renderMode: 'strip',
      panels,
      timeline,
      introDuration,
      outroDuration,
      introAudioDuration,
      outroAudioDuration,
      stripScene,
    });
    dragRef.current = { startY: e.clientY, startScroll: nowSample.stripScrollY };
    userScrollingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const handleStripPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || !stripScene) return;
    const scale = FRAME_H / Math.max(1, canvasRef.current?.clientHeight || 1);
    const next = clampScroll(
      drag.startScroll + (e.clientY - drag.startY) * scale,
      stripScene.layout
    );
    const target = stripScene.timeAtScroll(next);
    if (target !== null) performSeek(target);
  };
  const handleStripPointerEnd = () => {
    dragRef.current = null;
    userScrollingRef.current = false;
  };

  const scheduleDrawRef = useRef<() => void>(() => {});

  // Итерация 2.2 (P1-3): единая подписка на clock без пересоздания на каждый currentTime
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let rafId: number | null = null;

    const drawCurrentFrame = () => {
      rafId = null;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;

      const w = FRAME_W;
      const h = FRAME_H;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        frameDedupRef.current.invalidate();
      }

      const rp = renderParamsRef.current;
      const currentTime = rp.currentTime;
      const frameTime = clock ? clock.getTime() : currentTime;
      const sample = sampleCameraFrame({
        time: frameTime,
        renderMode: rp.renderMode,
        panels: rp.panels,
        timeline: rp.timeline,
        introDuration: rp.introDuration,
        outroDuration: rp.outroDuration,
        introAudioDuration: rp.introAudioDuration,
        outroAudioDuration: rp.outroAudioDuration,
        stripScene: rp.stripScene,
        viewportWidth: w,
        viewportHeight: h,
        debugOverlay: rp.debugOverlay,
      });

      const currentPanel = sample.displayPanel ?? rp.activePanel;
      const sig = `${sample.frameSignature}|${currentPanel?.id ?? 'none'}|${
        currentPanel?.dialogue ?? ''
      }|${rp.introText}|${rp.outroText}|${rp.loaded.size}`;
      if (!frameDedupRef.current.shouldDraw(sig)) {
        return;
      }

      drawPreviewFrameToCanvas({
        ctx,
        width: w,
        height: h,
        time: frameTime,
        renderMode: rp.renderMode,
        images: rp.images,
        loadedImages: rp.loaded,
        panels: rp.panels,
        timeline: rp.timeline,
        introText: rp.introText,
        outroText: rp.outroText,
        introDuration: rp.introDuration,
        outroDuration: rp.outroDuration,
        introAudioDuration: rp.introAudioDuration,
        outroAudioDuration: rp.outroAudioDuration,
        duration: rp.duration,
        stripScene: rp.stripScene,
        debugOverlay: rp.debugOverlay,
        fallbackPanel: rp.activePanel,
        showProgressBar: true,
      });
    };

    const scheduleDraw = () => {
      if (rafId === null) {
        rafId = window.requestAnimationFrame(drawCurrentFrame);
      }
    };
    scheduleDrawRef.current = scheduleDraw;
    const buildModeStripScene = (mode: 'panels' | 'strip') => {
      const rp = renderParamsRef.current;
      return mode === 'strip' && rp.images.length > 0
        ? createStripSceneFromMedia({
            images: rp.images,
            loaded: rp.loaded,
            timeline: rp.timeline,
            panels: rp.panels.map(p => ({
              id: p.id,
              imageIndex: p.imageIndex,
              bbox: p.bbox,
              fullFrame: p.fullFrame,
            })),
            frameWidth: FRAME_W,
            frameHeight: FRAME_H,
            viewport: resolveStripViewport(EXPORT_FRAME_H, stripViewport) * (FRAME_H / EXPORT_FRAME_H),
            gap: (stripGap ?? STRIP_DEFAULTS.gap) * (FRAME_H / EXPORT_FRAME_H),
          })
        : null;
    };
    (
      canvas as HTMLCanvasElement & {
        __renderPreviewFrameDataUrl?: (
          targetTime: number,
          modeOverride?: 'panels' | 'strip'
        ) => string;
        __renderExportFrameDataUrl?: (
          targetTime: number,
          modeOverride?: 'panels' | 'strip'
        ) => string;
      }
    ).__renderPreviewFrameDataUrl = (targetTime: number, modeOverride?: 'panels' | 'strip') => {
      const rp = renderParamsRef.current;
      const mode = modeOverride ?? rp.renderMode;
      if (clock) {
        clock.seek(targetTime, 'seek');
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return '';
      const modeStripScene = buildModeStripScene(mode);
      frameDedupRef.current.invalidate();
      drawPreviewFrameToCanvas({
        ctx,
        width: FRAME_W,
        height: FRAME_H,
        time: targetTime,
        renderMode: mode,
        images: rp.images,
        loadedImages: rp.loaded,
        panels: rp.panels,
        timeline: rp.timeline,
        introText: rp.introText,
        outroText: rp.outroText,
        introDuration: rp.introDuration,
        outroDuration: rp.outroDuration,
        introAudioDuration: rp.introAudioDuration,
        outroAudioDuration: rp.outroAudioDuration,
        duration: rp.duration,
        stripScene: modeStripScene,
        debugOverlay: false,
        fallbackPanel: rp.activePanel,
        showProgressBar: false,
      });
      return canvas.toDataURL('image/png');
    };
    (
      canvas as HTMLCanvasElement & {
        __renderExportFrameDataUrl?: (
          targetTime: number,
          modeOverride?: 'panels' | 'strip'
        ) => string;
      }
    ).__renderExportFrameDataUrl = (targetTime: number, modeOverride?: 'panels' | 'strip') => {
      const rp = renderParamsRef.current;
      const mode = modeOverride ?? rp.renderMode;
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = FRAME_W;
      exportCanvas.height = FRAME_H;
      const exportCtx = exportCanvas.getContext('2d', { alpha: false });
      if (!exportCtx) return '';
      const exportStripScene = buildModeStripScene(mode);
      renderExportFrameToCanvas({
        ctx: exportCtx,
        width: FRAME_W,
        height: FRAME_H,
        time: targetTime,
        options: {
          images: rp.images,
          audioBlobs: [],
          timeline: rp.timeline,
          panels: rp.panels.map(p => ({
            id: p.id,
            imageIndex: p.imageIndex,
            bbox: p.bbox,
            fullFrame: p.fullFrame,
          })),
          introText: rp.introText,
          outroText: rp.outroText,
          introDuration: rp.introDuration,
          outroDuration: rp.outroDuration,
          introAudioDuration: rp.introAudioDuration,
          outroAudioDuration: rp.outroAudioDuration,
          srtContent: '',
          fps: 30,
          renderMode: mode,
        },
        loadedImages: rp.loaded,
        stripScene: exportStripScene ?? undefined,
      });
      return exportCanvas.toDataURL('image/png');
    };
    scheduleDraw();

    if (!clock) {
      return () => {
        if (rafId !== null) window.cancelAnimationFrame(rafId);
      };
    }

    setClockTime(clock.getTime());
    const unsub = clock.subscribe(snap => {
      setClockTime(snap.currentTime);
      scheduleDraw();
    });

    return () => {
      unsub();
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, [clock]);

  // Перерисовка при изменении структурных пропсов (без пересоздания подписки на clock)
  useEffect(() => {
    scheduleDrawRef.current();
  }, [
    loaded,
    panels,
    timeline,
    currentTime,
    duration,
    images,
    stripScene,
    isPlaying,
    debugOverlay,
    renderMode,
    introText,
    outroText,
    introDuration,
    outroDuration,
    introAudioDuration,
    outroAudioDuration,
  ]);

  const formatTime = (s: number) => {
    if (!isFinite(s) || s <= 0) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  // Клик по миниатюре страницы выбирает первый связанный сегмент и перемещает плейхед (Этап 7 п. 67)
  const handlePageThumbnailClick = (pageIndex: number) => {
    const first = resolveFirstSegmentForPage(pageIndex, panels, timeline);
    if (first) {
      onSelectPanel?.(first.panelId);
      performSeek(first.seekTime);
    }
  };

  // Кнопка «Перейти к активному клипу» (Этап 7 п. 65)
  const handleJumpToActiveClip = () => {
    if (activePanel) {
      onSelectPanel?.(activePanel.id);
      const seg = timeline.find(s => s.panelId === activePanel.id);
      if (seg) performSeek(seg.audioStart);
    }
  };

  return (
    <div className="w-full space-y-2">
      {/* Верхняя строка индикаторов режима, направления скролла, отладочной разметки и перехода к активному клипу (Этап 7 п. 63–66) */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-0.5 rounded border font-mono ${
              renderMode === 'strip'
                ? 'bg-[#2A2038] border-[#6E4BC4] text-[#D8C4FF]'
                : 'bg-[#242014] border-[#594615] text-[#E8B44C]'
            }`}
            title="Текущий режим отображения превью и финального рендера (Этап 7 п. 66)"
          >
            {renderMode === 'strip' ? 'Режим: Вертикальная лента (Strip)' : 'Режим: Сцены (Panels)'}
          </span>

          {renderMode === 'strip' && (
            <span
              className="px-2 py-0.5 rounded bg-[#16161A] border border-[#26262C] text-[#A1A1AA] font-mono"
              title="Индикатор направления движения камеры по ленте (Этап 7 п. 64)"
            >
              {cameraSample.stripScrollDirection === 'down'
                ? '↓ Прокрутка вниз'
                : cameraSample.stripScrollDirection === 'up'
                ? '↑ Возврат вверх'
                : '• Камера на месте'}
            </span>
          )}

          {/* Двусторонняя подсветка связанных видео- и аудиоклипов выбранной/активной панели (Этап 7 п. 62) */}
          {(selectedPanel ?? activePanel) && (
            <span
              data-linked-clip-highlight={(selectedPanel ?? activePanel)?.id}
              className="px-2 py-0.5 rounded border border-[#E8B44C]/50 bg-[#241E11] text-[#F5D27A] font-mono"
              title="Связанные клипы дорожек Видео и Аудио на таймлайне (Этап 7 п. 62)"
            >
              Видео Стр. {((selectedPanel ?? activePanel)?.imageIndex ?? 0) + 1} ⇄ Аудио #
              {(selectedPanel ?? activePanel)?.id}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleJumpToActiveClip}
            disabled={!activePanel}
            className="h-6 px-2 rounded border border-[#26262C] bg-[#16161A] text-[#F5F5F7] hover:border-[#E8B44C]/60 disabled:opacity-40 transition-colors"
            title="Перейти к активному клипу на превью и таймлайне (Этап 7 п. 65)"
            aria-label="Перейти к активному клипу"
          >
            К активному клипу
          </button>

          {renderMode === 'panels' && (
            <button
              type="button"
              onClick={() => {
                frameDedupRef.current.invalidate();
                const next = !debugOverlay;
                setLocalDebugOverlay(next);
                onToggleDebugOverlay?.(next);
              }}
              className={`h-6 px-2 rounded border transition-colors ${
                debugOverlay
                  ? 'border-[#E8B44C] bg-[#3A311D] text-[#F5D27A]'
                  : 'border-[#26262C] bg-[#16161A] text-[#8A8A93] hover:text-[#F5F5F7]'
              }`}
              title="Показать/скрыть отладочные рамки срезов [X..Y%] (не попадают в экспорт видео, Этап 7 п. 63)"
              aria-label="Переключить отладочные рамки процентов"
            >
              [X..Y%] Разметка
            </button>
          )}
        </div>
      </div>

      {/* Раздельный баннер диагностики отсутствия изображения vs отсутствия аудио (Этап 7 п. 70) */}
      {slotDiagnostics &&
        (slotDiagnostics.missingImageMessage || slotDiagnostics.missingAudioMessage) && (
          <div className="px-3 py-1.5 rounded-[8px] border border-[#4A3818] bg-[#1D170C] text-[11px] text-[#E8C988] flex flex-col gap-0.5">
            {slotDiagnostics.missingImageMessage && (
              <div className="text-[#F59E9E]">⚠ {slotDiagnostics.missingImageMessage}</div>
            )}
            {slotDiagnostics.missingAudioMessage && (
              <div>ℹ {slotDiagnostics.missingAudioMessage}</div>
            )}
          </div>
        )}

      <div className="relative aspect-video bg-[#0B0B0C] rounded-[16px] overflow-hidden border border-[#26262C] group">
        <canvas
          ref={canvasRef}
          data-testid="preview-canvas"
          className={`w-full h-full ${
            renderMode === 'strip' ? 'cursor-grab active:cursor-grabbing touch-none' : ''
          }`}
          onPointerDown={renderMode === 'strip' ? handleStripPointerDown : undefined}
          onPointerMove={renderMode === 'strip' ? handleStripPointerMove : undefined}
          onPointerUp={renderMode === 'strip' ? handleStripPointerEnd : undefined}
          onPointerCancel={renderMode === 'strip' ? handleStripPointerEnd : undefined}
        />

        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-[150ms] bg-[#0B0B0C]/20 pointer-events-none">
          <button
            type="button"
            onClick={onPlayPause}
            aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
            className="pointer-events-auto w-12 h-12 rounded-full bg-[#16161A] border border-[#26262C] flex items-center justify-center text-[#F5F5F7] hover:bg-[#1E1E23] transition-colors duration-[150ms]"
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-10 px-4 flex items-center justify-between bg-gradient-to-t from-[#0B0B0C]/80 to-transparent">
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="preview-play-pause-btn"
              onClick={onPlayPause}
              aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
              className="text-[#F5F5F7] text-sm hover:text-[#E8B44C] transition-colors"
            >
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <span
              data-testid="preview-time-readout"
              className="font-mono text-[12px] text-[#8A8A93]"
            >
              {formatTime(clock ? clockTime : currentTime)} / {formatTime(duration)}
            </span>
          </div>
          <span className="font-mono text-[11px] text-[#8A8A93]">
            {renderMode === 'strip'
              ? `Лента · Стр. ${(cameraSample.activeImageIndex ?? 0) + 1}`
              : activePanel
              ? `Изображение ${activePanel.imageIndex + 1} [${Math.round(
                  cameraSample.yRange[0]
                )}..${Math.round(cameraSample.yRange[1])}%]`
              : 'Нет изображения'}
          </span>
        </div>
      </div>

      {/* Полоса миниатюр страниц: клик выбирает первый связанный сегмент и перемещает плейхед (Этап 7 п. 67) */}
      {images.length > 1 && (
        <div
          className="flex items-center gap-1.5 overflow-x-auto pb-1"
          role="list"
          aria-label="Миниатюры страниц манги"
        >
          {images.map((url, idx) => {
            const isActivePage = activePanel?.imageIndex === idx;
            const isSelectedPage = selectedPanel?.imageIndex === idx;
            const pageCount = panels.filter(p => p.imageIndex === idx).length;
            return (
              <button
                key={idx}
                type="button"
                onClick={() => handlePageThumbnailClick(idx)}
                className={`h-7 px-2 rounded-[6px] border text-[10px] font-mono flex items-center gap-1.5 shrink-0 transition-colors ${
                  isActivePage
                    ? 'border-[#E8B44C] bg-[#2D2412] text-[#F5D27A]'
                    : isSelectedPage
                    ? 'border-[#6E4BC4] bg-[#231B36] text-[#D8C4FF]'
                    : 'border-[#26262C] bg-[#141418] text-[#8A8A93] hover:border-[#52525E] hover:text-[#F5F5F7]'
                }`}
                title={`Изображение ${idx + 1} (сцен: ${pageCount}) — нажмите для перехода к первой сцене страницы`}
                aria-label={`Перейти к странице ${idx + 1}`}
              >
                {url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt="" className="w-3.5 h-4 object-cover rounded-[2px]" />
                )}
                <span>Стр. {idx + 1}</span>
                <span className="opacity-65">({pageCount})</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

