/**
 * Единый аудиоплеер для Preview и Timeline + диагностика ошибок HTMLMediaElement + WAV fallback
 * (Этап 3, пункты 22, 25–29; Этап 6, пункты 52, 57, 58).
 */

import type { SyncTimeline } from '../storage/db';
import { ObjectUrlRegistry, sharedObjectUrlRegistry } from './objectUrlRegistry';
import { ProjectClock } from './projectClock';
import { pcmToWav } from '../providers/tts/wav';

export type AudioPlaybackStatus =
  | 'idle'
  | 'loading'
  | 'canplay'
  | 'playing'
  | 'paused'
  | 'waiting'
  | 'stalled'
  | 'ended'
  | 'error';

export type MediaErrorKind =
  | 'format'
  | 'decode'
  | 'autoplay'
  | 'network'
  | 'missing-blob'
  | 'aborted'
  | 'unknown';

export interface FormattedMediaError {
  kind: MediaErrorKind;
  panelLabel: string;
  mime: string;
  message: string;
}

export interface MediaErrorContext {
  slotKey?: string;
  panelId?: number | 'intro' | 'outro';
  mime?: string;
  fileName?: string;
}

function resolvePanelLabel(ctx: MediaErrorContext): string {
  if (ctx.panelId === 'intro' || ctx.slotKey === 'intro') return 'интро';
  if (ctx.panelId === 'outro' || ctx.slotKey === 'outro') return 'аутро';
  if (typeof ctx.panelId === 'number') return `панель ${ctx.panelId}`;
  if (ctx.slotKey?.startsWith('panel:')) return `панель ${ctx.slotKey.slice(6)}`;
  return 'дорожка аудио';
}

/**
 * Человекочитаемая расшифровка ошибок HTMLMediaElement и Promise.reject при play()
 * (Этап 3 п. 25): обязательно включает панель и MIME-тип.
 */
export function formatMediaElementError(
  error: unknown,
  ctx: MediaErrorContext = {}
): FormattedMediaError {
  const panelLabel = resolvePanelLabel(ctx);
  const mime = (ctx.mime || 'неизвестный MIME').trim() || 'неизвестный MIME';
  const fileNote = ctx.fileName ? ` («${ctx.fileName}»)` : '';

  if (!error) {
    return {
      kind: 'missing-blob',
      panelLabel,
      mime,
      message: `Аудио для ${panelLabel}${fileNote} отсутствует в хранилище (MIME: ${mime}). Озвучьте панель или импортируйте файл заново.`,
    };
  }

  const errObj = error as { code?: number; name?: string; message?: string };
  const name = errObj.name || '';
  const code = errObj.code;

  if (name === 'NotAllowedError') {
    return {
      kind: 'autoplay',
      panelLabel,
      mime,
      message: `Автовоспроизведение заблокировано браузером для ${panelLabel}${fileNote} (MIME: ${mime}). Нажмите кнопку Play повторно.`,
    };
  }

  if (name === 'AbortError' || code === 1) {
    return {
      kind: 'aborted',
      panelLabel,
      mime,
      message: `Воспроизведение ${panelLabel}${fileNote} (MIME: ${mime}) было прервано пользователем или переключением дорожки.`,
    };
  }

  if (code === 2) {
    return {
      kind: 'network',
      panelLabel,
      mime,
      message: `Сетевая ошибка или сбой чтения Blob при загрузке ${panelLabel}${fileNote} (MIME: ${mime}).`,
    };
  }

  if (code === 3) {
    return {
      kind: 'decode',
      panelLabel,
      mime,
      message: `Ошибка декодирования аудио для ${panelLabel}${fileNote} (MIME: ${mime}) — файл повреждён или обрезан.`,
    };
  }

  if (code === 4 || name === 'NotSupportedError') {
    return {
      kind: 'format',
      panelLabel,
      mime,
      message: `Формат аудио для ${panelLabel}${fileNote} не поддерживается браузером (MIME: ${mime}). Используйте WAV или MP3.`,
    };
  }

  return {
    kind: 'unknown',
    panelLabel,
    mime,
    message: `Не удалось воспроизвести аудио для ${panelLabel}${fileNote} (MIME: ${mime}): ${errObj.message || String(error)}`,
  };
}

