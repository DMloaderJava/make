/**
 * Video assembly - rewritten to be honest about capabilities
 * - MVP: Canvas + MediaRecorder (webm) - works everywhere
 * - Advanced: WebCodecs + mp4-muxer / mediabunny - for proper MP4
 * - No more stub code that pretends to work
 */

import { PanelData, SyncTimeline } from '../storage/db';
import { drawContain } from './draw';
import { createPlacementScheduler, userFacingOverlaps, type AudioPlacement, type PlacementScheduler } from './audioMix';
import { frameTime, waitForStart } from './renderClock';
import { createStripSceneFromMedia, maxScrollY, type StripScene } from './mangaStrip';
import {
  drawDialogue,
  drawIntroOverlay,
  drawOutroOverlay,
  drawPanelWithCamera,
  sampleCameraFrame,
  type CameraFrameSample,
} from './cameraSampler';
import { yRangeFromBbox } from './yRange';

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
  /** Реальная длительность интро-аудио (сек), если есть (Задачи 11, 12). */
  introAudioDuration?: number | null;
  /** Реальная длительность аутро-аудио (сек), если есть (Задачи 11, 12). */
  outroAudioDuration?: number | null;
  srtContent: string;
  /** Предупреждения об обрезанных репликах (текстом, для UI). */
  onAudioTrimmed?: (messages: string[]) => void;
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
  /** Панели проекта: нужны ленте, если в таймлайне нет imageIndex. */
  panels?: Array<{ id: number; imageIndex: number; fullFrame?: boolean; bbox?: { x: number; y: number; width: number; height: number } }>;
}

