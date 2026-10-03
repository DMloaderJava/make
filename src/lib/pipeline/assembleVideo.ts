/**
 * Video assembly - rewritten to be honest about capabilities
 * - MVP: Canvas + MediaRecorder (webm) - works everywhere
 * - Advanced: WebCodecs + mp4-muxer / mediabunny - for proper MP4
 * - No more stub code that pretends to work
 */

import { SyncTimeline } from '../storage/db';
import { getKenBurnsParams } from './buildTimeline';
import { schedulePlacements, type AudioPlacement } from './audioMix';
import { STRIP_DEFAULTS, createStripScene, resolveStripViewport, type StripScene } from './mangaStrip';

export interface AssembleOptions {
  images: string[]; // data URLs
  audioBlobs: Blob[]; // in order of timeline + intro/outro
  /** Точное размещение аудио на таймлайне (приоритетнее audioBlobs). */
  audioPlacements?: AudioPlacement[];
  timeline: SyncTimeline[];
  introText: string;
  outroText: string;
  introDuration: number;
  outroDuration: number;
  srtContent: string;
  backgroundMusic?: Blob;
  musicVolume?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** 'panels' — постранично (по умолчанию), 'strip' — вертикальная лента (webtoon). */
  renderMode?: 'panels' | 'strip';
  /** Высота видимой части ленты в px кадра (по умолчанию — высота кадра). */
  stripViewport?: number;
  /** Отступ между страницами ленты, px. */
  stripGap?: number;
}

// Honest implementation using Canvas + MediaRecorder - fixed Promise antipattern
export async function assembleVideoWithCanvas(
  options: AssembleOptions & { onProgress?: (p: number) => void },
  getImageElement?: (dataUrl: string) => Promise<HTMLImageElement>
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const width = options.width || 1920;
  const height = options.height || 1080;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const loadedImages: Map<string, HTMLImageElement> = new Map();
  for (const dataUrl of options.images) {
    if (!loadedImages.has(dataUrl)) {
      try {
        const img = new Image();
        img.src = dataUrl;
        await new Promise<void>((res) => {
          img.onload = () => res();
          img.onerror = () => res();
          setTimeout(() => res(), 3000);
        });
        loadedImages.set(dataUrl, img);
      } catch {}
    }
  }

  const fps = options.fps || 30;

  const panelsEnd = options.timeline.length > 0
    ? options.timeline[options.timeline.length - 1].audioEnd
    : options.introDuration;

  // Режим ленты: сцена один раз, рендер кадра — по времени.
  const stripScene: StripScene | null = options.renderMode === 'strip' && options.images.length > 0
    ? createStripScene({
        sizes: options.images.map(src => {
          const img = loadedImages.get(src);
          return { width: img?.naturalWidth || 1000, height: img?.naturalHeight || 1400 };
        }),
        images: options.images.map(src => loadedImages.get(src) ?? null),
        timeline: options.timeline,
        options: {
          frameWidth: width,
          frameHeight: height,
          viewport: resolveStripViewport(height, options.stripViewport),
          gap: options.stripGap ?? STRIP_DEFAULTS.gap,
          transition: STRIP_DEFAULTS.transition,
          kenBurnsAmount: STRIP_DEFAULTS.kenBurnsAmount,
          highlight: false,
        },
      })
    : null;

  let timelineDuration = options.timeline.length > 0
    ? options.timeline[options.timeline.length - 1].audioEnd + options.outroDuration
    : options.introDuration + options.outroDuration;

  // --- АУДИО ---
  // Раньше canvas-фолбэк писал видео вообще без звуковой дорожки.
  // Теперь микшируем фрагменты (с рересемплингом и паузами) и добавляем
  // дорожку в MediaStream через MediaStreamAudioDestinationNode.
  const placements: AudioPlacement[] = options.audioPlacements?.length
    ? options.audioPlacements
    : options.audioBlobs.map((blob, i) => ({
        start: i === 0 ? 0 : options.timeline[i - 1]?.audioStart ?? 0,
        blob,
      }));

  let audioContext: AudioContext | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let audioStartedAt: number | null = null;
  const leadIn = placements.length > 0 ? 0.25 : 0;

  if (placements.length > 0) {
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioDestination = audioContext.createMediaStreamDestination();
      // Фрагменты планируются в графе по одному — гигантского микса в память нет,
      // источники обрезаются по длительности (перекрытия не тянут звук вправо).
      const scheduled = await schedulePlacements(audioContext, audioDestination, placements, {
        sampleRate: 44100,
        channels: 2,
        startAt: audioContext.currentTime + leadIn,
      });
      if (scheduled.scheduled > 0) {
        audioStartedAt = scheduled.startedAt;
        timelineDuration = Math.max(timelineDuration, scheduled.duration);
      } else {
        audioContext = null;
        audioDestination = null;
      }
    } catch (e) {
      console.warn('Web Audio недоступен, экспорт без звука', e);
      audioContext = null;
      audioDestination = null;
    }
  }

  /**
   * Мастер-клок: часы AudioContext. Раньше кадры велись по performance.now(),
   * а звук стартовал позже (planning latency, decode) — и к концу ролика
   * картинка и звук разъезжались на секунды. Теперь видео следует за звуком.
   */
  const mediaClock = (fallbackStart: number): number => {
    if (audioContext && audioStartedAt !== null) {
      return Math.max(0, audioContext.currentTime - audioStartedAt);
    }
    return Math.max(0, (performance.now() - fallbackStart) / 1000);
  };

  const videoStream = canvas.captureStream(fps);
  const stream = audioDestination
    ? new MediaStream([...videoStream.getVideoTracks(), ...audioDestination.stream.getAudioTracks()])
    : videoStream;

  const chunks: BlobPart[] = [];
  const mimeTypes = audioDestination
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  let mimeType = '';
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
  }

  const totalDuration = timelineDuration;

  return new Promise<Blob>((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      try { audioContext?.close(); } catch {}
      resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    };
    recorder.onerror = (e) => {
      try { audioContext?.close(); } catch {}
      reject(e);
    };
    recorder.start(100);

    const fallbackStart = performance.now();
    let frameCount = 0;

    const renderFrame = (time: number) => {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      if (time < options.introDuration) renderIntro(ctx, width, height, options, time, loadedImages);
      else if (stripScene && time < panelsEnd) stripScene.render(ctx, time);
      else if (options.timeline.length > 0 && time < panelsEnd) renderPanel(ctx, width, height, options, time, loadedImages);
      else renderOutro(ctx, width, height, options, time, loadedImages);
      if (options.srtContent) renderSubtitle(ctx, width, height, options.srtContent, time);
      // NB: полоса прогресса больше не рисуется — она попадала в готовое видео
    };

    // MediaRecorder пишет в реальном времени: кадры ведём по мастер-клоку
    // (AudioContext, если есть звук), а не «наращиванием 1/fps».
    const animate = () => {
      const time = mediaClock(fallbackStart) - leadIn;
      if (time >= totalDuration) { renderFrame(totalDuration); recorder.stop(); return; }
      if (time >= 0) renderFrame(time);
      frameCount++;
      if (frameCount % 10 === 0) options.onProgress?.(Math.max(0, time / totalDuration));
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, (totalDuration + leadIn + 5) * 1000);
  });
}