/**
 * Конвертирует декодированный AudioBuffer (или канальные Float32Array) в стандартный
 * PCM 16-bit WAV Blob (Этап 3 п. 22: fallback для нестандартных контейнеров).
 */
export function convertAudioBufferToWavBlob(buffer: {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
}): Blob {
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate || 44100;
  const pcm = new ArrayBuffer(buffer.length * channels * 2);
  const view = new DataView(pcm);
  let offset = 0;

  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i] ?? 0));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  const wavBuffer = pcmToWav(pcm, { sampleRate, channels, bitsPerSample: 16 });
  return new Blob([wavBuffer], { type: 'audio/wav' });
}

export interface AudioPlayerSlot {
  key: string;
  panelId?: number | 'intro' | 'outro';
  blob: Blob;
  timelineStart: number;
  timelineEnd: number;
  trimIn: number;
  trimOut: number;
  muted: boolean;
  volume: number;
}

export interface AudioLikeElement {
  src: string;
  currentTime: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  paused: boolean;
  preload: string;
  error?: { code?: number; message?: string } | null;
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onwaiting: (() => void) | null;
  onstalled: (() => void) | null;
  oncanplay: (() => void) | null;
  onloadedmetadata: (() => void) | null;
}

export interface UnifiedAudioPlayerOptions {
  clock: ProjectClock;
  registry?: ObjectUrlRegistry;
  createAudio?: () => AudioLikeElement;
  requestFrame?: (cb: (now: number) => void) => number;
  cancelFrame?: (id: number) => void;
  now?: () => number;
  onStatusChange?: (status: AudioPlaybackStatus, activeKey: string | null) => void;
  onError?: (formatted: FormattedMediaError) => void;
}

/**
 * Вычисляет, какой слот аудио должен звучать в момент `time`, с учётом `solo` и `muted`
 * (Этап 3 п. 26, Этап 6 п. 52, 57, 58).
 */
export function resolveAudioSlotAtTime(params: {
  time: number;
  timeline: readonly SyncTimeline[];
  introDuration: number;
  outroDuration: number;
  introAudio?: Blob | null;
  outroAudio?: Blob | null;
  panelBlobs: ReadonlyMap<number, Blob>;
}): AudioPlayerSlot | null {
  const { time, timeline, introDuration, outroDuration, introAudio, outroAudio, panelBlobs } = params;
  const hasSolo = timeline.some(s => s.solo === true);

  if (time < introDuration) {
    if (!introAudio) return null;
    return {
      key: 'intro',
      panelId: 'intro',
      blob: introAudio,
      timelineStart: 0,
      timelineEnd: introDuration,
      trimIn: 0,
      trimOut: 0,
      muted: hasSolo,
      volume: 1,
    };
  }

  const seg = timeline.find(s => time >= s.audioStart && time < s.audioEnd);
  if (seg) {
    const blob = panelBlobs.get(seg.panelId);
    if (!blob) return null;
    const isMuted = Boolean(seg.muted) || (hasSolo && !seg.solo);
    const gain = seg.gain !== undefined && Number.isFinite(seg.gain) ? Math.max(0, Math.min(1, seg.gain)) : 1;
    return {
      key: `panel:${seg.panelId}`,
      panelId: seg.panelId,
      blob,
      timelineStart: seg.audioStart,
      timelineEnd: seg.audioEnd,
      trimIn: Math.max(0, seg.trimIn ?? 0),
      trimOut: Math.max(0, seg.trimOut ?? 0),
      muted: isMuted,
      volume: gain,
    };
  }

  const outroStart = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : introDuration;
  if (time >= outroStart && time < outroStart + outroDuration && outroAudio) {
    return {
      key: 'outro',
      panelId: 'outro',
      blob: outroAudio,
      timelineStart: outroStart,
      timelineEnd: outroStart + outroDuration,
      trimIn: 0,
      trimOut: 0,
      muted: hasSolo,
      volume: 1,
    };
  }

  return null;
}

