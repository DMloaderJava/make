/**
 * Аудио-слой рендера: раскладка фрагментов по таймлайну.
 *
 * v1.3.3 (по ревью):
 * - больше нет одного «гигантского» микса: 10 минут стерео 44.1 кГц — это ~212 МБ
 *   на буфер + столько же на декодированные копии (OOM на слабых машинах).
 *   Теперь декодируем и ресемплим по одному фрагменту и либо планируем их
 *   в Web Audio (canvas-фолбэк), либо отдаём в mediabunny последовательно
 *   с вставками тишины (WebCodecs-путь).
 * - пересечения больше не «замазываются» молча: packStarts возвращает список
 *   конфликтов, а вызывающая сторона сообщает о них в UI.
 */

export interface AudioPlacement {
  /** Время начала фрагмента в секундах от начала видео. */
  start: number;
  blob: Blob;
  /** Для диагностики: к какой панели относится фрагмент. */
  label?: string;
}

export interface PackOverlap {
  label?: string;
  requestedStart: number;
  actualStart: number;
  lateBy: number;
  /** trim — хвост предыдущего фрагмента обрезали; shift — фрагмент сдвинули вправо. */
  kind: 'trim' | 'shift';
}

export type ProcessedItem<T> = T & {
  /** Начало после устранения пересечений. */
  start: number;
  /** Запрошенное начало (для диагностики). */
  requestedStart: number;
  /** Сколько секунд реально играть (после обрезки пересечения/хвоста). */
  playDuration: number;
  /** true, если фрагмент пришлось сдвинуть (наложился на предыдущий целиком). */
  shifted: boolean;
  /** true, если фрагмент обрезан по времени следующего. */
  trimmed: boolean;
};

export interface PackResult<T = { start: number; duration: number; label?: string }> {
  placements: Array<ProcessedItem<T>>;
  overlaps: PackOverlap[];
  totalDuration: number;
}

export interface MixedAudio {
  buffer: AudioBuffer;
  duration: number;
}

function getOfflineCtor(): typeof OfflineAudioContext {
  const Ctor = (globalThis as any).OfflineAudioContext || (globalThis as any).webkitOfflineAudioContext;
  if (!Ctor) throw new Error('OfflineAudioContext недоступен');
  return Ctor;
}

let decodeContext: BaseAudioContext | null = null;

function getDecodeContext(): BaseAudioContext {
  if (!decodeContext) {
    const OfflineCtor = getOfflineCtor();
    decodeContext = new OfflineCtor(1, 1, 44100) as BaseAudioContext;
  }
  return decodeContext;
}

/** Декодирует блоб (без ресемплинга). */
export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer | null> {
  try {
    const ab = await blob.arrayBuffer();
    return await getDecodeContext().decodeAudioData(ab.slice(0));
  } catch {
    return null;
  }
}

/**
 * Декодирует и приводит к целевому sample rate / числу каналов.
 * Ресемплинг критичен: Gemini отдаёт 24 кГц, а микширование «как есть» в 44.1 кГц
 * ускоряет звук. Память — один фрагмент за раз.
 */
