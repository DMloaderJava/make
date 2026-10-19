import type { SyncTimeline } from '../storage/db';
import { snapTimeToTargets, type SnapTarget } from './timelineGeometry';

export type TimelineTrackKind = 'video' | 'audio';

/**
 * Вычисляет целевой индекс клипа при перетаскивании (drag-and-drop) на таймлайне
 * с магнитной привязкой к границам сегментов `snapTimeToTargets` (Этап 3.2, п. 51 и п. 59).
 */
export function computeDragDropReorderTarget(params: {
  dropTimeRaw: number;
  timeline: readonly SyncTimeline[];
  snapTargets: readonly SnapTarget[];
  snapEnabled: boolean;
  toleranceSec?: number;
}): { snappedTime: number; targetIndex: number } {
  const { dropTimeRaw, timeline, snapTargets, snapEnabled, toleranceSec = 0.15 } = params;
  const snapped = snapEnabled
    ? snapTimeToTargets(dropTimeRaw, snapTargets, toleranceSec).time
    : dropTimeRaw;

  if (timeline.length <= 1) {
    return { snappedTime: snapped, targetIndex: 0 };
  }

  for (let i = 0; i < timeline.length; i++) {
    if (snapped >= timeline[i].audioStart - 1e-6 && snapped <= timeline[i].audioEnd + 1e-6) {
      return { snappedTime: snapped, targetIndex: i };
    }
  }

  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < timeline.length; i++) {
    const mid = (timeline[i].audioStart + timeline[i].audioEnd) / 2;
    const d = Math.abs(snapped - mid);
    if (d <= bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return { snappedTime: snapped, targetIndex: bestIdx };
}

/**
 * Вычисляет обновлённые значения `trimIn` и `trimOut` при перетаскивании визуальной
 * ручки обрезки на аудиоклипе таймлайна с поддержкой привязки `snapTimeToTargets` (Этап 3.2, п. 52 и п. 59).
 */
export function computeTrimHandleUpdate(params: {
  edge: 'in' | 'out';
  deltaSec: number;
  currentTrimIn: number;
  currentTrimOut: number;
  segStart: number;
  segEnd: number;
  snapTargets: readonly SnapTarget[];
  snapEnabled: boolean;
  toleranceSec?: number;
}): { trimIn: number; trimOut: number; snappedEdgeTime: number } {
  const {
    edge,
    deltaSec,
    currentTrimIn,
    currentTrimOut,
    segStart,
    segEnd,
    snapTargets,
    snapEnabled,
    toleranceSec = 0.1,
  } = params;

  const segSpan = Math.max(0.1, segEnd - segStart);
  const maxTotalTrim = Math.max(0, currentTrimIn + currentTrimOut + segSpan - 0.1);

  if (edge === 'in') {
    const rawEdgeTime = segStart + deltaSec;
    const otherTargets = snapTargets.filter(t => Math.abs(t.time - segStart) > 1e-4);
    const snappedEdgeTime = snapEnabled
      ? snapTimeToTargets(rawEdgeTime, otherTargets, toleranceSec).time
      : rawEdgeTime;
    const appliedDelta = snappedEdgeTime - segStart;
    const nextTrimIn = Number(
      Math.max(0, Math.min(maxTotalTrim - currentTrimOut, currentTrimIn + appliedDelta)).toFixed(2)
    );
    return {
      trimIn: nextTrimIn,
      trimOut: Number(currentTrimOut.toFixed(2)),
      snappedEdgeTime,
    };
  }

  const rawEdgeTime = segEnd + deltaSec;
  const otherTargets = snapTargets.filter(t => Math.abs(t.time - segEnd) > 1e-4);
  const snappedEdgeTime = snapEnabled
    ? snapTimeToTargets(rawEdgeTime, otherTargets, toleranceSec).time
    : rawEdgeTime;
  const appliedDelta = segEnd - snappedEdgeTime;
  const nextTrimOut = Number(
    Math.max(0, Math.min(maxTotalTrim - currentTrimIn, currentTrimOut + appliedDelta)).toFixed(2)
  );
  return {
    trimIn: Number(currentTrimIn.toFixed(2)),
    trimOut: nextTrimOut,
    snappedEdgeTime,
  };
}

export interface TimelinePointerControllerCallbacks {
  onReorderPanel?: (panelId: number, targetIndex: number) => void;
  onTrimPanel?: (panelId: number, trimIn: number, trimOut: number) => void;
}

/**
 * Контроллер pointer-событий перетаскивания клипов (п. 51) и ручек обрезки (п. 52).
 * Позволяет детерминированно тестировать последовательность pointerdown -> pointermove -> pointerup
 * как в браузерном окружении, так и в unit-тестах Node (`tsx --test`) без зависимости от `"use client"`.
 */
export function createTimelinePointerController(callbacks: TimelinePointerControllerCallbacks) {
  let clipDrag: {
    panelId: number;
    track: TimelineTrackKind;
    fromIndex: number;
    hoverIndex: number | null;
  } | null = null;

  let trimDrag: {
    panelId: number;
    edge: 'in' | 'out';
    startX: number;
    initialTrimIn: number;
    initialTrimOut: number;
    segStart: number;
    segEnd: number;
    previewTrimIn: number;
    previewTrimOut: number;
  } | null = null;

  return {
    getClipDragState: () => clipDrag,
    getTrimDragState: () => trimDrag,

    pointerDownClip(params: {
      panelId: number;
      track: TimelineTrackKind;
      clipIndex: number;
      locked?: boolean;
    }): boolean {
      if (params.locked) return false;
      clipDrag = {
        panelId: params.panelId,
        track: params.track,
        fromIndex: params.clipIndex,
        hoverIndex: null,
      };
      return true;
    },

    pointerMoveClip(params: {
      overTrack: TimelineTrackKind;
      dropTimeRaw: number;
      timeline: readonly SyncTimeline[];
      snapTargets: readonly SnapTarget[];
      snapEnabled: boolean;
      locked?: boolean;
    }): number | null {
      if (!clipDrag || params.locked) return null;
      if (clipDrag.track !== params.overTrack) {
        clipDrag.hoverIndex = null;
        return null;
      }
      const { targetIndex } = computeDragDropReorderTarget({
        dropTimeRaw: params.dropTimeRaw,
        timeline: params.timeline,
        snapTargets: params.snapTargets,
        snapEnabled: params.snapEnabled,
      });
      clipDrag.hoverIndex = targetIndex;
      return targetIndex;
    },

    pointerUpClip(params: {
      overTrack: TimelineTrackKind;
      fallbackIndex?: number;
      locked?: boolean;
    }): { reordered: boolean; panelId?: number; fromIndex?: number; toIndex?: number } {
      if (!clipDrag) return { reordered: false };
      const current = clipDrag;
      clipDrag = null;
      if (params.locked || current.track !== params.overTrack) {
        return { reordered: false };
      }
      const toIndex = current.hoverIndex ?? params.fallbackIndex ?? current.fromIndex;
      if (toIndex === current.fromIndex) {
        return { reordered: false };
      }
      callbacks.onReorderPanel?.(current.panelId, toIndex);
      return {
        reordered: true,
        panelId: current.panelId,
        fromIndex: current.fromIndex,
        toIndex,
      };
    },

    pointerDownTrimHandle(params: {
      panelId: number;
      edge: 'in' | 'out';
      clientX: number;
      initialTrimIn: number;
      initialTrimOut: number;
      segStart: number;
      segEnd: number;
      locked?: boolean;
    }): boolean {
      if (params.locked) return false;
      trimDrag = {
        panelId: params.panelId,
        edge: params.edge,
        startX: params.clientX,
        initialTrimIn: params.initialTrimIn,
        initialTrimOut: params.initialTrimOut,
        segStart: params.segStart,
        segEnd: params.segEnd,
        previewTrimIn: params.initialTrimIn,
        previewTrimOut: params.initialTrimOut,
      };
      return true;
    },

    pointerMoveTrimHandle(params: {
      panelId: number;
      edge: 'in' | 'out';
      clientX: number;
      trackWidth: number;
      safeDuration: number;
      snapTargets: readonly SnapTarget[];
      snapEnabled: boolean;
    }): { trimIn: number; trimOut: number } | null {
      if (!trimDrag || trimDrag.panelId !== params.panelId || trimDrag.edge !== params.edge) {
        return null;
      }
      const pxPerSec = Math.max(1, params.trackWidth / Math.max(0.1, params.safeDuration));
      const deltaSec = (params.clientX - trimDrag.startX) / pxPerSec;
      const updated = computeTrimHandleUpdate({
        edge: params.edge,
        deltaSec,
        currentTrimIn: trimDrag.initialTrimIn,
        currentTrimOut: trimDrag.initialTrimOut,
        segStart: trimDrag.segStart,
        segEnd: trimDrag.segEnd,
        snapTargets: params.snapTargets,
        snapEnabled: params.snapEnabled,
      });
      trimDrag.previewTrimIn = updated.trimIn;
      trimDrag.previewTrimOut = updated.trimOut;
      return { trimIn: updated.trimIn, trimOut: updated.trimOut };
    },

    pointerUpTrimHandle(params: {
      panelId: number;
      edge: 'in' | 'out';
    }): { committed: boolean; panelId?: number; trimIn?: number; trimOut?: number } {
      if (!trimDrag || trimDrag.panelId !== params.panelId || trimDrag.edge !== params.edge) {
        return { committed: false };
      }
      const current = trimDrag;
      trimDrag = null;
      callbacks.onTrimPanel?.(current.panelId, current.previewTrimIn, current.previewTrimOut);
      return {
        committed: true,
        panelId: current.panelId,
        trimIn: current.previewTrimIn,
        trimOut: current.previewTrimOut,
      };
    },
  };
}
