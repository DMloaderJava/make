/**
 * NLE-редактирование и нелинейные операции таймлайна (Этап 6, пункты 51–59):
 * 51. Изменение порядка клипов с подтверждением
 * 52. Trim in / trim out аудиоклипа с сохранением в модели
 * 53. Split аудиоклипа на два связанных сегмента
 * 54. Отдельная регулировка длительности изображения (durationOverride) при фиксированном аудио
 * 55. Ripple edit: сдвиг последующих клипов без наложений
 * 56. Блокировка дорожки (lock) видео/аудио
 * 57. Mute и Solo для аудиодорожек
 * 58. Громкость клипа (gain), fadeIn, fadeOut в Web Audio и экспорте
 * 59. Snapping к audioStart, audioEnd и границам изображений
 */

import {
  CURRENT_TIMELINE_VERSION,
  type PanelData,
  type SyncTimeline,
} from '../storage/db';
import {
  DEFAULT_PANEL_GAP,
  rebuildSrt,
  type TimelineBuildMode,
} from './buildTimeline';
import { collectSnapTargets, snapTimeToTargets } from './timelineGeometry';

export { collectSnapTargets, snapTimeToTargets };

export type TrackType = 'video' | 'audio';

export interface TrackLockState {
  videoTrackLocked?: boolean;
  audioTrackLocked?: boolean;
}

export interface NleRebuildOptions {
  voiceAssignments?: Record<string, string>;
  intro?: string;
  outro?: string;
  introDuration?: number;
  outroDuration?: number;
  panelGap?: number;
  mode?: TimelineBuildMode;
  currentTimelineVersion?: number;
  locks?: TrackLockState;
}

/**
 * Проверяет, разрешена ли операция над указанной дорожкой (Этап 6 п. 56).
 * Бросает понятную ошибку, если дорожка заблокирована.
 */
export function assertTrackUnlocked(locks: TrackLockState | undefined, track: TrackType): void {
  if (!locks) return;
  if (track === 'video' && locks.videoTrackLocked) {
    throw new Error('Видеодорожка заблокирована (Track Lock). Разблокируйте её перед редактированием.');
  }
  if (track === 'audio' && locks.audioTrackLocked) {
    throw new Error('Аудиодорожка заблокирована (Track Lock). Разблокируйте её перед редактированием.');
  }
}

export interface NleMutationResult {
  panels: PanelData[];
  audioDurations: Record<number, number>;
  timeline: SyncTimeline[];
  srt: string;
  timelineMode: TimelineBuildMode;
  timelineVersion: number;
  /** Для операции split — ID созданного второго сегмента. */
  createdPanelId?: number;
}

/**
 * Пересчитывает `SyncTimeline` и `SRT` после любой NLE-правки (Ripple Edit по умолчанию:
 * все последующие клипы автоматически сдвигаются без наложений и дыр, Этап 6 п. 55).
 */
export function applyRippleEdit(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  options: NleRebuildOptions = {}
): NleMutationResult {
  const clonedPanels = panels.map(p => ({ ...p, bbox: { ...p.bbox } }));
  const rebuilt = rebuildSrt({
    panels: clonedPanels,
    audioDurations,
    voiceAssignments: options.voiceAssignments ?? {},
    intro: options.intro ?? '',
    outro: options.outro ?? '',
    introDuration: options.introDuration ?? 0,
    outroDuration: options.outroDuration ?? 0,
    panelGap: options.panelGap ?? DEFAULT_PANEL_GAP,
    realDurations: audioDurations,
    mode: options.mode,
  });

  return {
    panels: clonedPanels,
    audioDurations: { ...audioDurations },
    timeline: rebuilt.timeline,
    srt: rebuilt.srt,
    timelineMode: rebuilt.draft ? 'draft' : 'real',
    timelineVersion: (options.currentTimelineVersion ?? CURRENT_TIMELINE_VERSION) + 1,
  };
}

/**
 * Изменяет порядок клипов/панелей (перемещает панель `panelId` на новую 0-based позицию `targetIndex`)
 * и пересчитывает `order`, `SyncTimeline` и `SRT` (Этап 6 п. 51).
 */
export function reorderPanelClips(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  targetIndex: number,
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'audio');
  const sorted = [...panels].sort((a, b) => a.order - b.order || a.id - b.id);
  const fromIndex = sorted.findIndex(p => p.id === panelId);
  if (fromIndex < 0) {
    return applyRippleEdit(panels, audioDurations, options);
  }
  const clampedTarget = Math.max(0, Math.min(sorted.length - 1, Math.floor(targetIndex)));
  if (fromIndex === clampedTarget) {
    return applyRippleEdit(sorted, audioDurations, options);
  }

  const reordered = [...sorted];
  const [moved] = reordered.splice(fromIndex, 1);
  reordered.splice(clampedTarget, 0, moved);

  const normalized = reordered.map((p, idx) => ({
    ...p,
    bbox: { ...p.bbox },
    order: idx,
  }));

  return applyRippleEdit(normalized, audioDurations, options);
}

