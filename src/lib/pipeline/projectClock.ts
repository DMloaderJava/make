/**
 * Единый источник времени проекта — ProjectClock (Этап 1 п. 1, Этап 4 п. 40, Этап 7 п. 61).
 *
 * Все операции изменения времени (seek по таймлайну, play/pause, колесо мыши и drag
 * на превью ленты, клик по миниатюре, горячие клавиши Space/J/K/L/стрелки,
 * синхронизация с HTMLAudioElement по requestAnimationFrame) меняют ТОЛЬКО ProjectClock.
 * Дочерним компонентам запрещено заводить собственные независимые таймеры времени.
 */

import type { PanelData, SyncTimeline } from '../storage/db';

export type ClockChangeReason =
  | 'init'
  | 'seek'
  | 'play'
  | 'pause'
  | 'wheel'
  | 'drag'
  | 'hotkey'
  | 'audio'
  | 'raf'
  | 'thumbnail'
  | 'inspector'
  | 'duration-change'
  | 'ended';

export interface ProjectClockState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  playbackRate: number;
  reason: ClockChangeReason;
}

export type ProjectClockListener = (state: ProjectClockState) => void;

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || time < 0) return 0;
  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  return Math.min(max, time);
}

export class ProjectClock {
  private state: ProjectClockState;
  private listeners = new Set<ProjectClockListener>();

  constructor(initial?: Partial<Pick<ProjectClockState, 'currentTime' | 'duration' | 'isPlaying' | 'playbackRate'>>) {
    const duration = initial?.duration !== undefined && Number.isFinite(initial.duration) && initial.duration >= 0
      ? initial.duration
      : 0;
    this.state = {
      currentTime: clampTime(initial?.currentTime ?? 0, duration),
      duration,
      isPlaying: Boolean(initial?.isPlaying),
      playbackRate: initial?.playbackRate && Number.isFinite(initial.playbackRate)
        ? Math.max(0.25, Math.min(4, initial.playbackRate))
        : 1,
      reason: 'init',
    };
  }

  getState(): ProjectClockState {
    return { ...this.state };
  }

  getTime(): number {
    return this.state.currentTime;
  }

  getDuration(): number {
    return this.state.duration;
  }

  getIsPlaying(): boolean {
    return this.state.isPlaying;
  }

  getPlaybackRate(): number {
    return this.state.playbackRate;
  }

  seek(time: number, reason: ClockChangeReason = 'seek'): number {
    if (!Number.isFinite(time)) return this.state.currentTime;
    const clamped = clampTime(time, this.state.duration);
    this.state = {
      ...this.state,
      currentTime: clamped,
      reason,
    };
    this.emit();
    return clamped;
  }

  seekRelative(deltaSeconds: number, reason: ClockChangeReason = 'hotkey'): number {
    if (!Number.isFinite(deltaSeconds)) return this.state.currentTime;
    return this.seek(this.state.currentTime + deltaSeconds, reason);
  }

  play(reason: ClockChangeReason = 'play'): void {
    if (this.state.duration <= 0) return;
    // Если стоим в самом конце — начинаем сначала
    const nextTime = this.state.currentTime >= this.state.duration - 1e-4 ? 0 : this.state.currentTime;
    this.state = {
      ...this.state,
      currentTime: nextTime,
      isPlaying: true,
      reason,
    };
    this.emit();
  }

  pause(reason: ClockChangeReason = 'pause'): void {
    if (!this.state.isPlaying && reason === 'pause') return;
    this.state = {
      ...this.state,
      isPlaying: false,
      reason,
    };
    this.emit();
  }

  toggle(reason: ClockChangeReason = 'play'): boolean {
    if (this.state.isPlaying) {
      this.pause('pause');
      return false;
    }
    this.play(reason);
    return true;
  }

  togglePlayPause(reason: ClockChangeReason = 'play'): boolean {
    return this.toggle(reason);
  }

  reset(time = 0): void {
    this.state = {
      ...this.state,
      currentTime: clampTime(time, this.state.duration),
      isPlaying: false,
      reason: 'init',
    };
    this.emit();
  }

  setPlaybackRate(rate: number): number {
    if (!Number.isFinite(rate) || rate <= 0) return this.state.playbackRate;
    const clamped = Math.max(0.25, Math.min(4, rate));
    this.state = {
      ...this.state,
      playbackRate: clamped,
    };
    this.emit();
    return clamped;
  }

  setDuration(duration: number): void {
    const safeDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
    const clampedTime = clampTime(this.state.currentTime, safeDuration);
    const shouldStop = safeDuration <= 0 || clampedTime >= safeDuration;
    this.state = {
      ...this.state,
      duration: safeDuration,
      currentTime: clampedTime,
      isPlaying: shouldStop ? false : this.state.isPlaying,
      reason: 'duration-change',
    };
    this.emit();
  }