function renderIntro(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: AssembleOptions,
  time: number,
  loadedImages: Map<string, HTMLImageElement>
) {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#1e1b4b');
  gradient.addColorStop(1, '#312e81');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  if (options.images[0]) {
    const img = loadedImages.get(options.images[0]);
    if (img) {
      drawImageCover(ctx, img, w, h, 0.3, time);
    }
  }

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, h * 0.6, w, h * 0.4);

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(w * 0.035)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const lines = wrapText(ctx, options.introText || 'Добро пожаловать в мир манги...', w * 0.8);
  let y = h * 0.7;
  for (const line of lines.slice(0, 3)) {
    ctx.fillText(line, w / 2, y);
    y += Math.floor(w * 0.04);
  }
}

function renderPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: AssembleOptions,
  currentTime: number,
  loadedImages: Map<string, HTMLImageElement>
) {
  const currentPanel = options.timeline.find(t => currentTime >= t.audioStart && currentTime < t.audioEnd) 
    || options.timeline[options.timeline.length - 1];

  if (!currentPanel) {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const imageDataUrl = options.images[currentPanel.imageIndex];
  const img = imageDataUrl ? loadedImages.get(imageDataUrl) : null;

  if (img) {
    const panelIndex = options.timeline.indexOf(currentPanel);
    const progress = Math.min(1, Math.max(0, (currentTime - currentPanel.audioStart) / (currentPanel.audioEnd - currentPanel.audioStart || 1)));
    const kb = getKenBurnsParams(panelIndex);
    const scale = kb.startScale + (kb.endScale - kb.startScale) * progress;
    const xOffset = (kb.startX + (kb.endX - kb.startX) * progress) * w;
    const yOffset = (kb.startY + (kb.endY - kb.startY) * progress) * h;
    
    // FIX BUG #3: Apply Ken Burns correctly without double transform
    // Calculate cover dimensions first, then apply scale and offset
    drawImageCoverWithKenBurns(ctx, img, w, h, 1, scale, xOffset, yOffset);
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
  // @ts-ignore - roundRect may not be in all browsers
  if (ctx.roundRect) {
    ctx.roundRect(bx, by, bw, bh, 12);
  } else {
    ctx.rect(bx, by, bw, bh);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.fillStyle = 'rgba(99, 102, 241, 0.9)';
  const badgeText = currentPanel.character;
  ctx.font = 'bold 14px system-ui, sans-serif';
  const textMetrics = ctx.measureText(badgeText);
  const badgeWidth = textMetrics.width + 24;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(bx, Math.max(0, by - 32), badgeWidth, 24, 6);
  } else {
    ctx.rect(bx, Math.max(0, by - 32), badgeWidth, 24);
  }
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.fillText(badgeText, bx + 12, Math.max(0, by - 32) + 16);

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(w * 0.05, h * 0.75, w * 0.9, h * 0.2, 16);
  } else {
    ctx.rect(w * 0.05, h * 0.75, w * 0.9, h * 0.2);
  }
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = `${Math.floor(w * 0.022)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const dialogueLines = wrapText(ctx, currentPanel.text, w * 0.8);
  let dy = h * 0.82;
  for (const line of dialogueLines.slice(0, 3)) {
    ctx.fillText(line, w / 2, dy);
    dy += Math.floor(w * 0.03);
  }
}

function renderOutro(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: AssembleOptions,
  time: number,
  loadedImages: Map<string, HTMLImageElement>
) {
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#0f0f0f');
  gradient.addColorStop(1, '#27272a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  if (options.images[options.images.length - 1]) {
    const img = loadedImages.get(options.images[options.images.length - 1]);
    if (img) {
      drawImageCover(ctx, img, w, h, 0.25, time);
    }
  }

  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, h * 0.3, w, h * 0.4);

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(w * 0.032)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const lines = wrapText(ctx, options.outroText || 'Спасибо за просмотр! Подписывайтесь!', w * 0.8);
  let y = h * 0.45;
  for (const line of lines.slice(0, 3)) {
    ctx.fillText(line, w / 2, y);
    y += Math.floor(w * 0.04);
  }

  ctx.fillStyle = '#6366f1';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(w * 0.35, h * 0.65, w * 0.3, h * 0.08, 12);
  } else {
    ctx.rect(w * 0.35, h * 0.65, w * 0.3, h * 0.08);
  }
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(w * 0.022)}px system-ui, sans-serif`;
  ctx.fillText('Подписаться', w / 2, h * 0.695);
}

function renderSubtitle(ctx: CanvasRenderingContext2D, w: number, h: number, srt: string, time: number) {
  if (!srt) return;
  const cues = parseSRT(srt);
  const current = cues.find(c => time >= c.start && time < c.end);
  if (!current) return;

  ctx.font = `${Math.floor(w * 0.02)}px system-ui, sans-serif`;
  const textWidth = ctx.measureText(current.text).width;
  const boxWidth = Math.min(w * 0.9, textWidth + 40);
  const boxHeight = 40;
  
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect((w - boxWidth) / 2, h - 80, boxWidth, boxHeight, 8);
  } else {
    ctx.rect((w - boxWidth) / 2, h - 80, boxWidth, boxHeight);
  }
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(current.text, w / 2, h - 55);
}

function drawImageCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number, alpha: number, time: number) {
  ctx.globalAlpha = alpha;
  const imgAspect = img.width / img.height;
  const canvasAspect = w / h;
  let drawWidth, drawHeight, offsetX, offsetY;

  if (imgAspect > canvasAspect) {
    drawHeight = h;
    drawWidth = drawHeight * imgAspect;
    offsetX = (w - drawWidth) / 2;
    offsetY = 0;
  } else {
    drawWidth = w;
    drawHeight = drawWidth / imgAspect;
    offsetX = 0;
    offsetY = (h - drawHeight) / 2;
  }

  ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
  ctx.globalAlpha = 1;
}

function drawImageCoverWithKenBurns(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  alpha: number,
  scale: number,
  xOffset: number,
  yOffset: number
) {
  ctx.globalAlpha = alpha;
  const imgAspect = img.width / img.height;
  const canvasAspect = w / h;
  let drawWidth, drawHeight, baseOffsetX, baseOffsetY;

  if (imgAspect > canvasAspect) {
    drawHeight = h;
    drawWidth = drawHeight * imgAspect;
    baseOffsetX = (w - drawWidth) / 2;
    baseOffsetY = 0;
  } else {
    drawWidth = w;
    drawHeight = drawWidth / imgAspect;
    baseOffsetX = 0;
    baseOffsetY = (h - drawHeight) / 2;
  }

  // Apply Ken Burns scale and offset correctly with margin clamp to avoid exposed edges
  const scaledWidth = drawWidth * scale;
  const scaledHeight = drawHeight * scale;

  // Maximum pan to avoid exposing background: (scaled - original)/2
  const maxXOffset = (scaledWidth - w) / 2;
  const maxYOffset = (scaledHeight - h) / 2;
  const clampedXOffset = Math.max(-maxXOffset, Math.min(maxXOffset, xOffset));
  const clampedYOffset = Math.max(-maxYOffset, Math.min(maxYOffset, yOffset));

  const offsetX = baseOffsetX * scale + clampedXOffset - (scaledWidth - drawWidth) / 2;
  const offsetY = baseOffsetY * scale + clampedYOffset - (scaledHeight - drawHeight) / 2;

  ctx.drawImage(img, offsetX, offsetY, scaledWidth, scaledHeight);
  ctx.globalAlpha = 1;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

interface SRTCue {
  start: number;
  end: number;
  text: string;
}

function parseSRT(srt: string): SRTCue[] {
  const cues: SRTCue[] = [];
  const blocks = srt.trim().split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const timeLine = lines[1];
    const match = timeLine.match(/(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)/);
    if (!match) continue;
    const start = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
    const end = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
    const text = lines.slice(2).join(' ');
    cues.push({ start, end, text });
  }
  return cues;
}

