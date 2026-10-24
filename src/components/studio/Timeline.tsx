"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PanelData, SyncTimeline } from '@/lib/storage/db';
import {
  TIMELINE_TRACK_OFFSET,
  TIMELINE_ZOOM_MAX,
  TIMELINE_ZOOM_MIN,
  collectSnapTargets,
  computeAutoFollowScrollLeft,
  computeIntroOutroSegments,
  computeTimelineGaps,
  computeTimelineGeometry,
  computeZoomAroundTime,
  snapTimeToTargets,
} from '@/lib/pipeline/timelineGeometry';
import {
  computeDragDropReorderTarget,
  computeTrimHandleUpdate,
  createTimelinePointerController,
  type TimelineTrackKind,
} from '@/lib/pipeline/timelineDrag';
import { formatClipTooltip, formatGapTooltip } from '@/lib/pipeline/projectHealth';

export {
  computeDragDropReorderTarget,
  computeTrimHandleUpdate,
  createTimelinePointerController,
  type TimelineTrackKind,
};

interface TimelineProps {
  images: string[];
  timeline: SyncTimeline[];
  panels?: PanelData[];
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  onSelectPanel: (panelId: number) => void;
  onSelectIntro: () => void;
  onSelectOutro: () => void;
  selectedId: number | 'intro' | 'outro' | null;
  introDuration?: number;
  outroDuration?: number;
  panelGap?: number;
  onGapChange?: (gap: number) => void;
  audioPanelIds?: number[] | Set<number>;
  isPlaying?: boolean;
  // NLE операции (Этап 6 п. 51–60; Этап 3.2 п. 51, 52)
  onSplitActiveClip?: () => void;
  onDeleteActiveClip?: () => void;
  onDuplicateActiveClip?: () => void;
  onMoveActiveClipLeft?: () => void;
  onMoveActiveClipRight?: () => void;
  onReorderPanel?: (panelId: number, targetIndex: number) => void;
  onReorderClip?: (fromIndex: number, toIndex: number) => void;
  onTrimPanel?: (panelId: number, trimIn: number, trimOut: number) => void;
  onSetPanelTrim?: (panelId: number, trimIn: number, trimOut: number) => void;
  onTogglePanelMute?: (panelId: number) => void;
  onTogglePanelSolo?: (panelId: number) => void;
  /** Блокировки дорожек (P1-1): если переданы — состояние живёт в проекте. */
  videoTrackLocked?: boolean;
  audioTrackLocked?: boolean;
  onToggleTrackLock?: (track: 'video' | 'audio') => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function formatTime(s: number): string {
  if (!isFinite(s) || s <= 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function waveform(panelId: number, count = 32): number[] {
  return Array.from({ length: count }, (_, i) => {
    const value = Math.abs(
      Math.sin((panelId + 1) * 7.31 + i * 1.83) * 0.58 + Math.cos(i * 0.71 + panelId) * 0.24
    );
    return clamp(0.18 + value, 0.16, 0.95);
  });
}

export function Timeline({
  images,
  timeline,
  panels = [],
  currentTime,
  duration,
  onSeek,
  onSelectPanel,
  onSelectIntro,
  onSelectOutro,
  selectedId,
  videoTrackLocked,
  audioTrackLocked,
  onToggleTrackLock,
  introDuration = 8,
  outroDuration = 5,
  panelGap = 0.3,
  onGapChange,
  audioPanelIds = [],
  isPlaying = false,
  onSplitActiveClip,
  onDeleteActiveClip,
  onDuplicateActiveClip,
  onMoveActiveClipLeft,
  onMoveActiveClipRight,
  onReorderPanel,
  onReorderClip,
  onTrimPanel,
  onSetPanelTrim,
  onTogglePanelMute,
  onTogglePanelSolo,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: TimelineProps) {
  const [localGap, setLocalGap] = useState(panelGap);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(960);
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollRafRef = useRef<number | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [autoFollow, setAutoFollow] = useState(true);
  // Локальный fallback: если родитель не передал блокировки (например, в
  // изолированном использовании компонента), поведение прежнее.
  const [videoLockedLocal, setVideoLockedLocal] = useState(false);
  const [audioLockedLocal, setAudioLockedLocal] = useState(false);
  const videoLocked = videoTrackLocked ?? videoLockedLocal;
  const audioLocked = audioTrackLocked ?? audioLockedLocal;
  const toggleVideoLock = () => (onToggleTrackLock ? onToggleTrackLock('video') : setVideoLockedLocal(v => !v));
  const toggleAudioLock = () => (onToggleTrackLock ? onToggleTrackLock('audio') : setAudioLockedLocal(v => !v));
  // Этап 3.2 (п. 51): drag-and-drop клипов (pointer-events + drag events), draggedPanelId и фильтр одной дорожки
  const [draggedPanelId, setDraggedPanelId] = useState<number | null>(null);
  const [draggedTrack, setDraggedTrack] = useState<'video' | 'audio' | null>(null);
  const [draggedClipIndex, setDraggedClipIndex] = useState<number | null>(null);
  const [dropHoverIndex, setDropHoverIndex] = useState<number | null>(null);
  const [pendingDropReorder, setPendingDropReorder] = useState<{
    panelId: number;
    fromIndex: number;
    toIndex: number;
  } | null>(null);
  const commitTrimUpdate = onTrimPanel ?? onSetPanelTrim;
  const commitReorder = (panelId: number, fromIndex: number, toIndex: number) => {
    if (onReorderPanel) {
      onReorderPanel(panelId, toIndex);
    } else if (onReorderClip) {
      onReorderClip(fromIndex, toIndex);
    }
  };
  // Этап 3.2 (п. 52): состояние активного перетаскивания визуальной ручки trimIn/trimOut
  const [activeTrimDrag, setActiveTrimDrag] = useState<{
    panelId: number;
    edge: 'in' | 'out';
    startX: number;
    initialTrimIn: number;
    initialTrimOut: number;
    segStart: number;
    segEnd: number;
    previewTrimIn: number;
    previewTrimOut: number;
  } | null>(null);
  const trimDragRef = useRef<typeof activeTrimDrag>(null);
  const clipDragRef = useRef<{
    panelId: number;
    track: 'video' | 'audio';
    fromIndex: number;
    hoverIndex: number | null;
  } | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Этап 3.1 (Н-3.6): отмена запланированного scrollRafRef при размонтировании компонента
  useEffect(
    () => () => {
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    },
    []
  );

  const audioSet = useMemo(
    () => (audioPanelIds instanceof Set ? audioPanelIds : new Set(audioPanelIds)),
    [audioPanelIds]
  );
  const panelById = useMemo(
    () => new Map<number, PanelData>(panels.map(p => [p.id, p])),
    [panels]
  );
  const anySolo = useMemo(() => panels.some(p => p.solo), [panels]);

  useEffect(() => setLocalGap(panelGap), [panelGap]);

  // Отслеживаем ширину видимой области для расчёта геометрии и зума
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const updateWidth = () => setViewportWidth(el.clientWidth || 960);
    updateWidth();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateWidth);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  // Единая геометрия trackRect для шкалы времени, дорожек Видео/Аудио и Playhead (Этап 5 п. 41, Итерация 2.1 Б5 / P1 п. 8)
  const geometry = useMemo(
    () =>
      computeTimelineGeometry({
        duration,
        zoom,
        scrollLeft,
        viewportWidth,
        trackOffset: TIMELINE_TRACK_OFFSET,
      }),
    [duration, zoom, scrollLeft, viewportWidth]
  );

  // Автоследование горизонтального скролла за playhead при воспроизведении в rAF (Этап 5 п. 43, P1 п. 13)
  useEffect(() => {
    if (!autoFollow || !isPlaying) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rafId = window.requestAnimationFrame(() => {
      const el = scrollerRef.current;
      if (!el) return;
      const nextScroll = computeAutoFollowScrollLeft({
        currentTime,
        duration,
        zoom,
        scrollLeft: el.scrollLeft,
        viewportWidth: el.clientWidth || viewportWidth,
        trackOffset: TIMELINE_TRACK_OFFSET,
        smoothing: 0.2,
      });
      if (Math.abs(nextScroll - el.scrollLeft) > 0.5) {
        el.scrollLeft = nextScroll;
        setScrollLeft(nextScroll);
      }
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [currentTime, duration, zoom, autoFollow, isPlaying, viewportWidth]);

  // Масштабирование вокруг currentTime без сброса горизонтального скролла (Этап 5 п. 44, 45)
  const handleZoomChange = (nextZoomRaw: number) => {
    const clampedZoom = clamp(
      Number(nextZoomRaw.toFixed(2)),
      TIMELINE_ZOOM_MIN,
      TIMELINE_ZOOM_MAX
    );
    const scroller = scrollerRef.current;
    if (scroller) {
      const result = computeZoomAroundTime({
        anchorTime: currentTime,
        duration,
        oldZoom: zoom,
        newZoom: clampedZoom,
        oldScrollLeft: scroller.scrollLeft,
        viewportWidth: scroller.clientWidth || viewportWidth,
        trackOffset: TIMELINE_TRACK_OFFSET,
      });
      setZoom(result.zoom);
      setScrollLeft(result.scrollLeft);
      requestAnimationFrame(() => {
        if (scrollerRef.current) {
          scrollerRef.current.scrollLeft = result.scrollLeft;
        }
      });
    } else {
      setZoom(clampedZoom);
    }
  };

  // Визуализированные блоки межрепликовых пауз panelGap (Этап 5 п. 48) и интро/аутро (Этап 5 п. 49)
  const gapSpans = useMemo(
    () => computeTimelineGaps(timeline, geometry),
    [timeline, geometry]
  );
  const introOutro = useMemo(
    () => computeIntroOutroSegments(timeline, introDuration, outroDuration, geometry),
    [timeline, introDuration, outroDuration, geometry]
  );

  // Цели для примагничивания (snap) (Этап 6 п. 59)
  const snapTargets = useMemo(
    () => collectSnapTargets(timeline, introDuration, geometry.safeDuration),
    [timeline, introDuration, geometry.safeDuration]
  );

  const commitGap = () => {
    if (onGapChange && Math.abs(localGap - panelGap) > 0.001) onGapChange(localGap);
  };

  const seekFromClientX = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rawTime = geometry.clientXFromContentToTime(clientX, rect.left);
    if (snapEnabled) {
      const snapped = snapTimeToTargets(rawTime, snapTargets, 0.12 / Math.max(0.75, zoom));
      onSeek(snapped.time);
    } else {
      onSeek(rawTime);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input, [data-trim-handle]')) return;
    // P1 п. 9: если обе дорожки заблокированы (или заблокирована дорожка), drag плейхеда заблокирован
    if (videoLocked && audioLocked) return;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX);
  };

  const updateActiveTrimFromClientX = (clientX: number) => {
    const td = trimDragRef.current;
    if (!td) return;
    const pxPerSec = Math.max(1, geometry.trackWidth / geometry.safeDuration);
    const deltaSec = (clientX - td.startX) / pxPerSec;
    const updated = computeTrimHandleUpdate({
      edge: td.edge,
      deltaSec,
      currentTrimIn: td.initialTrimIn,
      currentTrimOut: td.initialTrimOut,
      segStart: td.segStart,
      segEnd: td.segEnd,
      snapTargets,
      snapEnabled,
    });
    const nextState = {
      ...td,
      previewTrimIn: updated.trimIn,
      previewTrimOut: updated.trimOut,
    };
    trimDragRef.current = nextState;
    setActiveTrimDrag(nextState);
  };

  const finishActiveTrimDrag = () => {
    const td = trimDragRef.current;
    if (!td) return false;
    trimDragRef.current = null;
    setActiveTrimDrag(null);
    commitTrimUpdate?.(td.panelId, td.previewTrimIn, td.previewTrimOut);
    return true;
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (trimDragRef.current) {
      updateActiveTrimFromClientX(event.clientX);
      return;
    }
    if (videoLocked && audioLocked) return;
    if (dragging) seekFromClientX(event.clientX);
  };

  const handlePointerUp = () => {
    if (finishActiveTrimDrag()) return;
    setDragging(false);
  };

  const selectedPanelId = typeof selectedId === 'number' ? selectedId : null;

  return (
    <section
      data-testid="studio-timeline"
      data-current-time={currentTime.toFixed(3)}
      data-dragged-panel-id={draggedPanelId ?? undefined}
      className="w-full min-h-[280px] sm:min-h-[300px] rounded-[12px] border border-[#26262C] bg-[#111114] overflow-hidden"
      aria-label="Монтажная лента видео и аудио"
    >
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-[#26262C] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-medium text-[#F5F5F7]">Монтажная лента</h3>
          <span className="rounded bg-[#1E1E23] px-1.5 py-0.5 text-[10px] text-[#8A8A93]">
            кадры + аудио
          </span>

          {/* Undo / Redo для операций таймлайна (Этап 6 п. 60) */}
          {(onUndo || onRedo) && (
            <div className="flex items-center gap-1 rounded-md border border-[#26262C] bg-[#0B0B0C] px-1">
              <button
                type="button"
                onClick={onUndo}
                disabled={!canUndo}
                className="h-6 px-1.5 text-[11px] text-[#A1A1AA] hover:text-[#F5F5F7] disabled:opacity-35"
                title="Отменить действие на таймлайне (Ctrl+Z)"
                aria-label="Отменить действие"
              >
                ↶
              </button>
              <button
                type="button"
                onClick={onRedo}
                disabled={!canRedo}
                className="h-6 px-1.5 text-[11px] text-[#A1A1AA] hover:text-[#F5F5F7] disabled:opacity-35"
                title="Повторить действие на таймлайне (Ctrl+Shift+Z)"
                aria-label="Повторить действие"
              >
                ↷
              </button>
            </div>
          )}

          {/* NLE: Split, удаление, дублирование и перестановка клипов (Этап 6 п. 51, 53) */}
          {(onSplitActiveClip || onDeleteActiveClip || onDuplicateActiveClip || onMoveActiveClipLeft || onMoveActiveClipRight) && (
            <div className="flex items-center gap-1 rounded-md border border-[#26262C] bg-[#0B0B0C] px-1.5 py-0.5">
              {onSplitActiveClip && (
                <button
                  type="button"
                  onClick={onSplitActiveClip}
                  disabled={selectedPanelId === null || audioLocked}
                  className="h-5 px-1.5 rounded text-[10px] text-[#E8B44C] hover:bg-[#1E1E23] disabled:opacity-35"
                  title="Разрезать выбранный клип в позиции плейхеда (клавиша S)"
                  aria-label="Разрезать клип"
                >
                  ✂ Split (S)
                </button>
              )}
              {onDeleteActiveClip && (
                <button
                  type="button"
                  data-testid="timeline-delete-clip-btn"
                  onClick={onDeleteActiveClip}
                  disabled={selectedPanelId === null || audioLocked}
                  className="h-5 px-1.5 rounded text-[10px] text-[#F87171] hover:bg-[#1E1E23] disabled:opacity-35"
                  title="Удалить выбранный клип и сдвинуть остальные (Ripple Delete)"
                >
                  🗑️ Удалить
                </button>
              )}
              {onDuplicateActiveClip && (
                <button
                  type="button"
                  data-testid="timeline-duplicate-clip-btn"
                  onClick={onDuplicateActiveClip}
                  disabled={selectedPanelId === null}
                  className="h-5 px-1.5 rounded text-[10px] text-[#A1A1AA] hover:bg-[#1E1E23] disabled:opacity-35"
                  title="Дублировать выбранный клип"
                >
                  📄 Дублировать
                </button>
              )}
              {onMoveActiveClipLeft && (
                <button
                  type="button"
                  onClick={onMoveActiveClipLeft}
                  disabled={selectedPanelId === null || videoLocked}
                  className="h-5 px-1 rounded text-[10px] text-[#A1A1AA] hover:text-[#F5F5F7] disabled:opacity-35"
                  title="Переместить выбранную сцену влево"
                  aria-label="Переместить сцену влево"
                >
                  ←
                </button>
              )}
              {onMoveActiveClipRight && (
                <button
                  type="button"
                  onClick={onMoveActiveClipRight}
                  disabled={selectedPanelId === null || videoLocked}
                  className="h-5 px-1 rounded text-[10px] text-[#A1A1AA] hover:text-[#F5F5F7] disabled:opacity-35"
                  title="Переместить выбранную сцену вправо"
                  aria-label="Переместить сцену вправо"
                >
                  →
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2" title="Пауза между репликами (panelGap)">
            <span className="font-mono text-[10px] text-[#8A8A93]">
              пауза {localGap.toFixed(2).replace(/\.?0+$/, '').replace('.', ',')} с
            </span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={localGap}
              onChange={e => setLocalGap(Number(e.target.value))}
              onMouseUp={commitGap}
              onTouchEnd={commitGap}
              onKeyUp={commitGap}
              onBlur={commitGap}
              aria-label="Пауза между репликами"
              className="w-20 accent-[#E8B44C]"
            />
          </label>

          {/* Snapping и Auto-follow (Этап 5 п. 43, Этап 6 п. 59) */}
          <button
            type="button"
            onClick={() => setSnapEnabled(v => !v)}
            className={`h-6 px-2 rounded-md border text-[10px] font-mono transition-colors ${
              snapEnabled
                ? 'border-[#594615] bg-[#2A2416] text-[#E8B44C]'
                : 'border-[#26262C] bg-[#0B0B0C] text-[#8A8A93]'
            }`}
            title="Примагничивание (Snap) к границам сегментов и смене страниц"
            aria-label="Переключить примагничивание"
          >
            Магнит
          </button>

          <button
            type="button"
            onClick={() => setAutoFollow(v => !v)}
            className={`h-6 px-2 rounded-md border text-[10px] font-mono transition-colors ${
              autoFollow
                ? 'border-[#2A4A36] bg-[#14241B] text-[#6EE7B7]'
                : 'border-[#26262C] bg-[#0B0B0C] text-[#8A8A93]'
            }`}
            title="Автоследование прокрутки таймлайна за линией Playhead"
            aria-label="Переключить автоследование за плейхедом"
          >
            Автоскролл
          </button>

          {/* Масштабирование вокруг currentTime (Этап 5 п. 44, 45) */}
          <div className="flex items-center gap-1 rounded-md border border-[#26262C] bg-[#0B0B0C] px-1">
            <button
              type="button"
              onClick={() => handleZoomChange(zoom - 0.25)}
              className="h-6 w-6 text-[#A1A1AA] hover:text-[#F5F5F7]"
              title="Уменьшить масштаб вокруг текущего времени"
              aria-label="Уменьшить масштаб"
            >
              −
            </button>
            <span className="w-10 text-center font-mono text-[10px] text-[#8A8A93]">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => handleZoomChange(zoom + 0.25)}
              className="h-6 w-6 text-[#A1A1AA] hover:text-[#F5F5F7]"
              title="Увеличить масштаб вокруг текущего времени"
              aria-label="Увеличить масштаб"
            >
              +
            </button>
          </div>

          <span
            data-testid="timeline-time-readout"
            className="font-mono text-[11px] text-[#8A8A93]"
          >
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>
      </div>

      <div
        ref={scrollerRef}
        data-scroll-area
        className="overflow-x-auto overflow-y-hidden px-3 pb-3"
        onScroll={e => {
          const nextLeft = e.currentTarget.scrollLeft;
          if (scrollRafRef.current === null) {
            scrollRafRef.current = window.requestAnimationFrame(() => {
              scrollRafRef.current = null;
              setScrollLeft(scrollerRef.current ? scrollerRef.current.scrollLeft : nextLeft);
            });
          }
        }}
        onWheel={e => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleZoomChange(zoom + (e.deltaY < 0 ? 0.25 : -0.25));
          } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            const parent =
              e.currentTarget.parentElement?.closest('[data-scroll-area]') ??
              e.currentTarget.closest('[data-scroll-area]');
            if (parent && parent !== e.currentTarget) {
              parent.scrollTop += e.deltaY;
            }
          }
        }}
      >
        {/* Баннер подтверждения перестановки клипа после drag-and-drop (Этап 3.2 п. 51, п. 98) */}
        {pendingDropReorder && (
          <div
            data-reorder-confirm-bar
            className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#E8B44C]/60 bg-[#241E11] px-3 py-1.5 text-[11px] text-[#F5D27A]"
          >
            <span>
              Переместить клип #{pendingDropReorder.panelId} с позиции {pendingDropReorder.fromIndex + 1} на позицию{' '}
              {pendingDropReorder.toIndex + 1}?
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  commitReorder(
                    pendingDropReorder.panelId,
                    pendingDropReorder.fromIndex,
                    pendingDropReorder.toIndex
                  );
                  setPendingDropReorder(null);
                }}
                className="rounded bg-[#E8B44C] px-2.5 py-0.5 font-medium text-[#0B0B0C] hover:bg-[#F5D27A]"
              >
                Подтвердить перестановку
              </button>
              <button
                type="button"
                onClick={() => setPendingDropReorder(null)}
                className="rounded border border-[#52525E] bg-[#16161A] px-2 py-0.5 text-[#A1A1AA] hover:text-white"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
        <div
          ref={contentRef}
          className="relative min-w-0 pt-7"
          style={{ width: geometry.contentWidth }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Явная визуальная граница начала (0s) и конца (duration) таймлайна (Этап 5 п. 42) */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-emerald-500/60"
            style={{ left: `${geometry.timeToContentPx(0)}px` }}
            title="Начало таймлайна (00:00)"
          />
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-rose-500/70"
            style={{ left: `${geometry.timeToContentPx(geometry.safeDuration)}px` }}
            title={`Конец таймлайна (${formatTime(duration)})`}
          />

          {/* Шкала времени, использующая тот же trackRect (Этап 5 п. 41) */}
          <div
            className="pointer-events-none absolute top-0 h-6 border-b border-[#26262C]"
            style={{ left: TIMELINE_TRACK_OFFSET, width: geometry.trackWidth }}
          >
            {Array.from({ length: Math.max(2, Math.ceil(geometry.safeDuration / 5) + 1) }).map(
              (_, i) => {
                const tickTime = Math.min(i * 5, geometry.safeDuration);
                return (
                  <span
                    key={i}
                    className="absolute top-1 -translate-x-1/2 font-mono text-[9px] text-[#666672]"
                    style={{ left: `${geometry.timeToRatio(tickTime) * 100}%` }}
                  >
                    {formatTime(tickTime)}
                  </span>
                );
              }
            )}
          </div>

          {/* Дорожка Видео */}
          <div className="grid grid-cols-[72px_1fr] gap-2 border-b border-[#26262C] py-3">
            <div className="flex items-center justify-between pr-1 text-[10px] uppercase tracking-wider text-[#8A8A93]">
              <span>Видео</span>
              <button
                type="button"
                onClick={toggleVideoLock}
                className={`px-1 rounded text-[9px] ${
                  videoLocked ? 'text-[#E8B44C] bg-[#2A2416]' : 'text-[#666672] hover:text-[#F5F5F7]'
                }`}
                title={videoLocked ? 'Разблокировать дорожку видео' : 'Заблокировать дорожку видео'}
                aria-label="Блокировка дорожки видео"
              >
                {videoLocked ? '🔒' : '🔓'}
              </button>
            </div>
            <div className="relative h-20 sm:h-24 rounded-md bg-[#0B0B0C]">
              {/* Интро (Этап 5 п. 49) */}
              {introDuration > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectIntro();
                    onSeek(0);
                  }}
                  className={`absolute top-1 bottom-1 overflow-hidden rounded border text-left ${
                    selectedId === 'intro'
                      ? 'border-[#F5D27A] bg-[#594615]'
                      : 'border-[#3A321F] bg-[#2A2416]'
                  }`}
                  style={{
                    left: `${introOutro.intro.geometry.leftPercent}%`,
                    width: `${introOutro.intro.geometry.widthPercent}%`,
                  }}
                  title={`Интро (0.00–${introDuration.toFixed(2)} с)`}
                >
                  <span className="block px-1.5 pt-1 text-[10px] text-[#E8B44C]">Интро</span>
                </button>
              )}

              {/* Визуализированные блоки межрепликовых пауз panelGap (Этап 5 п. 48) */}
              {gapSpans.map(gap => (
                <div
                  key={`gap-${gap.prevPanelId}-${gap.nextPanelId}`}
                  className="pointer-events-none absolute top-2 bottom-2 rounded border border-dashed border-[#34343C] bg-[#16161B]/70 flex items-center justify-center"
                  style={{
                    left: `${gap.geometry.leftPercent}%`,
                    width: `${gap.geometry.widthPercent}%`,
                  }}
                  title={formatGapTooltip(gap.duration, gap.prevPanelId)}
                >
                  {gap.geometry.widthPx >= 28 && (
                    <span className="font-mono text-[8px] text-[#666672]">
                      {gap.duration.toFixed(1)}с
                    </span>
                  )}
                </div>
              ))}

              {/* Сегменты кадров с поддержкой drag-and-drop перестановки (Этап 3.2 п. 51, п. 59) */}
              {timeline.map((seg, segIdx) => {
                const segGeom = geometry.segmentGeometry(seg.audioStart, seg.audioEnd, 1.2);
                const selected = selectedId === seg.panelId;
                const activeNow =
                  currentTime >= seg.audioStart - 1e-4 && currentTime < seg.audioEnd + 1e-4;
                const panel = panelById.get(seg.panelId);
                const fromPct = panel ? Math.round(panel.bbox.y) : 0;
                const toPct = panel ? Math.round(panel.bbox.y + panel.bbox.height) : 100;
                const isDropTarget =
                  draggedTrack === 'video' &&
                  dropHoverIndex === segIdx &&
                  draggedClipIndex !== null &&
                  draggedClipIndex !== segIdx;

                return (
                  <button
                    key={seg.panelId}
                    type="button"
                    data-video-clip-id={seg.panelId}
                    data-video-clip-panel={seg.panelId}
                    draggable={!videoLocked}
                    onPointerDown={e => {
                      if (videoLocked) return;
                      e.stopPropagation();
                      try {
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      } catch {}
                      clipDragRef.current = {
                        panelId: seg.panelId,
                        track: 'video',
                        fromIndex: segIdx,
                        hoverIndex: null,
                      };
                      setDraggedPanelId(seg.panelId);
                      setDraggedTrack('video');
                      setDraggedClipIndex(segIdx);
                    }}
                    onPointerMove={e => {
                      const cd = clipDragRef.current;
                      if (videoLocked || !cd) return;
                      if (cd.track !== 'video') {
                        cd.hoverIndex = null;
                        setDropHoverIndex(null);
                        return;
                      }
                      const trackEl = e.currentTarget.parentElement;
                      if (trackEl) {
                        const rect = trackEl.getBoundingClientRect();
                        const dropTimeRaw = geometry.trackPxToTime(e.clientX - rect.left);
                        const { targetIndex } = computeDragDropReorderTarget({
                          dropTimeRaw,
                          timeline,
                          snapTargets,
                          snapEnabled,
                        });
                        cd.hoverIndex = targetIndex;
                        setDropHoverIndex(targetIndex);
                      }
                    }}
                    onPointerUp={e => {
                      const cd = clipDragRef.current;
                      if (!cd) return;
                      e.stopPropagation();
                      clipDragRef.current = null;
                      const fromIdx = cd.fromIndex;
                      const toIdx = cd.hoverIndex ?? segIdx;
                      const validSameTrack = cd.track === 'video' && !videoLocked;
                      const panelToMove = cd.panelId;
                      setDraggedPanelId(null);
                      setDraggedTrack(null);
                      setDraggedClipIndex(null);
                      setDropHoverIndex(null);
                      if (validSameTrack && fromIdx !== toIdx) {
                        commitReorder(panelToMove, fromIdx, toIdx);
                      }
                    }}
                    onDragStart={e => {
                      if (videoLocked) {
                        e.preventDefault();
                        return;
                      }
                      setDraggedPanelId(seg.panelId);
                      setDraggedTrack('video');
                      setDraggedClipIndex(segIdx);
                      e.dataTransfer?.setData('text/plain', String(segIdx));
                    }}
                    onDragOver={e => {
                      if (videoLocked || draggedClipIndex === null) return;
                      // Игнорируем перетаскивание клипа с другой дорожки (аудио -> видео)
                      if (draggedTrack !== 'video') {
                        setDropHoverIndex(null);
                        return;
                      }
                      e.preventDefault();
                      const trackEl = e.currentTarget.parentElement;
                      if (trackEl) {
                        const rect = trackEl.getBoundingClientRect();
                        const dropTimeRaw = geometry.trackPxToTime(e.clientX - rect.left);
                        const { targetIndex } = computeDragDropReorderTarget({
                          dropTimeRaw,
                          timeline,
                          snapTargets,
                          snapEnabled,
                        });
                        setDropHoverIndex(targetIndex);
                      } else {
                        setDropHoverIndex(segIdx);
                      }
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      const fromIdx = draggedClipIndex;
                      const toIdx = dropHoverIndex ?? segIdx;
                      const validSameTrack = draggedTrack === 'video' && !videoLocked;
                      setDraggedPanelId(null);
                      setDraggedTrack(null);
                      setDraggedClipIndex(null);
                      setDropHoverIndex(null);
                      if (validSameTrack && fromIdx !== null && fromIdx !== toIdx) {
                        const draggedSeg = timeline[fromIdx];
                        if (draggedSeg) {
                          commitReorder(draggedSeg.panelId, fromIdx, toIdx);
                          setPendingDropReorder({
                            panelId: draggedSeg.panelId,
                            fromIndex: fromIdx,
                            toIndex: toIdx,
                          });
                        }
                      }
                    }}
                    onDragEnd={() => {
                      setDraggedPanelId(null);
                      setDraggedTrack(null);
                      setDraggedClipIndex(null);
                      setDropHoverIndex(null);
                    }}
                    onClick={() => {
                      if (!videoLocked) onSelectPanel(seg.panelId);
                      onSeek(seg.audioStart);
                    }}
                    className={`absolute top-1 bottom-1 overflow-hidden rounded border text-left transition-colors ${
                      isDropTarget
                        ? 'border-[#34D399] ring-2 ring-[#34D399] bg-[#164E3E] z-20'
                        : selected
                        ? 'selected border-[#F5D27A] ring-1 ring-[#E8B44C] bg-[#3A311D] z-10'
                        : activeNow
                        ? 'border-emerald-400/80 bg-[#283328]'
                        : 'border-[#34343C] bg-[#24242B] hover:border-[#77736A]'
                    }`}
                    style={{
                      left: `${segGeom.leftPercent}%`,
                      width: `${segGeom.widthPercent}%`,
                    }}
                    title={formatClipTooltip({
                      panelId: seg.panelId,
                      imageNumber: seg.imageIndex + 1,
                      audioStart: seg.audioStart,
                      audioEnd: seg.audioEnd,
                      source:
                        panel?.audioSource === 'import'
                          ? 'import'
                          : !seg.isEstimated
                          ? 'tts'
                          : 'draft',
                      fileName: panel?.audioFileName,
                      trimIn: panel?.trimIn,
                      trimOut: panel?.trimOut,
                    })}
                  >
                    {images[seg.imageIndex] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={images[seg.imageIndex]}
                        alt=""
                        className="h-full w-full object-cover opacity-75"
                      />
                    ) : (
                      <span className="text-[10px] text-[#8A8A93]">
                        Кадр {seg.imageIndex + 1}
                      </span>
                    )}
                    <span className="absolute inset-x-1 bottom-0 truncate bg-black/65 px-1 text-[9px] text-white">
                      Изображение {seg.imageIndex + 1} [{fromPct}..{toPct}%]
                    </span>
                  </button>
                );
              })}

              {/* Аутро (Этап 5 п. 49) */}
              {outroDuration > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectOutro();
                    onSeek(introOutro.outro.start);
                  }}
                  className={`absolute top-1 bottom-1 overflow-hidden rounded border px-1 text-left ${
                    selectedId === 'outro'
                      ? 'border-[#F5D27A] bg-[#594615]'
                      : 'border-[#3A321F] bg-[#2A2416]'
                  }`}
                  style={{
                    left: `${introOutro.outro.geometry.leftPercent}%`,
                    width: `${introOutro.outro.geometry.widthPercent}%`,
                  }}
                  title={`Аутро (${introOutro.outro.start.toFixed(2)}–${introOutro.outro.end.toFixed(
                    2
                  )} с)`}
                >
                  <span className="text-[10px] text-[#E8B44C]">Аутро</span>
                </button>
              )}
            </div>
          </div>

          {/* Дорожка Аудио с адаптивной высотой и визуальным различием Импорт vs TTS (Этап 5 п. 46, 47) */}
          <div className="grid grid-cols-[72px_1fr] gap-2 py-3">
            <div className="flex items-center justify-between pr-1 text-[10px] uppercase tracking-wider text-[#E8B44C]">
              <span>Аудио</span>
              <button
                type="button"
                onClick={toggleAudioLock}
                className={`px-1 rounded text-[9px] ${
                  audioLocked ? 'text-[#E8B44C] bg-[#2A2416]' : 'text-[#666672] hover:text-[#F5F5F7]'
                }`}
                title={audioLocked ? 'Разблокировать аудиодорожку' : 'Заблокировать аудиодорожку'}
                aria-label="Блокировка аудиодорожки"
              >
                {audioLocked ? '🔒' : '🔓'}
              </button>
            </div>
            <div className="relative h-20 sm:h-24 rounded-md border border-[#3A321F] bg-[#0B0B0C]">
              {introDuration > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectIntro();
                    onSeek(0);
                  }}
                  className="absolute top-1 bottom-1 rounded border border-[#3A321F] bg-[#2A2416] px-1 text-[9px] text-[#C9B27A]"
                  style={{
                    left: `${introOutro.intro.geometry.leftPercent}%`,
                    width: `${introOutro.intro.geometry.widthPercent}%`,
                  }}
                >
                  Интро
                </button>
              )}

              {timeline.map((seg, segIdx) => {
                const segGeom = geometry.segmentGeometry(seg.audioStart, seg.audioEnd, 1.2);
                const panel = panelById.get(seg.panelId);
                const hasAudio =
                  audioSet.has(seg.panelId) ||
                  (panel?.sourceAudioPanelId !== undefined &&
                    audioSet.has(panel.sourceAudioPanelId)) ||
                  !seg.isEstimated;
                const isImported = panel?.audioSource === 'import';
                const selected = selectedId === seg.panelId;
                const isSelected = selected;
                const isMuted = Boolean(panel?.muted) || (anySolo && !panel?.solo);
                const isAudioDropTarget =
                  draggedTrack === 'audio' &&
                  dropHoverIndex === segIdx &&
                  draggedClipIndex !== null &&
                  draggedClipIndex !== segIdx;

                // Визуальное различие импортированного аудио (изумрудно-бирюзовый) и TTS-аудио (золотисто-янтарный) (Этап 5 п. 47)
                // Задача 3.3.1 (п. 62): при выборе панели соответствующий аудио-клип получает класс selected
                const clipTone = isAudioDropTarget
                  ? 'border-[#34D399] ring-2 ring-[#34D399] bg-[#164E3E] z-20'
                  : isMuted
                  ? `${isSelected ? 'selected border-[#E8B44C] ' : ''}border-[#34343C] bg-[#18181C] opacity-55`
                  : isImported
                  ? isSelected
                    ? 'selected border-[#E8B44C] ring-1 ring-[#6EE7B7] bg-[#164E3E]'
                    : 'border-[#2D6A56] bg-[#113329] hover:bg-[#164235]'
                  : hasAudio
                  ? isSelected
                    ? 'selected border-[#E8B44C] ring-1 ring-[#F5D27A] bg-[#57451B]'
                    : 'border-[#806522] bg-[#332915] hover:bg-[#463719]'
                  : isSelected
                  ? 'selected border-[#E8B44C] border-dashed bg-[#2A2416]'
                  : 'border-[#34343C] border-dashed bg-[#202025] hover:border-[#77736A]';

                return (
                  <button
                    key={seg.panelId}
                    type="button"
                    data-audio-clip-id={seg.panelId}
                    data-audio-clip-panel={seg.panelId}
                    data-clip-trim-in={
                      activeTrimDrag?.panelId === seg.panelId
                        ? activeTrimDrag.previewTrimIn
                        : (panel?.trimIn ?? 0)
                    }
                    data-clip-trim-out={
                      activeTrimDrag?.panelId === seg.panelId
                        ? activeTrimDrag.previewTrimOut
                        : (panel?.trimOut ?? 0)
                    }
                    draggable={!audioLocked}
                    onPointerDown={e => {
                      if (audioLocked) return;
                      if ((e.target as HTMLElement).closest('[data-trim-handle], [role="button"]')) return;
                      e.stopPropagation();
                      try {
                        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                      } catch {}
                      clipDragRef.current = {
                        panelId: seg.panelId,
                        track: 'audio',
                        fromIndex: segIdx,
                        hoverIndex: null,
                      };
                      setDraggedPanelId(seg.panelId);
                      setDraggedTrack('audio');
                      setDraggedClipIndex(segIdx);
                    }}
                    onPointerMove={e => {
                      if (trimDragRef.current) {
                        e.stopPropagation();
                        updateActiveTrimFromClientX(e.clientX);
                        return;
                      }
                      const cd = clipDragRef.current;
                      if (audioLocked || !cd) return;
                      if (cd.track !== 'audio') {
                        cd.hoverIndex = null;
                        setDropHoverIndex(null);
                        return;
                      }
                      const trackEl = e.currentTarget.parentElement;
                      if (trackEl) {
                        const rect = trackEl.getBoundingClientRect();
                        const dropTimeRaw = geometry.trackPxToTime(e.clientX - rect.left);
                        const { targetIndex } = computeDragDropReorderTarget({
                          dropTimeRaw,
                          timeline,
                          snapTargets,
                          snapEnabled,
                        });
                        cd.hoverIndex = targetIndex;
                        setDropHoverIndex(targetIndex);
                      }
                    }}
                    onPointerUp={e => {
                      if (finishActiveTrimDrag()) {
                        e.stopPropagation();
                        return;
                      }
                      const cd = clipDragRef.current;
                      if (!cd) return;
                      e.stopPropagation();
                      clipDragRef.current = null;
                      const fromIdx = cd.fromIndex;
                      const toIdx = cd.hoverIndex ?? segIdx;
                      const validSameTrack = cd.track === 'audio' && !audioLocked;
                      const panelToMove = cd.panelId;
                      setDraggedPanelId(null);
                      setDraggedTrack(null);
                      setDraggedClipIndex(null);
                      setDropHoverIndex(null);
                      if (validSameTrack && fromIdx !== toIdx) {
                        commitReorder(panelToMove, fromIdx, toIdx);
                      }
                    }}
                    onDragStart={e => {
                      if (audioLocked) {
                        e.preventDefault();
                        return;
                      }
                      setDraggedPanelId(seg.panelId);
                      setDraggedTrack('audio');
                      setDraggedClipIndex(segIdx);
                      e.dataTransfer?.setData('text/plain', String(segIdx));
                    }}
                    onDragOver={e => {
                      if (audioLocked || draggedClipIndex === null) return;
                      // Игнорируем перетаскивание клипа с видео-дорожки на аудио-дорожку
                      if (draggedTrack !== 'audio') {
                        setDropHoverIndex(null);
                        return;
                      }
                      e.preventDefault();
                      const trackEl = e.currentTarget.parentElement;
                      if (trackEl) {
                        const rect = trackEl.getBoundingClientRect();
                        const dropTimeRaw = geometry.trackPxToTime(e.clientX - rect.left);
                        const { targetIndex } = computeDragDropReorderTarget({
                          dropTimeRaw,
                          timeline,
                          snapTargets,
                          snapEnabled,
                        });
                        setDropHoverIndex(targetIndex);
                      } else {
                        setDropHoverIndex(segIdx);
                      }
                    }}
                    onDrop={e => {
                      e.preventDefault();
                      const fromIdx = draggedClipIndex;
                      const toIdx = dropHoverIndex ?? segIdx;
                      const validSameTrack = draggedTrack === 'audio' && !audioLocked;
                      setDraggedPanelId(null);
                      setDraggedTrack(null);
                      setDraggedClipIndex(null);
                      setDropHoverIndex(null);
                      if (validSameTrack && fromIdx !== null && fromIdx !== toIdx) {
                        const draggedSeg = timeline[fromIdx];
                        if (draggedSeg) {
                          commitReorder(draggedSeg.panelId, fromIdx, toIdx);
                        }
                      }
                    }}
                    onDragEnd={() => {
                      setDraggedPanelId(null);
                      setDraggedTrack(null);
                      setDraggedClipIndex(null);
                      setDropHoverIndex(null);
                    }}
                    onClick={() => {
                      if (!audioLocked) onSelectPanel(seg.panelId);
                      onSeek(seg.audioStart);
                    }}
                    className={`group/clip absolute top-1 bottom-1 overflow-hidden rounded border px-1 text-left ${clipTone}`}
                    style={{
                      left: `${segGeom.leftPercent}%`,
                      width: `${segGeom.widthPercent}%`,
                    }}
                    title={formatClipTooltip({
                      panelId: seg.panelId,
                      imageNumber: seg.imageIndex + 1,
                      audioStart: seg.audioStart,
                      audioEnd: seg.audioEnd,
                      source: isImported ? 'import' : hasAudio ? 'tts' : 'draft',
                      fileName: panel?.audioFileName,
                      trimIn:
                        activeTrimDrag?.panelId === seg.panelId
                          ? activeTrimDrag.previewTrimIn
                          : panel?.trimIn,
                      trimOut:
                        activeTrimDrag?.panelId === seg.panelId
                          ? activeTrimDrag.previewTrimOut
                          : panel?.trimOut,
                    })}
                  >
                    {/* Левая визуальная ручка обрезки trimIn на выбранном клипе (Задача 3.2.2 п. 52) */}
                    {selected && !audioLocked && commitTrimUpdate && (
                      <span
                        role="slider"
                        aria-label={`Обрезка начала клипа #${seg.panelId}`}
                        aria-valuenow={
                          activeTrimDrag?.panelId === seg.panelId
                            ? activeTrimDrag.previewTrimIn
                            : (panel?.trimIn ?? 0)
                        }
                        tabIndex={0}
                        data-trim-handle="in"
                        title={`Потяните для обрезки начала (Trim In: ${(
                          activeTrimDrag?.panelId === seg.panelId
                            ? activeTrimDrag.previewTrimIn
                            : (panel?.trimIn ?? 0)
                        ).toFixed(2)} с)`}
                        onClick={e => e.stopPropagation()}
                        onPointerDown={e => {
                          e.stopPropagation();
                          try {
                            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                          } catch {}
                          const initIn = panel?.trimIn ?? seg.trimIn ?? 0;
                          const initOut = panel?.trimOut ?? seg.trimOut ?? 0;
                          const nextState = {
                            panelId: seg.panelId,
                            edge: 'in' as const,
                            startX: e.clientX,
                            initialTrimIn: initIn,
                            initialTrimOut: initOut,
                            segStart: seg.audioStart,
                            segEnd: seg.audioEnd,
                            previewTrimIn: initIn,
                            previewTrimOut: initOut,
                          };
                          trimDragRef.current = nextState;
                          setActiveTrimDrag(nextState);
                        }}
                        onPointerMove={e => {
                          const td = trimDragRef.current;
                          if (!td || td.panelId !== seg.panelId || td.edge !== 'in') return;
                          e.stopPropagation();
                          const pxPerSec = Math.max(1, geometry.trackWidth / geometry.safeDuration);
                          const deltaSec = (e.clientX - td.startX) / pxPerSec;
                          const updated = computeTrimHandleUpdate({
                            edge: 'in',
                            deltaSec,
                            currentTrimIn: td.initialTrimIn,
                            currentTrimOut: td.initialTrimOut,
                            segStart: td.segStart,
                            segEnd: td.segEnd,
                            snapTargets,
                            snapEnabled,
                          });
                          const nextState = {
                            ...td,
                            previewTrimIn: updated.trimIn,
                            previewTrimOut: updated.trimOut,
                          };
                          trimDragRef.current = nextState;
                          setActiveTrimDrag(nextState);
                        }}
                        onPointerUp={e => {
                          const td = trimDragRef.current;
                          if (!td || td.panelId !== seg.panelId || td.edge !== 'in') return;
                          e.stopPropagation();
                          trimDragRef.current = null;
                          commitTrimUpdate(
                            seg.panelId,
                            td.previewTrimIn,
                            td.previewTrimOut
                          );
                          setActiveTrimDrag(null);
                        }}
                        className="absolute left-0 top-0 bottom-0 z-20 w-2 cursor-ew-resize bg-[#E8B44C]/40 hover:bg-[#E8B44C] transition-colors flex items-center justify-center"
                      >
                        <span className="h-3 w-0.5 rounded bg-black/70" />
                      </span>
                    )}

                    {/* Правая визуальная ручка обрезки trimOut на выбранном клипе (Задача 3.2.2 п. 52) */}
                    {selected && !audioLocked && commitTrimUpdate && (
                      <span
                        role="slider"
                        aria-label={`Обрезка конца клипа #${seg.panelId}`}
                        aria-valuenow={
                          activeTrimDrag?.panelId === seg.panelId
                            ? activeTrimDrag.previewTrimOut
                            : (panel?.trimOut ?? 0)
                        }
                        tabIndex={0}
                        data-trim-handle="out"
                        title={`Потяните для обрезки конца (Trim Out: ${(
                          activeTrimDrag?.panelId === seg.panelId
                            ? activeTrimDrag.previewTrimOut
                            : (panel?.trimOut ?? 0)
                        ).toFixed(2)} с)`}
                        onClick={e => e.stopPropagation()}
                        onPointerDown={e => {
                          e.stopPropagation();
                          try {
                            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                          } catch {}
                          const initIn = panel?.trimIn ?? seg.trimIn ?? 0;
                          const initOut = panel?.trimOut ?? seg.trimOut ?? 0;
                          const nextState = {
                            panelId: seg.panelId,
                            edge: 'out' as const,
                            startX: e.clientX,
                            initialTrimIn: initIn,
                            initialTrimOut: initOut,
                            segStart: seg.audioStart,
                            segEnd: seg.audioEnd,
                            previewTrimIn: initIn,
                            previewTrimOut: initOut,
                          };
                          trimDragRef.current = nextState;
                          setActiveTrimDrag(nextState);
                        }}
                        onPointerMove={e => {
                          const td = trimDragRef.current;
                          if (!td || td.panelId !== seg.panelId || td.edge !== 'out') return;
                          e.stopPropagation();
                          const pxPerSec = Math.max(1, geometry.trackWidth / geometry.safeDuration);
                          const deltaSec = (e.clientX - td.startX) / pxPerSec;
                          const updated = computeTrimHandleUpdate({
                            edge: 'out',
                            deltaSec,
                            currentTrimIn: td.initialTrimIn,
                            currentTrimOut: td.initialTrimOut,
                            segStart: td.segStart,
                            segEnd: td.segEnd,
                            snapTargets,
                            snapEnabled,
                          });
                          const nextState = {
                            ...td,
                            previewTrimIn: updated.trimIn,
                            previewTrimOut: updated.trimOut,
                          };
                          trimDragRef.current = nextState;
                          setActiveTrimDrag(nextState);
                        }}
                        onPointerUp={e => {
                          const td = trimDragRef.current;
                          if (!td || td.panelId !== seg.panelId || td.edge !== 'out') return;
                          e.stopPropagation();
                          trimDragRef.current = null;
                          commitTrimUpdate(
                            seg.panelId,
                            td.previewTrimIn,
                            td.previewTrimOut
                          );
                          setActiveTrimDrag(null);
                        }}
                        className="absolute right-0 top-0 bottom-0 z-20 w-2 cursor-ew-resize bg-[#E8B44C]/40 hover:bg-[#E8B44C] transition-colors flex items-center justify-center"
                      >
                        <span className="h-3 w-0.5 rounded bg-black/70" />
                      </span>
                    )}

                    {/* Визуализация Fade In */}
                    {panel?.fadeIn && panel.fadeIn > 0 && (
                      <div
                        className="absolute inset-y-0 left-0 bg-gradient-to-r from-black/80 to-transparent pointer-events-none"
                        style={{
                          width: `${Math.min(100, ((panel.fadeIn || 0) / Math.max(0.05, seg.audioEnd - seg.audioStart)) * 100)}%`,
                        }}
                      />
                    )}
                    {/* Визуализация Fade Out */}
                    {panel?.fadeOut && panel.fadeOut > 0 && (
                      <div
                        className="absolute inset-y-0 right-0 bg-gradient-to-l from-black/80 to-transparent pointer-events-none"
                        style={{
                          width: `${Math.min(100, ((panel.fadeOut || 0) / Math.max(0.05, seg.audioEnd - seg.audioStart)) * 100)}%`,
                        }}
                      />
                    )}
                    {/* Линия громкости (Gain) */}
                    <div
                      className="absolute left-0 right-0 h-px bg-white/50 pointer-events-none"
                      style={{
                        bottom: `${Math.min(100, Math.max(0, ((panel?.gain ?? 1) / 2) * 100))}%`,
                      }}
                    />

                    <div className="flex h-full items-center gap-px px-2 opacity-90">
                      {waveform(seg.panelId, 48).map((height, i) => (
                        <i
                          key={i}
                          className={`min-w-[2px] flex-1 rounded-full ${
                            isImported
                              ? 'bg-[#34D399]'
                              : hasAudio
                              ? 'bg-[#E8B44C]'
                              : 'bg-[#666672]'
                          }`}
                          style={{ height: `${height * 76}%` }}
                        />
                      ))}
                    </div>
                    <span className="absolute left-1 top-0.5 rounded bg-black/55 px-1 font-mono text-[8px] text-[#F5F5F7]">
                      {isImported ? 'ИМПОРТ' : hasAudio ? 'TTS' : 'ЧЕРНОВИК'}
                    </span>
                    {!hasAudio && (
                      <span className="absolute inset-x-1 bottom-0 truncate bg-black/45 text-[8px] text-[#A1A1AA]">
                        нет файла
                      </span>
                    )}
                    {/* Mute / Solo переключатели (Этап 6 п. 57) */}
                    {segGeom.widthPx >= 64 && (onTogglePanelMute || onTogglePanelSolo) && (
                      <span
                        className="absolute right-1 top-0.5 flex items-center gap-0.5"
                        onClick={e => e.stopPropagation()}
                      >
                        {onTogglePanelMute && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => onTogglePanelMute(seg.panelId)}
                            className={`px-1 rounded text-[8px] font-mono ${
                              panel?.muted
                                ? 'bg-red-500/40 text-red-100'
                                : 'bg-black/50 text-[#A1A1AA] hover:text-white'
                            }`}
                            title="Mute клипа"
                          >
                            M
                          </span>
                        )}
                        {onTogglePanelSolo && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={() => onTogglePanelSolo(seg.panelId)}
                            className={`px-1 rounded text-[8px] font-mono ${
                              panel?.solo
                                ? 'bg-amber-500/50 text-amber-100'
                                : 'bg-black/50 text-[#A1A1AA] hover:text-white'
                            }`}
                            title="Solo клипа"
                          >
                            S
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}

              {outroDuration > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectOutro();
                    onSeek(introOutro.outro.start);
                  }}
                  className="absolute top-1 bottom-1 rounded border border-[#3A321F] bg-[#2A2416] px-1 text-[9px] text-[#C9B27A]"
                  style={{
                    left: `${introOutro.outro.geometry.leftPercent}%`,
                    width: `${introOutro.outro.geometry.widthPercent}%`,
                  }}
                >
                  Аутро
                </button>
              )}
            </div>
          </div>

          {/* Линия Playhead, строго привязанная к geometry.timeToContentPx(currentTime) (Этап 5 п. 41) */}
          <div
            className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-[#F5D27A] shadow-[0_0_8px_rgba(232,180,76,0.8)]"
            style={{ left: `${geometry.timeToContentPx(currentTime)}px` }}
          >
            <span className="absolute -left-1.5 -top-1 h-3 w-3 rotate-45 rounded-[2px] bg-[#F5D27A]" />
          </div>
        </div>
      </div>
    </section>
  );
}