  /**
   * Продвигает часы на `dtSeconds` (с учётом `playbackRate`).
   * Если достигнут конец `duration`, автоматически ставит на паузу с `reason: 'ended'`.
   */
  tick(dtSeconds: number, reason: ClockChangeReason = 'raf'): number {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0 || this.state.duration <= 0) {
      return this.state.currentTime;
    }
    const next = this.state.currentTime + dtSeconds * this.state.playbackRate;
    if (next >= this.state.duration) {
      this.state = {
        ...this.state,
        currentTime: this.state.duration,
        isPlaying: false,
        reason: 'ended',
      };
      this.emit();
      return this.state.duration;
    }
    this.state = {
      ...this.state,
      currentTime: next,
      reason,
    };
    this.emit();
    return next;
  }

  subscribe(listener: ProjectClockListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

export interface ActiveTimelineMoment {
  phase: 'intro' | 'panel' | 'gap' | 'outro';
  /** Сегмент, звучащий прямо сейчас (null на интро, аутро и в паузе между панелями). */
  activeSegment: SyncTimeline | null;
  /** Сегмент для отображения кадра (в паузе удерживается предыдущая панель). */
  displaySegment: SyncTimeline | null;
  /** ID активной панели (null, если интро или аутро). */
  activePanelId: number | null;
  /** Индекс панели в массиве `panels` (-1, если нет). */
  activePanelIndex: number;
  /** Единый идентификатор активного аудиоклипа: 'intro' | 'outro' | 'panel:<id>' | null. */
  activeClipId: string | null;
  /** Если сейчас пауза (gap) между двумя сегментами — границы паузы. */
  gapSpan: { from: number; to: number; prevPanelId: number; nextPanelId: number } | null;
}

/**
 * Вычисляет активный момент на таймлайне по `currentTime` (Этап 1, Этап 7 п. 61).
 * Используется единообразно в Preview, Timeline и аудиоплеере.
 */
export function resolveActiveTimelineMoment(
  timeline: readonly SyncTimeline[],
  panels: readonly PanelData[],
  currentTime: number,
  introDuration: number,
  outroDuration: number
): ActiveTimelineMoment {
  const t = Math.max(0, Number.isFinite(currentTime) ? currentTime : 0);
  const safeIntro = Math.max(0, Number.isFinite(introDuration) ? introDuration : 0);
  const lastEnd = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : safeIntro;

  if (t < safeIntro) {
    const firstSeg = timeline[0] ?? null;
    const firstIdx = firstSeg ? panels.findIndex(p => p.id === firstSeg.panelId) : (panels.length > 0 ? 0 : -1);
    return {
      phase: 'intro',
      activeSegment: null,
      displaySegment: firstSeg,
      activePanelId: null,
      activePanelIndex: firstIdx,
      activeClipId: 'intro',
      gapSpan: null,
    };
  }

  if (t >= lastEnd) {
    const lastSeg = timeline[timeline.length - 1] ?? null;
    const lastIdx = lastSeg ? panels.findIndex(p => p.id === lastSeg.panelId) : (panels.length > 0 ? panels.length - 1 : -1);
    if (outroDuration > 0 || !lastSeg) {
      return {
        phase: 'outro',
        activeSegment: null,
        displaySegment: lastSeg,
        activePanelId: null,
        activePanelIndex: lastIdx,
        activeClipId: 'outro',
        gapSpan: null,
      };
    }
    // Итерация 2.1 (Б3, P1 п. 12): при t >= lastEnd и outroDuration === 0 явно удерживаем последний сегмент
    return {
      phase: 'panel',
      activeSegment: null,
      displaySegment: lastSeg,
      activePanelId: lastSeg.panelId,
      activePanelIndex: lastIdx >= 0 ? lastIdx : 0,
      activeClipId: null,
      gapSpan: null,
    };
  }

  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    if (t >= seg.audioStart - 1e-6 && t < seg.audioEnd) {
      const idx = panels.findIndex(p => p.id === seg.panelId);
      return {
        phase: 'panel',
        activeSegment: seg,
        displaySegment: seg,
        activePanelId: seg.panelId,
        activePanelIndex: idx >= 0 ? idx : 0,
        activeClipId: `panel:${seg.panelId}`,
        gapSpan: null,
      };
    }

    const next = timeline[i + 1];
    if (next && t >= seg.audioEnd - 1e-6 && t < next.audioStart - 1e-6) {
      const idx = panels.findIndex(p => p.id === seg.panelId);
      return {
        phase: 'gap',
        activeSegment: null,
        displaySegment: seg,
        activePanelId: seg.panelId,
        activePanelIndex: idx >= 0 ? idx : 0,
        activeClipId: null,
        gapSpan: {
          from: seg.audioEnd,
          to: next.audioStart,
          prevPanelId: seg.panelId,
          nextPanelId: next.panelId,
        },
      };
    }
  }

  const fallbackSeg = timeline[timeline.length - 1] ?? null;
  const fallbackIdx = fallbackSeg ? panels.findIndex(p => p.id === fallbackSeg.panelId) : -1;
  return {
    phase: fallbackSeg ? 'panel' : 'outro',
    activeSegment: fallbackSeg,
    displaySegment: fallbackSeg,
    activePanelId: fallbackSeg?.panelId ?? null,
    activePanelIndex: fallbackIdx,
    activeClipId: fallbackSeg ? `panel:${fallbackSeg.panelId}` : null,
    gapSpan: null,
  };
}