// Deprecated stub: proper WebCodecs MP4 implementation lives in videoEncoder.ts WebCodecsBackend (mediabunny)
// This wrapper is kept for backward compat but explicitly falls back to canvas
export async function assembleVideoWithWebCodecs(
  options: AssembleOptions & { onProgress?: (p: number) => void }
): Promise<Blob> {
  console.warn('[deprecated] assembleVideoWithWebCodecs is a stub, use renderVideo({preferredBackend:\"webcodecs\"}) from videoEncoder.ts for proper MP4. Falling back to canvas.');
  return assembleVideoWithCanvas(options);
}

// Simple audio concatenation - uses shared AudioContext singleton to avoid leak
let sharedConcatContext: AudioContext | null = null;
function getConcatAudioContext(): AudioContext {
  if (!sharedConcatContext || sharedConcatContext.state === 'closed') {
    sharedConcatContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return sharedConcatContext;
}

export async function concatenateAudioBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) return new Blob();
  if (blobs.length === 1) return blobs[0];

  const audioContext = getConcatAudioContext();
  const buffers: AudioBuffer[] = [];

  for (const blob of blobs) {
    try {
      const ab = await blob.arrayBuffer();
      const buf = await audioContext.decodeAudioData(ab.slice(0));
      buffers.push(buf);
    } catch {
      continue;
    }
  }

  if (buffers.length === 0) {
    return new Blob(blobs, { type: 'audio/mpeg' });
  }

  const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
  const numberOfChannels = Math.max(...buffers.map(b => b.numberOfChannels));
  const sampleRate = buffers[0].sampleRate;

  const output = audioContext.createBuffer(numberOfChannels, totalLength, sampleRate);
  
  let offset = 0;
  for (const buffer of buffers) {
    for (let ch = 0; ch < Math.min(buffer.numberOfChannels, numberOfChannels); ch++) {
      output.getChannelData(ch).set(buffer.getChannelData(ch), offset);
    }
    offset += buffer.length;
  }

  const wavBlob = audioBufferToWav(output);
  return wavBlob;
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;

  const dataLength = buffer.length * numChannels * (bitDepth / 8);
  const headerLength = 44;
  const arrayBuffer = new ArrayBuffer(headerLength + dataLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Legacy export for compatibility
export const assembleVideoWithFFmpeg = assembleVideoWithCanvas;