/**
 * Устанавливает `trimIn` и `trimOut` (сек) для аудиоклипа панели и пересчитывает таймлайн (Этап 6 п. 52).
 * Гарантирует, что после обрезки остаётся минимум 0.1 с звучания.
 */
export function setPanelAudioTrim(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  trimIn: number,
  trimOut: number,
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'audio');
  const safeTrimIn = Math.max(0, Number.isFinite(trimIn) ? trimIn : 0);
  const safeTrimOut = Math.max(0, Number.isFinite(trimOut) ? trimOut : 0);
  const rawDuration = audioDurations[panelId];

  let finalTrimIn = safeTrimIn;
  let finalTrimOut = safeTrimOut;
  if (rawDuration !== undefined && Number.isFinite(rawDuration) && rawDuration > 0.1) {
    const maxTotalTrim = Math.max(0, rawDuration - 0.1);
    if (finalTrimIn + finalTrimOut > maxTotalTrim) {
      if (finalTrimIn > maxTotalTrim) {
        finalTrimIn = Number(maxTotalTrim.toFixed(3));
        finalTrimOut = 0;
      } else {
        finalTrimOut = Number(Math.max(0, maxTotalTrim - finalTrimIn).toFixed(3));
      }
    }
  }

  const nextPanels = panels.map(p =>
    p.id === panelId
      ? {
          ...p,
          bbox: { ...p.bbox },
          trimIn: Number(finalTrimIn.toFixed(3)),
          trimOut: Number(finalTrimOut.toFixed(3)),
        }
      : { ...p, bbox: { ...p.bbox } }
  );

  return applyRippleEdit(nextPanels, audioDurations, options);
}

/**
 * Разрезает аудиоклип панели `panelId` в точке `splitOffsetSec` (относительно начала видимого клипа)
 * на два связанных сегмента (Этап 6 п. 53).
 *
 * Оба сегмента ссылаются на одно исходное аудио (через `sourceAudioPanelId` и продублированную запись
 * в `audioDurations`), при этом:
 * - первый сегмент обрезается справа (`trimOut` увеличивается на длительность второй части);
 * - второй сегмент начинается с `trimIn = first.trimIn + splitOffsetSec`;
 * - если у панели задан вертикальный диапазон `bbox`, он также пропорционально делится между двумя сегментами.
 */
export function splitPanelAudioClip(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  splitOffsetSec: number,
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'audio');
  const sorted = [...panels].sort((a, b) => a.order - b.order || a.id - b.id);
  const targetIdx = sorted.findIndex(p => p.id === panelId);
  if (targetIdx < 0) {
    throw new Error(`Панель ${panelId} не найдена для разрезания (Split).`);
  }

  const target = sorted[targetIdx];
  const rawDur = audioDurations[panelId] ?? Math.max(2, Math.ceil((target.dialogue || '').length / 13));
  const curTrimIn = Math.max(0, target.trimIn ?? 0);
  const curTrimOut = Math.max(0, target.trimOut ?? 0);
  const effectiveDur = Math.max(0.2, rawDur - curTrimIn - curTrimOut);

  if (!Number.isFinite(splitOffsetSec) || splitOffsetSec <= 0.05 || splitOffsetSec >= effectiveDur - 0.05) {
    throw new Error(
      `Точка разреза (${splitOffsetSec.toFixed(2)} с) должна находиться внутри клипа (0.05..${(effectiveDur - 0.05).toFixed(2)} с).`
    );
  }

  const maxId = sorted.reduce((m, p) => Math.max(m, p.id), 0);
  const newPanelId = maxId + 1;
  const ratio = splitOffsetSec / effectiveDur;

  const firstDur = Number(splitOffsetSec.toFixed(3));
  const secondDur = Number((effectiveDur - splitOffsetSec).toFixed(3));

  const firstTrimIn = Number(curTrimIn.toFixed(3));
  const firstTrimOut = Number((curTrimOut + secondDur).toFixed(3));
  const secondTrimIn = Number((curTrimIn + firstDur).toFixed(3));
  const secondTrimOut = Number(curTrimOut.toFixed(3));

  const words = (target.dialogue || '').trim().split(/\s+/).filter(Boolean);
  let firstDialogue = target.dialogue;
  let secondDialogue = target.dialogue;
  if (words.length >= 2) {
    const splitWordIdx = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ratio)));
    firstDialogue = words.slice(0, splitWordIdx).join(' ');
    secondDialogue = words.slice(splitWordIdx).join(' ');
  }

  let firstBbox = { ...target.bbox };
  let secondBbox = { ...target.bbox };
  if (!target.fullFrame && target.bbox.height > 1) {
    const firstH = Number((target.bbox.height * ratio).toFixed(2));
    const secondH = Number((target.bbox.height - firstH).toFixed(2));
    firstBbox = { ...target.bbox, height: firstH };
    secondBbox = { ...target.bbox, y: Number((target.bbox.y + firstH).toFixed(2)), height: secondH };
  }

  const splitGroupId = target.splitGroupId ?? `split:${target.sourceAudioPanelId ?? target.id}`;

  const firstSegment: PanelData = {
    ...target,
    bbox: firstBbox,
    dialogue: firstDialogue,
    trimIn: firstTrimIn,
    trimOut: firstTrimOut,
    durationOverride: undefined,
    splitGroupId,
  };

  const secondSegment: PanelData = {
    ...target,
    id: newPanelId,
    bbox: secondBbox,
    dialogue: secondDialogue,
    trimIn: secondTrimIn,
    trimOut: secondTrimOut,
    durationOverride: undefined,
    splitGroupId,
    sourceAudioPanelId: target.sourceAudioPanelId ?? target.id,
  };

  const nextList = [...sorted];
  nextList.splice(targetIdx, 1, firstSegment, secondSegment);
  const reindexed = nextList.map((p, idx) => ({ ...p, order: idx }));

  const nextDurations: Record<number, number> = {
    ...audioDurations,
    [panelId]: rawDur,
    [newPanelId]: rawDur,
  };

  const rebuilt = applyRippleEdit(reindexed, nextDurations, options);
  return {
    ...rebuilt,
    createdPanelId: newPanelId,
  };
}

