/**
 * v1.2 - RenderBackend abstraction for video encoding
 * - WebCodecsBackend using mediabunny (proper MP4, H.264 + AAC, hardware accelerated)
 * - CanvasMediaRecorderBackend as fallback (WEBM via MediaRecorder)
 * - Capability check via VideoEncoder.isConfigSupported
 */

import { SyncTimeline } from '../storage/db';
import { appendPlacements, measureBlobDurations, planPlacements, stackBlobsBackToBack, type AudioPlacement } from './audioMix';
import { createStripSceneFromMedia, type StripScene } from './mangaStrip';
import { renderExportFrameToCanvas } from './assembleVideo';

export interface RenderOptions {
  images: string[]; // data URLs
  audioBlobs: Blob[];
  /** Точное размещение аудио на таймлайне (приоритетнее audioBlobs). */
  audioPlacements?: AudioPlacement[];
  timeline: SyncTimeline[];
  introText: string;
  outroText: string;
  introDuration: number;
  outroDuration: number;
  /** Реальная длительность интро-аудио (сек), если есть (Задачи 11, 12). */
  introAudioDuration?: number | null;
  /** Реальная длительность аутро-аудио (сек), если есть (Задачи 11, 12). */
  outroAudioDuration?: number | null;
  srtContent: string;
  width: number;
  height: number;
  fps: number;
  /** 'panels' — постранично (по умолчанию), 'strip' — вертикальная лента (webtoon). */
  renderMode?: 'panels' | 'strip';
  /** Высота видимой части ленты в px кадра (по умолчанию — высота кадра). */
  stripViewport?: number;
  /** Отступ между страницами ленты, px. */
  stripGap?: number;
  /** Панели проекта: нужны ленте, если в таймлайне нет imageIndex. */
  panels?: Array<{ id: number; imageIndex: number; fullFrame?: boolean; bbox?: { x: number; y: number; width: number; height: number } }>;
  /** Предупреждения об обрезанных репликах (текстом, для UI). */
  onAudioTrimmed?: (messages: string[]) => void;
  onProgress?: (progress: number, stage?: string) => void;
  signal?: AbortSignal;
}

export interface RenderBackend {
  id: string;
  name: string;
  description: string;
  isSupported(): Promise<boolean>;
  getSupportedMimeType(): string;
  render(options: RenderOptions): Promise<Blob>;
}

export interface BackendCapabilities {
  webCodecs: boolean;
  videoEncoder: boolean;
  audioEncoder: boolean;
  h264: boolean;
  aac: boolean;
  mediabunny: boolean;
}

export async function checkCapabilities(): Promise<BackendCapabilities> {
  const caps: BackendCapabilities = {
    webCodecs: false,
    videoEncoder: false,
    audioEncoder: false,
    h264: false,
    aac: false,
    mediabunny: false
  };

  try {
    caps.webCodecs = typeof (window as any).VideoEncoder !== 'undefined' && typeof (window as any).AudioEncoder !== 'undefined';
    caps.videoEncoder = typeof (window as any).VideoEncoder !== 'undefined';
    caps.audioEncoder = typeof (window as any).AudioEncoder !== 'undefined';

    if (caps.videoEncoder) {
      try {
        const support = await (window as any).VideoEncoder.isConfigSupported({
          codec: 'avc1.42E01E',
          width: 1920,
          height: 1080,
          bitrate: 5_000_000,
          framerate: 30
        });
        caps.h264 = support.supported;
      } catch {
        caps.h264 = false;
      }
    }

    if (caps.audioEncoder) {
      try {
        const support = await (window as any).AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate: 44100,
          numberOfChannels: 2,
          bitrate: 128000
        });
        caps.aac = support.supported;
      } catch {
        caps.aac = false;
      }
    }

    try {
      const m = await import('mediabunny');
      caps.mediabunny = typeof (m as any).Output === 'function' 
        && typeof (m as any).Mp4OutputFormat === 'function'
        && typeof (m as any).CanvasSource === 'function'
        && typeof (m as any).BufferTarget === 'function';
    } catch {
      caps.mediabunny = false;
    }
  } catch {}

  return caps;
}

export function getBestBackendId(caps: BackendCapabilities): string {
  if (caps.webCodecs && caps.h264 && caps.mediabunny) {
    return 'webcodecs';
  }
  return 'canvas';
}

// Canvas + MediaRecorder backend (fallback, works everywhere)
export class CanvasMediaRecorderBackend implements RenderBackend {
  id = 'canvas';
  name = 'Canvas + MediaRecorder';
  description = 'WEBM via MediaRecorder, works everywhere, no hardware accel';