// Honest implementation using Canvas + MediaRecorder - fixed Promise antipattern
export async function assembleVideoWithCanvas(
  options: AssembleOptions & { onProgress?: (p: number) => void }
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

  // Режим ленты: сцена один раз, рендер кадра — по времени.
  const stripScene: StripScene | null = options.renderMode === 'strip'
    ? createStripSceneFromMedia({
        images: options.images,
        loaded: loadedImages,
        timeline: options.timeline,
        panels: options.panels,
        frameWidth: width,
        frameHeight: height,
        viewport: options.stripViewport,
        gap: options.stripGap,
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
  let scheduler: PlacementScheduler | null = null;
  const leadIn = placements.length > 0 ? 0.25 : 0;

  if (placements.length > 0) {
    try {
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      // Приостановленный контекст не двигает currentTime: мастер-клок замер бы
      // на нуле, а звук не зазвучал. Экспорт всегда идёт после жеста пользователя,
      // но resume() вызываем явно и не считаем ошибкой.
      try { await audioContext.resume(); } catch {}
      audioDestination = audioContext.createMediaStreamDestination();
      // Непрерывный нулевой сигнал для MediaStreamAudioDestinationNode: без активного
      // узла на паузах и leadIn-задержке мультиплексор MediaRecorder (Opus+VP8/VP9 в Chromium)
      // не получает аудиопакетов и не сбрасывает кластеры WebM.
      try {
        const carrierOsc = audioContext.createOscillator();
        const carrierGain = audioContext.createGain();
        carrierGain.gain.value = 0.0001;
        carrierOsc.connect(carrierGain);
        carrierGain.connect(audioDestination);
        carrierOsc.start();
      } catch {}
      // Планировщик с опережением: в графе живут только ближайшие секунды,
      // а не все 50 источников с декодированными буферами (иначе снова сотни МБ).
      scheduler = await createPlacementScheduler(audioContext, audioDestination, placements, {
        sampleRate: 44100,
        channels: 2,
        startAt: audioContext.currentTime + leadIn,
        lookahead: 4,
      });
      if (scheduler) {
        audioStartedAt = scheduler.startedAt;
        timelineDuration = Math.max(timelineDuration, scheduler.duration);
        // Обрезка панельных реплик — это то, о чём пользователю надо сказать явно.
        const warnings = userFacingOverlaps(scheduler.overlaps);
        if (warnings.length > 0) options.onAudioTrimmed?.(warnings);
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
   * Мастер-клок: время кадра считается от момента старта аудио
   * (`audioStartedAt` уже включает leadIn-задержку планирования).
   *
   * Раньше здесь дополнительно вычитался leadIn — и первые 0.25 с видео
   * оставались неотрисованными, пока звук уже играл (A/V разъезжался в другую
   * сторону). Теперь коррекция одна и только в одном месте: запись стартует
   * ровно в момент старта аудио.
   */
  const mediaClock = (fallbackStart: number): number => frameTime({
    audioStartedAt,
    ctxNow: audioContext ? audioContext.currentTime : 0,
    wallNow: performance.now(),
    fallbackStart,
  });

  // NB: captureStream(fps) — лишь подсказка браузеру, в метаданные WEBM частота
  // кадров не пишется (в ffprobe может быть N/A). Точный fps даёт только
  // MP4-путь через WebCodecs (videoEncoder.ts).
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
      try {
        if (chunks.length === 0) {
          console.warn('[assembleVideo] MediaRecorder onstop with 0 chunks', {
            mimeType,
            frameCount,
            totalDuration,
            audioStartedAt,
            ctxTime: audioContext?.currentTime,
          });
        }
      } catch {}
      try { scheduler?.dispose(); } catch {}
      try { audioContext?.close(); } catch {}
      resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    };
    recorder.onerror = (e) => {
      if (stopGuard !== undefined) clearTimeout(stopGuard);
      try { scheduler?.dispose(); } catch {}
      try { audioContext?.close(); } catch {}
      reject(e);
    };

    /**
     * Единая точка остановки записи.
     *
     * Таймер-страховка взводится ТОЛЬКО после фактического recorder.start(), а не
     * сразу после waitForStart: если prime() (декод первых секунд дорожки, на
     * слабой машине с длинным интро — секунды) затягивался, старый таймер
     * срабатывал раньше старта записи, проверка `state === 'recording'` не
     * проходила — и запись оставалась без страховки вообще.
     */
    let stopGuard: ReturnType<typeof setTimeout> | undefined;
    const stopRecorder = () => {
      if (stopGuard !== undefined) { clearTimeout(stopGuard); stopGuard = undefined; }
      if (recorder.state === 'recording') recorder.stop();
    };

    let fallbackStart = performance.now();
    let frameCount = 0;

    const renderFrame = (time: number) => {
      renderExportFrameToCanvas({
        ctx,
        width,
        height,
        time,
        options,
        loadedImages,
        stripScene,
      });
    };

    // MediaRecorder пишет в реальном времени: кадры ведём по мастер-клоку
    // (AudioContext, если есть звук), а не «наращиванием 1/fps».
    // Поправок на leadIn здесь НЕТ: он уже внутри audioStartedAt.
    const animate = () => {
      // Подкидываем планировщику фрагменты, до которых осталось меньше lookahead.
      // Без этого вызова в графе не окажется ни одного источника — и WEBM будет немым.
      scheduler?.tick();
      const time = mediaClock(fallbackStart);
      if (time >= totalDuration) { renderFrame(totalDuration); stopRecorder(); return; }
      if (time >= 0) renderFrame(time);
      frameCount++;
      if (frameCount % 10 === 0) options.onProgress?.(Math.max(0, time / totalDuration));
      requestAnimationFrame(animate);
    };

    // Запись стартует ровно тогда, когда начинает играть звук: иначе первые
    // leadIn секунд видео шли бы без картинки, зато со звуком.
    const beginRecording = () => {
      if (recorder.state !== 'inactive') return;
      // Первые секунды дорожки уже декодированы и запланированы: иначе Web Audio
      // сыграет опоздавший фрагмент немедленно и срежет его начало.
      void (async () => {
        try {
          await scheduler?.prime();
        } catch (e) {
          console.warn('Не удалось подготовить аудио к старту', e);
        }
        if (recorder.state !== 'inactive') return;
        renderFrame(0);
        fallbackStart = performance.now();
        recorder.start(100);
        // Страховка от «вечной» записи, если кадры перестанут приходить (вкладка
        // в фоне): отсчёт от реального старта, а не от момента waitForStart.
        stopGuard = setTimeout(stopRecorder, (totalDuration + 5) * 1000);
        requestAnimationFrame(animate);
      })();
    };

    // Запись начинается по часам AudioContext (см. waitForStart): setTimeout
    // промахивается на 5–10 мс, из-за чего картинка уходила от звука.
    const remaining = () => (audioStartedAt !== null && audioContext ? audioStartedAt - audioContext.currentTime : 0);
    waitForStart({ remaining, onStart: beginRecording });
  });
}

/**
 * Единая точка отрисовки одного кадра экспорта через `sampleCameraFrame`
 * (Итерация 2, Задачи 7, 8, 11, 12).
 */
export function renderExportFrameToCanvas(params: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  time: number;
  options: AssembleOptions;
  loadedImages: Map<string, HTMLImageElement>;
  stripScene?: StripScene | null;
  showStripProgress?: boolean;
}): CameraFrameSample {
  const { ctx, width, height, time, options, loadedImages, stripScene, showStripProgress = false } = params;
  const renderMode = options.renderMode === 'strip' ? 'strip' : 'panels';
  const sample = sampleCameraFrame({
    time,
    renderMode,
    panels: (options.panels as PanelData[] | undefined) ?? [],
    timeline: options.timeline,
    introDuration: options.introDuration,
    outroDuration: options.outroDuration,
    introAudioDuration: options.introAudioDuration,
    outroAudioDuration: options.outroAudioDuration,
    stripScene: stripScene ?? null,
    viewportWidth: width,
    viewportHeight: height,
  });

  if (renderMode === 'strip' && stripScene) {
    const maxY = Math.max(1, maxScrollY(stripScene.layout));
    stripScene.render(ctx, time, {
      scrollY: sample.stripScrollY,
      showProgress: showStripProgress,
      progress: Math.min(1, Math.max(0, sample.stripScrollY / maxY)),
    });
    // Итерация 2.2 (Б-2.1, Б-2.2): на intro/outro в strip рисуем общий оверлей;
    // на panel/gap плашка drawDialogue не рисуется ни в Preview, ни в Export (чистый вебтун).
    if (sample.phase === 'intro') {
      drawIntroOverlay(ctx, width, height, options.introText);
    } else if (sample.phase === 'outro') {
      drawOutroOverlay(ctx, width, height, options.outroText);
    }
  } else if (sample.phase === 'intro') {
    renderIntro(ctx, width, height, options, loadedImages, sample);
  } else if (sample.phase === 'outro') {
    renderOutro(ctx, width, height, options, loadedImages, sample);
  } else {
    renderPanel(ctx, width, height, options, time, loadedImages, sample);
  }

  if (options.srtContent) {
    renderSubtitle(ctx, width, height, options.srtContent, time);
  }

  return sample;
}

function renderIntro(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: AssembleOptions,
  loadedImages: Map<string, HTMLImageElement>,
  sample?: CameraFrameSample
) {
  // Этап 3.1 (Н-3.1): единая схема фона с Preview (без createLinearGradient):
  // #0B0B0C -> drawPanelWithCamera -> rgba(11,11,12,0.25) -> drawIntroOverlay
  ctx.fillStyle = '#0B0B0C';
  ctx.fillRect(0, 0, w, h);

  const displayPanel = sample?.displayPanel ?? (options.panels?.[0] as PanelData | undefined) ?? null;
  const imgIdx = displayPanel?.imageIndex ?? sample?.moment.displaySegment?.imageIndex ?? 0;
  const imgUrl = options.images[imgIdx] ?? options.images[0];
  if (imgUrl) {
    const img = loadedImages.get(imgUrl);
    if (img) {
      if (displayPanel?.fullFrame) {
        drawContain(ctx, img, w, h);
      } else {
        const progress =
          sample && sample.cameraMotion === 'hold'
            ? 0
            : (sample?.panelProgress ?? 0);
        const yRange: [number, number] = sample?.yRange ?? [0, 100];
        drawPanelWithCamera(ctx, img, w, h, yRange, progress);
      }
    }
  }

  ctx.fillStyle = 'rgba(11,11,12,0.25)';
  ctx.fillRect(0, 0, w, h);

  drawIntroOverlay(ctx, w, h, options.introText);
}

function renderPanel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: AssembleOptions,
  currentTime: number,
  loadedImages: Map<string, HTMLImageElement>,
  sample?: CameraFrameSample
) {
  const currentPanel =
    sample?.moment.displaySegment ??
    options.timeline.find(t => currentTime >= t.audioStart && currentTime < t.audioEnd) ??
    options.timeline[options.timeline.length - 1];
  const panelObj =
    sample?.displayPanel ??
    (currentPanel ? (options.panels?.find(p => p.id === currentPanel.panelId) as PanelData | undefined) : undefined) ??
    null;

  if (!currentPanel && !panelObj) {
    ctx.fillStyle = '#0B0B0C';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#8A8A93';
    ctx.font = '14px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('Нет панелей', w / 2, h / 2);
    return;
  }

  const imgIdx = panelObj?.imageIndex ?? currentPanel?.imageIndex ?? 0;
  const imageDataUrl = options.images[imgIdx];
  const img = imageDataUrl ? loadedImages.get(imageDataUrl) : null;

  // «Весь кадр» (сценарий): contain + letterbox, камера выключена.
  const isFullFrame = Boolean(panelObj?.fullFrame);

  ctx.fillStyle = '#0B0B0C';
  ctx.fillRect(0, 0, w, h);

  if (img) {
    if (isFullFrame) {
      drawContain(ctx, img, w, h);
    } else {
      // Итерация 2.1 (Б1): экспорт в режиме panels использует sample.yRange + sample.panelProgress
      // через общий drawPanelWithCamera (побитовое совпадение с Preview.tsx)
      const progress = sample
        ? (sample.phase === 'intro' || sample.phase === 'outro') && sample.cameraMotion === 'hold'
          ? 0
          : sample.panelProgress
        : currentPanel
          ? Math.min(
              1,
              Math.max(0, (currentTime - currentPanel.audioStart) / Math.max(1e-6, currentPanel.audioEnd - currentPanel.audioStart))
            )
          : 0;
      const bbox = panelObj?.bbox ?? currentPanel?.panelBbox ?? { x: 0, y: 0, width: 100, height: 100 };
      const fallbackRange = yRangeFromBbox(bbox, isFullFrame);
      const yRange: [number, number] = sample?.yRange ?? (fallbackRange ? [fallbackRange.from, fallbackRange.to] : [0, 100]);
      drawPanelWithCamera(ctx, img, w, h, yRange, progress);
    }
  }

  ctx.fillStyle = 'rgba(11,11,12,0.25)';
  ctx.fillRect(0, 0, w, h);

  const dialogueText = panelObj?.dialogue ?? currentPanel?.text ?? '';
  const characterName = panelObj?.character ?? currentPanel?.character ?? '';
  drawDialogue(ctx, w, h, dialogueText, characterName, true);
}