/**
 * Единый аудиоплеер для Preview и Timeline (Этап 3, п. 26–29):
 * - использует ровно один экземпляр Audio (никаких конкурирующих плееров);
 * - синхронизирует ProjectClock через requestAnimationFrame;
 * - обрабатывает canplay / waiting / stalled / ended / error;
 * - при seek внутри того же сегмента меняет только audio.currentTime, не пересоздавая ObjectURL.
 */
export class UnifiedAudioPlayer {
  private clock: ProjectClock;
  private registry: ObjectUrlRegistry;
  private createAudio: () => AudioLikeElement;
  private requestFrame: (cb: (now: number) => void) => number;
  private cancelFrame: (id: number) => void;
  private nowFn: () => number;
  private onStatusChange?: (status: AudioPlaybackStatus, activeKey: string | null) => void;
  private onError?: (formatted: FormattedMediaError) => void;

  private audio: AudioLikeElement | null = null;
  private activeSlot: AudioPlayerSlot | null = null;
  private activeUrl: string | null = null;
  private status: AudioPlaybackStatus = 'idle';
  private rafId: number | null = null;
  private lastWallMs = 0;
  private lastAudioTime = 0;
  private lastAudioWall = 0;
  private lastElementRawTime = -1;
  private lastSyncParams: {
    timeline: readonly SyncTimeline[];
    introDuration: number;
    outroDuration: number;
    introAudio?: Blob | null;
    outroAudio?: Blob | null;
    panelBlobs: ReadonlyMap<number, Blob>;
    onSegmentEnded?: (nextTime: number) => void;
  } | null = null;

  constructor(options: UnifiedAudioPlayerOptions) {
    this.clock = options.clock;
    this.registry = options.registry ?? sharedObjectUrlRegistry;
    this.createAudio = options.createAudio ?? (() => new Audio() as unknown as AudioLikeElement);
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.nowFn = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;
  }

  getStatus(): AudioPlaybackStatus {
    return this.status;
  }

  getActiveKey(): string | null {
    return this.activeSlot?.key ?? null;
  }

  getActiveUrl(): string | null {
    return this.activeUrl;
  }

  private setStatus(next: AudioPlaybackStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatusChange?.(next, this.activeSlot?.key ?? null);
  }