  async isSupported(): Promise<boolean> {
    return typeof MediaRecorder !== 'undefined' && typeof document !== 'undefined';
  }

  getSupportedMimeType(): string {
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return 'video/webm';
  }

  async render(options: RenderOptions): Promise<Blob> {
    const { assembleVideoWithCanvas } = await import('./assembleVideo');
    return assembleVideoWithCanvas({
      images: options.images,
      audioBlobs: options.audioBlobs,
      audioPlacements: options.audioPlacements,
      timeline: options.timeline,
      introText: options.introText,
      outroText: options.outroText,
      introDuration: options.introDuration,
      outroDuration: options.outroDuration,
      introAudioDuration: options.introAudioDuration,
      outroAudioDuration: options.outroAudioDuration,
      srtContent: options.srtContent,
      width: options.width,
      height: options.height,
      fps: options.fps,
      renderMode: options.renderMode,
      stripViewport: options.stripViewport,
      stripGap: options.stripGap,
      panels: options.panels,
      onAudioTrimmed: options.onAudioTrimmed,
      onProgress: options.onProgress,
      signal: options.signal,
    });
  }
}

// WebCodecs + mediabunny backend (proper MP4, hardware accelerated)
export class WebCodecsBackend implements RenderBackend {
  id = 'webcodecs';
  name = 'WebCodecs + mediabunny';
  description = 'MP4 H.264 + AAC, hardware accelerated, proper muxing';

  async isSupported(): Promise<boolean> {
    const caps = await checkCapabilities();
    return caps.webCodecs && caps.h264 && caps.mediabunny;
  }

  getSupportedMimeType(): string {
    return 'video/mp4;codecs=avc1.42E01E,mp4a.40.2';
  }

  async render(options: RenderOptions): Promise<Blob> {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const caps = await checkCapabilities();
    if (!caps.webCodecs || !caps.h264) {
      console.warn('WebCodecs not fully supported, falling back to canvas');
      const fallback = new CanvasMediaRecorderBackend();
      return fallback.render(options);
    }

    try {
      // Try mediabunny implementation
      return await this.renderWithMediabunny(options);
    } catch (e) {
      if (options.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
        throw e;
      }
      console.warn('mediabunny render failed, falling back to canvas', e);
      const fallback = new CanvasMediaRecorderBackend();
      return fallback.render(options);
    }
  }