function renderOutro(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  options: AssembleOptions,
  loadedImages: Map<string, HTMLImageElement>,
  sample?: CameraFrameSample
) {
  // Этап 3.1 (Н-3.1): единая схема фона с Preview (без createLinearGradient):
  // #0B0B0C -> drawPanelWithCamera -> rgba(11,11,12,0.25) -> drawOutroOverlay
  ctx.fillStyle = '#0B0B0C';
  ctx.fillRect(0, 0, w, h);

  const displayPanel =
    sample?.displayPanel ??
    (options.panels && options.panels.length > 0
      ? (options.panels[options.panels.length - 1] as PanelData)
      : null);
  const imgIdx =
    displayPanel?.imageIndex ??
    sample?.moment.displaySegment?.imageIndex ??
    Math.max(0, options.images.length - 1);
  const imgUrl = options.images[imgIdx] ?? options.images[options.images.length - 1];
  if (imgUrl) {
    const img = loadedImages.get(imgUrl);
    if (img) {
      if (displayPanel?.fullFrame) {
        drawContain(ctx, img, w, h);
      } else {
        const progress =
          sample && sample.cameraMotion === 'hold'
            ? 0
            : (sample?.panelProgress ?? 0);
        const yRange: [number, number] = sample?.yRange ?? [0, 100];
        drawPanelWithCamera(ctx, img, w, h, yRange, progress);
      }
    }
  }

  ctx.fillStyle = 'rgba(11,11,12,0.25)';
  ctx.fillRect(0, 0, w, h);

  drawOutroOverlay(ctx, w, h, options.outroText);
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
