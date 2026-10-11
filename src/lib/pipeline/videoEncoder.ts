/**
 * v1.2 - RenderBackend abstraction for video encoding
 * - WebCodecsBackend using mediabunny (proper MP4, H.264 + AAC, hardware accelerated)
 * - CanvasMediaRecorderBackend as fallback (WEBM via MediaRecorder)
 * - Capability check via VideoEncoder.isConfigSupported
 */

import { SyncTimeline } from '../storage/db';
import { getKenBurnsParams, sameImageSpan } from './buildTimeline';
import { drawContain } from './draw';
import { appendPlacements, measureBlobDurations, stackBlobsBackToBack, type AudioPlacement } from './audioMix';
import { createStripSceneFromMedia, type StripScene } from './mangaStrip';

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
  onProgress?: (progress: number) => void;
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
      srtContent: options.srtContent,
      width: options.width,
      height: options.height,
      fps: options.fps,
      renderMode: options.renderMode,
      stripViewport: options.stripViewport,
      stripGap: options.stripGap,
      panels: options.panels,
      onAudioTrimmed: options.onAudioTrimmed,
      onProgress: options.onProgress
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
      console.warn('mediabunny render failed, falling back to canvas', e);
      const fallback = new CanvasMediaRecorderBackend();
      return fallback.render(options);
    }
  }

  private async renderWithMediabunny(options: RenderOptions): Promise<Blob> {
    // Dynamic import mediabunny
    const mediabunny = await import('mediabunny');
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

    const panelsEnd = options.timeline.length > 0
      ? options.timeline[options.timeline.length - 1].audioEnd
      : options.introDuration;

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
    if (options.audioPlacements?.length || options.audioBlobs.length > 0) {
      const placements: AudioPlacement[] = options.audioPlacements?.length
        ? options.audioPlacements
        : stackBlobsBackToBack(
            options.audioBlobs,
            await measureBlobDurations(options.audioBlobs, { sampleRate: 44100, channels: 2 })
          );

      audioSource = new AudioBufferSource({
        codec: 'aac',
        bitrate: 128000,
      });
      output.addAudioTrack(audioSource);
      const appended = await appendPlacements(audioSource, placements, {
        sampleRate: 44100,
        channels: 2,
        onTrim: options.onAudioTrimmed,
      });
      if (appended.duration > 0) {
        mixedDuration = appended.duration;
      } else {
        audioSource = null;
      }
    }

    // Fix A/V desync: video track duration must match actual mixed audio duration
    // If audio exists, use its duration, otherwise use timeline duration
    const totalDuration = mixedDuration !== null && mixedDuration > 0 ? mixedDuration : timelineDuration;

    await output.start();

    // Render frames — totalFrames based on actual audio duration
    const fps = options.fps;
    const totalFrames = Math.ceil(totalDuration * fps);

    for (let frame = 0; frame < totalFrames; frame++) {
      const time = frame / fps;
      
      // Render frame to canvas
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, options.width, options.height);

      // Determine phase and render
      if (time < options.introDuration) {
        this.renderIntroFrame(ctx, options, loadedImages);
      } else if (stripScene && time < panelsEnd) {
        // Лента: окно скроллится по склеенным страницам синхронно с озвучкой.
        stripScene.render(ctx, time);
      } else if (options.timeline.length > 0 && time < panelsEnd) {
        this.renderPanelFrame(ctx, options, time, loadedImages);
      } else {
        this.renderOutroFrame(ctx, options, loadedImages);
      }

      if (options.srtContent) {
        this.renderSubtitleFrame(ctx, options, time);
      }

      // Add frame to video track.
      // ВАЖНО: mediabunny принимает timestamp/duration в СЕКУНДАХ, а не в микросекундах —
      // раньше здесь было time*1e6, из-за чего первый кадр получал длительность ~33333 c.
      try {
        await canvasSource.add(time, 1 / fps);
      } catch (e) {
        throw new Error(`Не удалось закодировать кадр t=${time.toFixed(2)}s: ${(e as Error).message}`);
      }

      if (frame % 10 === 0) {
        options.onProgress?.(time / totalDuration);
      }

      // Yield to main thread to keep UI responsive
      if (frame % 30 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    await output.finalize();
    const buffer = target.buffer;
    return new Blob([buffer!], { type: 'video/mp4' });
  }

  private renderIntroFrame(ctx: CanvasRenderingContext2D, options: RenderOptions, loadedImages: Map<string, HTMLImageElement>) {
    const w = options.width;
    const h = options.height;
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#1e1b4b');
    gradient.addColorStop(1, '#312e81');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    if (options.images[0]) {
      const img = loadedImages.get(options.images[0]);
      if (img) {
        this.drawCover(ctx, img, w, h, 0.3);
      }
    }

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(w * 0.035)}px system-ui`;
    ctx.textAlign = 'center';
    const lines = this.wrapText(ctx, options.introText || 'Добро пожаловать...', w * 0.8);
    let y = h * 0.7;
    for (const line of lines.slice(0, 3)) {
      ctx.fillText(line, w / 2, y);
      y += Math.floor(w * 0.04);
    }
  }

  private renderPanelFrame(ctx: CanvasRenderingContext2D, options: RenderOptions, time: number, loadedImages: Map<string, HTMLImageElement>) {
    const w = options.width;
    const h = options.height;
    const currentPanel = options.timeline.find(t => time >= t.audioStart && time < t.audioEnd) || options.timeline[options.timeline.length - 1];
    if (!currentPanel) return;

    // «Весь кадр» (сценарий): contain + letterbox, камера выключена,
    // bbox-обводку и бейдж персонажа не рисуем.
    const isFullFrame = options.panels?.find(p => p.id === currentPanel.panelId)?.fullFrame === true;

    const img = options.images[currentPanel.imageIndex] ? loadedImages.get(options.images[currentPanel.imageIndex]) : null;
    if (img) {
      if (isFullFrame) {
        drawContain(ctx, img, w, h);
      } else {
        // Прогресс камеры — по группе соседних панелей одного изображения,
        // направление — с начала группы: зум не «скачет» между панелями.
        const span = sameImageSpan(options.timeline, currentPanel.panelId);
        const idx = span ? span.startIndex : options.timeline.indexOf(currentPanel);
        const progress = span
          ? Math.min(1, Math.max(0, (time - span.start) / (span.end - span.start || 1)))
          : 0;
        const kb = getKenBurnsParams(idx);
        const scale = kb.startScale + (kb.endScale - kb.startScale) * progress;
        const xOff = (kb.startX + (kb.endX - kb.startX) * progress) * w;
        const yOff = (kb.startY + (kb.endY - kb.startY) * progress) * h;
        this.drawCoverWithKenBurns(ctx, img, w, h, 1, scale, xOff, yOff);
      }
    }

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    const bbox = currentPanel.panelBbox;
    const bx = (bbox.x / 100) * w;
    const by = (bbox.y / 100) * h;
    const bw = (bbox.width / 100) * w;
    const bh = (bbox.height / 100) * h;

    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#6366f1';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 12);
    else ctx.rect(bx, by, bw, bh);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(99, 102, 241, 0.9)';
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect(bx, Math.max(0, by - 32), 200, 24, 6);
    else ctx.rect(bx, Math.max(0, by - 32), 200, 24);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText(currentPanel.character, bx + 12, Math.max(0, by - 32) + 16);

    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect(w * 0.05, h * 0.75, w * 0.9, h * 0.2, 16);
    else ctx.rect(w * 0.05, h * 0.75, w * 0.9, h * 0.2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.floor(w * 0.022)}px system-ui`;
    ctx.textAlign = 'center';
    const lines = this.wrapText(ctx, currentPanel.text, w * 0.8);
    let dy = h * 0.82;
    for (const line of lines.slice(0, 3)) {
      ctx.fillText(line, w / 2, dy);
      dy += Math.floor(w * 0.03);
    }
  }

  private renderOutroFrame(ctx: CanvasRenderingContext2D, options: RenderOptions, loadedImages: Map<string, HTMLImageElement>) {
    const w = options.width;
    const h = options.height;
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, '#0f0f0f');
    gradient.addColorStop(1, '#27272a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    if (options.images[options.images.length - 1]) {
      const img = loadedImages.get(options.images[options.images.length - 1]);
      if (img) this.drawCover(ctx, img, w, h, 0.25);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h * 0.3, w, h * 0.4);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(w * 0.032)}px system-ui`;
    ctx.textAlign = 'center';
    const lines = this.wrapText(ctx, options.outroText || 'Спасибо!', w * 0.8);
    let y = h * 0.45;
    for (const line of lines.slice(0, 3)) {
      ctx.fillText(line, w / 2, y);
      y += Math.floor(w * 0.04);
    }
  }

  private renderSubtitleFrame(ctx: CanvasRenderingContext2D, options: RenderOptions, time: number) {
    if (!options.srtContent) return;
    const cues = this.parseSRT(options.srtContent);
    const current = cues.find(c => time >= c.start && time < c.end);
    if (!current) return;
    const w = options.width;
    const h = options.height;
    ctx.font = `${Math.floor(w * 0.02)}px system-ui`;
    const textWidth = ctx.measureText(current.text).width;
    const boxWidth = Math.min(w * 0.9, textWidth + 40);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect((w - boxWidth) / 2, h - 80, boxWidth, 40, 8);
    else ctx.rect((w - boxWidth) / 2, h - 80, boxWidth, 40);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(current.text, w / 2, h - 55);
  }

  private drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number, alpha: number) {
    ctx.globalAlpha = alpha;
    const imgAspect = img.width / img.height;
    const canvasAspect = w / h;
    let dw, dh, ox, oy;
    if (imgAspect > canvasAspect) {
      dh = h;
      dw = dh * imgAspect;
      ox = (w - dw) / 2;
      oy = 0;
    } else {
      dw = w;
      dh = dw / imgAspect;
      ox = 0;
      oy = (h - dh) / 2;
    }
    ctx.drawImage(img, ox, oy, dw, dh);
    ctx.globalAlpha = 1;
  }

  private drawCoverWithKenBurns(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number, alpha: number, scale: number, xOff: number, yOff: number) {
    ctx.globalAlpha = alpha;
    const imgAspect = img.width / img.height;
    const canvasAspect = w / h;
    let dw, dh, bx, by;
    if (imgAspect > canvasAspect) {
      dh = h;
      dw = dh * imgAspect;
      bx = (w - dw) / 2;
      by = 0;
    } else {
      dw = w;
      dh = dw / imgAspect;
      bx = 0;
      by = (h - dh) / 2;
    }
    const sdw = dw * scale;
    const sdh = dh * scale;
    const maxX = (sdw - w) / 2;
    const maxY = (sdh - h) / 2;
    const cx = Math.max(-maxX, Math.min(maxX, xOff));
    const cy = Math.max(-maxY, Math.min(maxY, yOff));
    const ox = bx * scale + cx - (sdw - dw) / 2;
    const oy = by * scale + cy - (sdh - dh) / 2;
    ctx.drawImage(img, ox, oy, sdw, sdh);
    ctx.globalAlpha = 1;
  }

  private wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else current = test;
    }
    if (current) lines.push(current);
    return lines;
  }

  private parseSRT(srt: string): Array<{ start: number; end: number; text: string }> {
    const cues: Array<{ start: number; end: number; text: string }> = [];
    const blocks = srt.trim().split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n');
      if (lines.length < 3) continue;
      const m = lines[1].match(/(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/);
      if (!m) continue;
      const start = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
      const end = parseInt(m[5]) * 3600 + parseInt(m[6]) * 60 + parseInt(m[7]) + parseInt(m[8]) / 1000;
      cues.push({ start, end, text: lines.slice(2).join(' ') });
    }
    return cues;
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