  /** @internal */
  async renderWithMediabunny(options: RenderOptions, mediabunnyOverride?: unknown): Promise<Blob> {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    options.onProgress?.(0, 'Инициализация рендерера');

    // Dynamic import mediabunny
    const mediabunny = mediabunnyOverride ?? (await import('mediabunny'));
    const { Output, Mp4OutputFormat, CanvasSource, AudioBufferSource, BufferTarget } = mediabunny as any;

    // Preload images
    const loadedImages = new Map<string, HTMLImageElement>();
    for (const dataUrl of options.images) {
      if (!loadedImages.has(dataUrl)) {
        try {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = dataUrl;
          await new Promise((res) => {
            img.onload = res;
            img.onerror = res;
            setTimeout(res, 3000);
          });
          loadedImages.set(dataUrl, img);
        } catch {}
      }
    }

    // Initial duration from timeline (fallback)
    let timelineDuration = options.timeline.length > 0
      ? options.timeline[options.timeline.length - 1].audioEnd + options.outroDuration
      : options.introDuration + options.outroDuration;

    // Режим ленты: сцена строится один раз и рендерит каждый кадр по своему времени.
    const stripScene: StripScene | null = options.renderMode === 'strip'
      ? createStripSceneFromMedia({
          images: options.images,
          loaded: loadedImages,
          timeline: options.timeline,
          panels: options.panels,
          frameWidth: options.width,
          frameHeight: options.height,
          viewport: options.stripViewport,
          gap: options.stripGap,
        })
      : null;

    // Create output
    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat(),
      target
    });

    // Canvas source for video
    const canvas = document.createElement('canvas');
    canvas.width = options.width;
    canvas.height = options.height;
    const ctx = canvas.getContext('2d', { alpha: false })!;

    const canvasSource = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate: 5_000_000,
    });
    // mediabunny ждёт metadata.frameRate (camelCase), 'framerate' молча игнорировался
    output.addVideoTrack(canvasSource, { frameRate: options.fps });

    // Audio: раскладываем фрагменты по таймлайну (рересемплинг + паузы между панелями).
    // Если размещения не передали (старые вызовы) — склеиваем подряд по ФАКТИЧЕСКИМ
    // длительностям (stackBlobsBackToBack): раньше там брался timeline[i-1].audioStart,
    // и для outro это давало старт последней панели (наложение вместо «после неё»).
    // mediabunny принимает буферы последовательно, поэтому паузы добиваются тишиной,
    // а не предварительным «гигантским» миксом (10 мин стерео 44.1 кГц ≈ 212 МБ).
    let audioSource: any = null;
    let mixedDuration: number | null = null;
    let pendingPlacements: AudioPlacement[] = [];
    if (options.audioPlacements?.length || options.audioBlobs.length > 0) {
      pendingPlacements = options.audioPlacements?.length
        ? options.audioPlacements
        : stackBlobsBackToBack(
            options.audioBlobs,
            await measureBlobDurations(options.audioBlobs, { sampleRate: 44100, channels: 2 })
          );

      const { plan } = await planPlacements(pendingPlacements, {
        sampleRate: 44100,
        channels: 2,
      });
      if (plan.placements.length > 0 && plan.totalDuration > 0) {
        audioSource = new AudioBufferSource({
          codec: 'aac',
          bitrate: 128000,
        });
        output.addAudioTrack(audioSource);
        mixedDuration = plan.totalDuration;
      }
    }

    // Длительность видео = максимум из расчётной длины таймлайна (включая немое аутро/панели)
    // и фактической длины смикшированной аудиодорожки.
    const totalDuration = Math.max(timelineDuration, mixedDuration ?? 0);

    // ВАЖНО: mediabunny требует вызвать output.start() ДО любых вызовов audioSource.add() / canvasSource.add(),
    // иначе AudioBufferSource.add() выбрасывает "Output has not started." и срывает MP4-экспорт в фолбэк.
    await output.start();

    if (audioSource && pendingPlacements.length > 0) {
      await appendPlacements(audioSource, pendingPlacements, {
        sampleRate: 44100,
        channels: 2,
        onTrim: options.onAudioTrimmed,
      });
    }

    // Render frames — totalFrames based on actual audio duration
    const fps = options.fps;
    const totalFrames = Math.ceil(totalDuration * fps);

    for (let frame = 0; frame < totalFrames; frame++) {
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const time = frame / fps;

      renderExportFrameToCanvas({
        ctx,
        width: options.width,
        height: options.height,
        time,
        options,
        loadedImages,
        stripScene,
      });

      // Add frame to video track.
      // ВАЖНО: mediabunny принимает timestamp/duration в СЕКУНДАХ, а не в микросекундах —
      // раньше здесь было time*1e6, из-за чего первый кадр получал длительность ~33333 c.
      try {
        await canvasSource.add(time, 1 / fps);
      } catch (e) {
        throw new Error(`Не удалось закодировать кадр t=${time.toFixed(2)}s: ${(e as Error).message}`);
      }

      if (options.onProgress && frame % 5 === 0) {
        // Вызываем раз в 5 кадров, чтобы не спамить React-состояние
        const stage = frame < totalFrames * 0.8 ? 'Рендеринг видео' : 'Кодирование';
        options.onProgress(frame / totalFrames, stage);
      }

      // Yield to main thread to keep UI responsive
      if (frame % 30 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    options.onProgress?.(0.9, 'Обработка аудио');
    await output.finalize();
    options.onProgress?.(1, 'Завершение');
    const buffer = target.buffer;
    return new Blob([buffer!], { type: 'video/mp4' });
  }
}

// Factory
export async function getBestBackend(): Promise<RenderBackend> {
  const caps = await checkCapabilities();
  const bestId = getBestBackendId(caps);
  
  if (bestId === 'webcodecs') {
    const backend = new WebCodecsBackend();
    if (await backend.isSupported()) return backend;
  }
  
  return new CanvasMediaRecorderBackend();
}

export async function renderVideo(options: RenderOptions & { preferredBackend?: string }): Promise<{ blob: Blob; backend: RenderBackend; mimeType: string }> {
  let backend: RenderBackend;
  
  if (options.preferredBackend === 'canvas') {
    backend = new CanvasMediaRecorderBackend();
  } else if (options.preferredBackend === 'webcodecs') {
    backend = new WebCodecsBackend();
    if (!(await backend.isSupported())) {
      backend = new CanvasMediaRecorderBackend();
    }
  } else {
    backend = await getBestBackend();
  }

  const blob = await backend.render(options);
  // Fix: mimeType must reflect actual blob, not backend's advertised type (fallback may return webm while backend says mp4)
  return { blob, backend, mimeType: blob.type || backend.getSupportedMimeType() };
}