  private ensureAudioElement(): AudioLikeElement {
    if (!this.audio) {
      this.audio = this.createAudio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  /**
   * Seek внутри текущего или нового сегмента (Этап 3 п. 29):
   * если целевое время попадает в уже загруженный слот с тем же Blob,
   * меняем ТОЛЬКО `audio.currentTime` без пересоздания ObjectURL и без сброса буфера.
   */
  seekTo(
    time: number,
    slot: AudioPlayerSlot | null,
    smallMoveThresholdSec = 0.02
  ): { reusedUrl: boolean; seekedInPlace: boolean } {
    this.clock.seek(time, 'seek');

    if (
      this.audio &&
      this.activeSlot &&
      slot &&
      this.activeSlot.key === slot.key &&
      this.activeSlot.blob === slot.blob
    ) {
      const targetAudioTime = slot.trimIn + Math.max(0, time - slot.timelineStart);
      if (Math.abs(this.audio.currentTime - targetAudioTime) >= smallMoveThresholdSec) {
        this.audio.currentTime = targetAudioTime;
      }
      return { reusedUrl: true, seekedInPlace: true };
    }

    if (!slot) {
      this.stopActiveAudio(false);
      return { reusedUrl: false, seekedInPlace: false };
    }

    return { reusedUrl: false, seekedInPlace: false };
  }

  /**
   * Запускает или синхронизирует воспроизведение слота.
   */
  async syncPlayback(params: {
    timeline: readonly SyncTimeline[];
    introDuration: number;
    outroDuration: number;
    introAudio?: Blob | null;
    outroAudio?: Blob | null;
    panelBlobs: ReadonlyMap<number, Blob>;
    onSegmentEnded?: (nextTime: number) => void;
  }): Promise<void> {
    this.lastSyncParams = params;
    if (!this.clock.getIsPlaying()) {
      this.pause();
      return;
    }

    const currentTime = this.clock.getTime();
    const duration = this.clock.getDuration();
    if (duration <= 0 || currentTime >= duration) {
      this.stop();
      return;
    }

    const slot = resolveAudioSlotAtTime({
      time: currentTime,
      timeline: params.timeline,
      introDuration: params.introDuration,
      outroDuration: params.outroDuration,
      introAudio: params.introAudio,
      outroAudio: params.outroAudio,
      panelBlobs: params.panelBlobs,
    });

    if (slot) {
      const audio = this.ensureAudioElement();
      const sameSlot =
        this.activeSlot?.key === slot.key &&
        this.activeSlot?.blob === slot.blob &&
        this.activeUrl !== null;

      if (!sameSlot) {
        if (this.activeSlot && this.activeSlot.key !== slot.key) {
          this.registry.revokeByKey(this.activeSlot.key);
        }
        const { url } = this.registry.acquire(slot.key, slot.blob);
        this.activeSlot = slot;
        this.activeUrl = url;
        this.setStatus('loading');
        audio.src = url;
      } else {
        this.activeSlot = slot;
      }

      audio.muted = slot.muted;
      audio.volume = slot.volume;
      audio.playbackRate = this.clock.getPlaybackRate();

      const offsetInSlot = slot.trimIn + Math.max(0, currentTime - slot.timelineStart);
      if (Math.abs(audio.currentTime - offsetInSlot) > 0.08 || !sameSlot) {
        try {
          audio.currentTime = offsetInSlot;
        } catch {}
      }

      const now = this.lastWallMs > 0 ? this.lastWallMs : this.nowFn();
      this.lastWallMs = now;
      this.lastAudioTime = currentTime;
      this.lastAudioWall = now;
      this.lastElementRawTime = audio.currentTime;

      audio.onloadedmetadata = () => {
        if (this.activeSlot?.key !== slot.key) return;
        const offset = slot.trimIn + Math.max(0, this.clock.getTime() - slot.timelineStart);
        if (Number.isFinite(offset) && Math.abs(audio.currentTime - offset) > 0.05) {
          try {
            audio.currentTime = offset;
          } catch {}
        }
      };

      audio.oncanplay = () => {
        if (this.activeSlot?.key !== slot.key) return;
        if (this.status === 'loading' || this.status === 'waiting' || this.status === 'stalled') {
          this.setStatus(this.clock.getIsPlaying() ? 'playing' : 'canplay');
        }
      };

      audio.onwaiting = () => {
        if (this.activeSlot?.key !== slot.key) return;
        this.setStatus('waiting');
      };

      audio.onstalled = () => {
        if (this.activeSlot?.key !== slot.key) return;
        this.setStatus('stalled');
      };

      audio.onerror = () => {
        if (this.activeSlot?.key !== slot.key) return;
        const formatted = formatMediaElementError(audio.error || new Error('Media error'), {
          slotKey: slot.key,
          panelId: slot.panelId,
          mime: slot.blob.type,
        });
        this.setStatus('error');
        this.clock.pause('pause');
        this.stopRaf();
        this.onError?.(formatted);
      };

      audio.onended = () => {
        if (this.activeSlot?.key !== slot.key) return;
        this.handleSlotFinished(slot, params);
      };

      try {
        await audio.play();
        this.setStatus('playing');
        this.startAudioRaf(slot, params);
      } catch (err) {
        const formatted = formatMediaElementError(err, {
          slotKey: slot.key,
          panelId: slot.panelId,
          mime: slot.blob.type,
        });
        this.setStatus('error');
        this.clock.pause('pause');
        this.stopRaf();
        this.onError?.(formatted);
      }
      return;
    }

    // Слот без аудио (пауза между репликами или неозвученная панель): идём по RAF wall-clock
    this.stopActiveAudio(false);
    this.activeSlot = null;
    this.setStatus('playing');
    this.startWallClockRaf(params);
  }

  private handleSlotFinished(
    slot: AudioPlayerSlot,
    params: {
      timeline: readonly SyncTimeline[];
      introDuration: number;
      outroDuration: number;
      introAudio?: Blob | null;
      outroAudio?: Blob | null;
      panelBlobs?: ReadonlyMap<number, Blob>;
      onSegmentEnded?: (nextTime: number) => void;
    },
    targetNextTime?: number
  ): void {
    this.stopRaf();
    const duration = this.clock.getDuration();
    const nextStart = targetNextTime !== undefined ? Math.max(slot.timelineEnd, targetNextTime) : slot.timelineEnd;
    if (nextStart >= duration - 1e-4) {
      this.clock.seek(duration, 'ended');
      this.clock.pause('ended');
      this.setStatus('ended');
      return;
    }
    // По onended явный seek в slot.timelineEnd (или точное время кадра при переходе в RAF, Задача 9)
    this.clock.seek(nextStart, 'audio');
    if (params.onSegmentEnded) {
      params.onSegmentEnded(nextStart);
    } else if (this.lastSyncParams) {
      void this.syncPlayback(this.lastSyncParams);
    }
  }

  /**
   * Плавный PLL-шаг часов плеера (Задача 9):
   * `t = lastAudioTime + (now - lastAudioWall) * playbackRate` с мягкой подтяжкой
   * `t += (audioTarget - t) * 0.1`, ограниченной по производной (< 2% от playbackRate),
   * и без потери дробного остатка времени на переходах `audio -> gap -> audio`.
   */
  tick(
    nowMs?: number,
    overrideParams?: {
      timeline: readonly SyncTimeline[];
      introDuration: number;
      outroDuration: number;
      introAudio?: Blob | null;
      outroAudio?: Blob | null;
      panelBlobs: ReadonlyMap<number, Blob>;
      onSegmentEnded?: (nextTime: number) => void;
    }
  ): number {
    const params = overrideParams ?? this.lastSyncParams;
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : this.nowFn();
    if (!this.clock.getIsPlaying()) {
      this.lastWallMs = now;
      return this.clock.getTime();
    }

    const prevWall = this.lastWallMs > 0 ? this.lastWallMs : now;
    const dt = Math.max(0, (now - prevWall) / 1000);
    this.lastWallMs = now;

    const rate = this.clock.getPlaybackRate();
    const prevTime = this.clock.getTime();

    if (this.activeSlot && this.audio) {
      const slot = this.activeSlot;
      const elTime = this.audio.currentTime;
      if (Math.abs(elTime - this.lastElementRawTime) > 1e-6) {
        this.lastElementRawTime = elTime;
        this.lastAudioTime = slot.timelineStart + Math.max(0, elTime - slot.trimIn);
        this.lastAudioWall = now;
      }

      const audioTarget = this.lastAudioTime + Math.max(0, (now - this.lastAudioWall) / 1000) * rate;
      const predicted = prevTime + dt * rate;
      const rawCorrection = (audioTarget - predicted) * 0.1;
      const maxCorrection = dt * rate * 0.015;
      const clampedCorrection = Math.max(-maxCorrection, Math.min(maxCorrection, rawCorrection));
      const minPositiveStep = dt * rate * 0.5;
      const nextTimelineTime = Math.max(
        prevTime + minPositiveStep,
        prevTime + Math.max(0, predicted - prevTime + clampedCorrection)
      );

      if (nextTimelineTime >= slot.timelineEnd - 1e-4) {
        this.audio.pause();
        this.activeSlot = null;
        if (params) {
          this.handleSlotFinished(slot, params, nextTimelineTime);
        } else {
          this.clock.seek(nextTimelineTime, 'ended');
        }
        return this.clock.getTime();
      }

      this.clock.seek(nextTimelineTime, 'raf');
      return this.clock.getTime();
    }

    // Gap / wall-clock mode
    const nextTime = this.clock.tick(dt, 'raf');
    if (!this.clock.getIsPlaying()) {
      this.setStatus('ended');
      this.stopRaf();
      return nextTime;
    }

    if (params) {
      const nextSlot = resolveAudioSlotAtTime({
        time: nextTime,
        timeline: params.timeline,
        introDuration: params.introDuration,
        outroDuration: params.outroDuration,
        introAudio: params.introAudio,
        outroAudio: params.outroAudio,
        panelBlobs: params.panelBlobs,
      });
      if (nextSlot) {
        this.stopRaf();
        if (params.onSegmentEnded) {
          params.onSegmentEnded(nextTime);
        } else {
          void this.syncPlayback(params);
        }
      }
    }
    return this.clock.getTime();
  }

  private startAudioRaf(
    slot: AudioPlayerSlot,
    params: {
      timeline: readonly SyncTimeline[];
      introDuration: number;
      outroDuration: number;
      introAudio?: Blob | null;
      outroAudio?: Blob | null;
      panelBlobs: ReadonlyMap<number, Blob>;
      onSegmentEnded?: (nextTime: number) => void;
    }
  ): void {
    this.stopRaf();
    if (this.lastWallMs <= 0) {
      this.lastWallMs = this.nowFn();
    }
    const step = (nowMs: number) => {
      if (!this.clock.getIsPlaying() || !this.audio || this.activeSlot?.key !== slot.key) {
        this.rafId = null;
        return;
      }
      this.tick(nowMs, params);
      if (this.clock.getIsPlaying() && this.activeSlot?.key === slot.key) {
        this.rafId = this.requestFrame(step);
      }
    };
    this.rafId = this.requestFrame(step);
  }

  private startWallClockRaf(params: {
    timeline: readonly SyncTimeline[];
    introDuration: number;
    outroDuration: number;
    introAudio?: Blob | null;
    outroAudio?: Blob | null;
    panelBlobs: ReadonlyMap<number, Blob>;
    onSegmentEnded?: (nextTime: number) => void;
  }): void {
    this.stopRaf();
    if (this.lastWallMs <= 0) {
      this.lastWallMs = this.nowFn();
    }
    const step = (nowMs: number) => {
      if (!this.clock.getIsPlaying()) {
        this.rafId = null;
        return;
      }
      this.tick(nowMs, params);
      if (this.clock.getIsPlaying() && !this.activeSlot) {
        this.rafId = this.requestFrame(step);
      }
    };
    this.rafId = this.requestFrame(step);
  }

  private stopRaf(): void {
    if (this.rafId !== null) {
      this.cancelFrame(this.rafId);
      this.rafId = null;
    }
  }

  private stopActiveAudio(revokeUrl: boolean): void {
    this.stopRaf();
    if (this.audio) {
      try {
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.onwaiting = null;
        this.audio.onstalled = null;
        this.audio.oncanplay = null;
        this.audio.onloadedmetadata = null;
        this.audio.pause();
      } catch {}
    }
    if (revokeUrl && this.activeSlot) {
      this.registry.revokeByKey(this.activeSlot.key);
      this.activeSlot = null;
      this.activeUrl = null;
    }
  }

  pause(): void {
    this.stopActiveAudio(false);
    this.lastWallMs = 0;
    if (this.status !== 'idle' && this.status !== 'error') {
      this.setStatus('paused');
    }
  }

  stop(): void {
    this.stopActiveAudio(true);
    this.lastWallMs = 0;
    this.setStatus('idle');
  }

  dispose(): void {
    this.stopActiveAudio(true);
    this.registry.revokeAll();
    this.audio = null;
    this.setStatus('idle');
  }
}