/**
 * Устанавливает независимую длительность показа изображения (`durationOverride`)
 * при фиксированном аудио (Этап 6 п. 54).
 */
export function setPanelDurationOverride(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  durationOverride: number | null | undefined,
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'video');
  const nextPanels = panels.map(p => {
    if (p.id !== panelId) return { ...p, bbox: { ...p.bbox } };
    const copy: PanelData = { ...p, bbox: { ...p.bbox } };
    if (
      durationOverride === null ||
      durationOverride === undefined ||
      !Number.isFinite(durationOverride) ||
      durationOverride <= 0
    ) {
      delete copy.durationOverride;
    } else {
      copy.durationOverride = Number(Math.max(0.1, durationOverride).toFixed(3));
    }
    return copy;
  });

  return applyRippleEdit(nextPanels, audioDurations, options);
}

/**
 * Переключает состояние `muted` для клипа панели (Этап 6 п. 57).
 */
export function togglePanelMute(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  muted?: boolean,
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'audio');
  const nextPanels = panels.map(p => {
    if (p.id !== panelId) return { ...p, bbox: { ...p.bbox } };
    const nextMuted = muted !== undefined ? muted : !p.muted;
    return { ...p, bbox: { ...p.bbox }, muted: nextMuted };
  });
  return applyRippleEdit(nextPanels, audioDurations, options);
}

/**
 * Переключает состояние `solo` для клипа панели (Этап 6 п. 57).
 */
export function togglePanelSolo(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  solo?: boolean,
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'audio');
  const nextPanels = panels.map(p => {
    if (p.id !== panelId) return { ...p, bbox: { ...p.bbox } };
    const nextSolo = solo !== undefined ? solo : !p.solo;
    return { ...p, bbox: { ...p.bbox }, solo: nextSolo };
  });
  return applyRippleEdit(nextPanels, audioDurations, options);
}

/**
 * Вычисляет, заглушена ли панель с учётом флагов `muted` и `solo` на всём таймлайне (Этап 6 п. 57).
 */
export function isClipEffectivelyMuted(
  clip: { muted?: boolean; solo?: boolean },
  allClips: ReadonlyArray<{ muted?: boolean; solo?: boolean }>
): boolean {
  if (clip.muted) return true;
  const anySolo = allClips.some(c => c.solo === true);
  if (anySolo && !clip.solo) return true;
  return false;
}

/**
 * Устанавливает громкость клипа (`gain`: 0..2) и плавное нарастание/затухание (`fadeIn`, `fadeOut` в сек)
 * (Этап 6 п. 58).
 */
export function setPanelAudioGainAndFades(
  panels: readonly PanelData[],
  audioDurations: Record<number, number>,
  panelId: number,
  params: { gain?: number; fadeIn?: number; fadeOut?: number },
  options?: NleRebuildOptions
): NleMutationResult {
  assertTrackUnlocked(options?.locks, 'audio');
  const nextPanels = panels.map(p => {
    if (p.id !== panelId) return { ...p, bbox: { ...p.bbox } };
    const next: PanelData = { ...p, bbox: { ...p.bbox } };
    if (params.gain !== undefined && Number.isFinite(params.gain)) {
      next.gain = Number(Math.max(0, Math.min(2, params.gain)).toFixed(3));
    }
    if (params.fadeIn !== undefined && Number.isFinite(params.fadeIn)) {
      next.fadeIn = Number(Math.max(0, params.fadeIn).toFixed(3));
    }
    if (params.fadeOut !== undefined && Number.isFinite(params.fadeOut)) {
      next.fadeOut = Number(Math.max(0, params.fadeOut).toFixed(3));
    }
    return next;
  });
  return applyRippleEdit(nextPanels, audioDurations, options);
}