export async function decodeToTarget(
  blob: Blob,
  sampleRate = 44100,
  channels = 2
): Promise<AudioBuffer | null> {
  const decoded = await decodeAudioBlob(blob);
  if (!decoded) return null;
  if (decoded.sampleRate === sampleRate && decoded.numberOfChannels === channels) return decoded;

  try {
    const OfflineCtor = getOfflineCtor();
    const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
    const offline = new OfflineCtor(channels, frames, sampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    return await offline.startRendering();
  } catch {
    return decoded;
  }
}

/** Обрезает буфер до нужной длительности (перекрытия не должны удлинять ролик). */
export function trimBuffer(buffer: AudioBuffer, seconds: number, sampleRate = buffer.sampleRate): AudioBuffer {
  if (seconds >= buffer.duration - 1e-3) return buffer;
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  try {
    const out = getDecodeContext().createBuffer(buffer.numberOfChannels, frames, sampleRate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      out.copyToChannel(buffer.getChannelData(ch).subarray(0, frames), ch);
    }
    return out;
  } catch {
    return buffer;
  }
}

/** Пустой буфер заданной длительности в нужном формате. */
export function createSilence(ctx: BaseAudioContext, seconds: number, sampleRate = 44100, channels = 2): AudioBuffer {
  return ctx.createBuffer(channels, Math.max(1, Math.round(seconds * sampleRate)), sampleRate);
}

/**
 * Раскладывает фрагменты по времени, устраняя наложения.
 *
 * v1.3.3: короткое наложение решается не сдвигом следующего фрагмента
 * (иначе к концу ролика звук уезжает за видео), а обрезкой хвоста предыдущего —
 * именно перекрытие почти всегда означает «фраза затянулась». Сдвигаем только
 * в вырожденном случае полного перекрытия (два фрагмента в одной точке).
 */
export function packStarts<T extends { start: number; duration: number; label?: string }>(
  items: T[],
  options: { minDuration?: number } = {}
): PackResult<T> {
  const minDuration = options.minDuration ?? 0.05;
  const sorted = [...items].sort((a, b) => a.start - b.start || a.duration - b.duration);
  const placements: Array<ProcessedItem<T>> = [];
  const overlaps: PackOverlap[] = [];

  for (const item of sorted) {
    const requested = item.start;
    let start = requested;
    let playDuration = item.duration;
    let trimmed = false;

    const prev = placements[placements.length - 1];
    if (prev) {
      const prevEnd = prev.start + prev.playDuration;
      if (start < prevEnd - 1e-3) {
        const trimmedPrev = start - prev.start;
        if (trimmedPrev >= minDuration) {
          // обрезаем хвост предыдущего фрагмента — дальше он будет отдан короче
          prev.playDuration = trimmedPrev;
          prev.trimmed = true;
          overlaps.push({
            label: prev.label,
            requestedStart: prev.requestedStart,
            actualStart: prev.start,
            lateBy: 0,
            kind: 'trim',
          });
        } else {
          // предыдущий слишком короткий — сдвигаем текущий
          start = prev.start + prev.playDuration;
          if (start > requested + 1e-3) {
            overlaps.push({
              label: item.label,
              requestedStart: requested,
              actualStart: start,
              lateBy: start - requested,
              kind: 'shift',
            });
          }
        }
      }
    }

    placements.push({
      ...item,
      start,
      requestedStart: requested,
      playDuration,
      shifted: start > requested + 1e-3,
      trimmed,
    });
  }

  const totalDuration = placements.reduce((max, p) => Math.max(max, p.start + p.playDuration), 0);
  return { placements, overlaps, totalDuration };
}

export function reportOverlaps(overlaps: PackOverlap[]): void {
  if (overlaps.length === 0) return;
  const trimmed = overlaps.filter(o => o.kind === 'trim').length;
  const shifted = overlaps.length - trimmed;
  console.warn(
    `[audioMix] наложения аудио: обрезано ${trimmed}, сдвинуто ${shifted} — проверьте длину озвучки панелей`,
    overlaps.map(o =>
      o.kind === 'trim'
        ? `${o.label ?? '?'}: хвост обрезан ради следующего фрагмента`
        : `${o.label ?? '?'}: просили ${o.requestedStart.toFixed(2)}s, начали ${o.actualStart.toFixed(2)}s`
    )
  );
}

/**
 * Планирует фрагменты в реальном Web Audio графе (canvas-фолбэк, MediaRecorder).
 * Никакого микса в память: по одному декодированному буферу на фрагмент.
 *
 * @returns фактическое время старта (в часах AudioContext) и длительность
 */
export async function schedulePlacements(
  ctx: BaseAudioContext,
  destination: AudioNode,
  placements: AudioPlacement[],
  options: { startAt?: number; sampleRate?: number; channels?: number } = {}
): Promise<{ startedAt: number; duration: number; scheduled: number }> {
  const sampleRate = options.sampleRate ?? ctx.sampleRate ?? 44100;
  const channels = options.channels ?? 2;

  const decoded: Array<{ start: number; duration: number; buffer: AudioBuffer; label?: string }> = [];
  for (const p of placements) {
    const buffer = await decodeToTarget(p.blob, sampleRate, channels);
    if (buffer) decoded.push({ start: p.start, duration: buffer.duration, buffer, label: p.label });
  }
  if (decoded.length === 0) return { startedAt: 0, duration: 0, scheduled: 0 };

  const pack = packStarts(decoded);
  reportOverlaps(pack.overlaps);

  const startedAt = options.startAt ?? ctx.currentTime + 0.2;
  pack.placements.forEach(packed => {
    const src = ctx.createBufferSource();
    src.buffer = packed.buffer;
    src.connect(destination);
    // третий аргумент start() — сколько секунд играть: так обрезается перекрытие
    src.start(startedAt + packed.start, 0, packed.playDuration);
  });

  return { startedAt, duration: pack.totalDuration, scheduled: decoded.length };
}

/**
 * Совместимость: микширует всё в один буфер (используется только там, где
 * действительно нужен единый AudioBuffer, например MP3-экспорт небольшого размера).
 * Для длинных роликов предпочитайте schedulePlacements / appendPlacements.
 */
export async function mixAudioPlacements(
  placements: AudioPlacement[],
  totalDuration: number,
  options: { sampleRate?: number; channels?: number } = {}
): Promise<MixedAudio | null> {
  if (placements.length === 0) return null;

  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;

  const decoded: Array<{ start: number; duration: number; buffer: AudioBuffer }> = [];
  for (const p of placements) {
    const buffer = await decodeToTarget(p.blob, sampleRate, channels);
    if (buffer) decoded.push({ start: p.start, duration: buffer.duration, buffer });
  }
  if (decoded.length === 0) return null;

  const pack = packStarts(decoded);
  reportOverlaps(pack.overlaps);

  const duration = Math.max(totalDuration, pack.totalDuration);
  const frames = Math.max(1, Math.ceil(duration * sampleRate));

  const OfflineCtor = getOfflineCtor();
  const offline = new OfflineCtor(channels, frames, sampleRate);
  pack.placements.forEach(packed => {
    const src = offline.createBufferSource();
    src.buffer = packed.buffer;
    src.connect(offline.destination);
    src.start(packed.start, 0, packed.playDuration);
  });

  const rendered = await offline.startRendering();
  return { buffer: rendered, duration: rendered.duration };
}

/**
 * Отдаёт фрагменты в mediabunny AudioBufferSource последовательно (append-only API):
 * тишина для пауз + сам фрагмент. Память — один буфер за раз, гигантского микса нет.
 */
export async function appendPlacements(
  audioSource: { add: (buffer: AudioBuffer) => Promise<void> },
  placements: AudioPlacement[],
  options: { sampleRate?: number; channels?: number } = {}
): Promise<{ duration: number; overlaps: PackOverlap[] }> {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;
  const ctx: BaseAudioContext = getDecodeContext();

  const decoded: Array<{ start: number; duration: number; buffer: AudioBuffer; label?: string }> = [];
  for (const p of placements) {
    const buffer = await decodeToTarget(p.blob, sampleRate, channels);
    if (buffer) decoded.push({ start: p.start, duration: buffer.duration, buffer, label: p.label });
  }
  if (decoded.length === 0) return { duration: 0, overlaps: [] };

  const pack = packStarts(decoded);
  reportOverlaps(pack.overlaps);

  let cursor = 0;
  for (const packed of pack.placements) {
    const gap = packed.start - cursor;
    if (gap > 0.005) {
      await audioSource.add(createSilence(ctx, gap, sampleRate, channels));
      cursor += gap;
    }
    await audioSource.add(trimBuffer(packed.buffer, packed.playDuration, sampleRate));
    cursor += packed.playDuration;
  }

  return { duration: cursor, overlaps: pack.overlaps };
}
