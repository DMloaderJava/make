/**
 * Аудио-слой рендера: раскладка фрагментов по таймлайну.
 *
 * v1.3.3 (по ревью):
 * - пути экспорта больше не собирают один «гигантский» микс (10 минут стерео
 *   44.1 кГц ≈ 212 МБ только на итоговый буфер):
 *     • canvas-фолбэк — планировщик с опережением (в графе живут ближайшие ~4 с,
 *       буфер отпускается по onended);
 *     • WebCodecs/mediabunny — фрагменты отдаются последовательно, паузы
 *       добиваются тишиной.
 *   Раскладка строится по измеренным длительностям: measurePlacements()
 *   декодирует по одному фрагменту и держит в памяти только его (кэш WeakMap),
 *   а не все буферы сразу.
 *   Честная оговорка: mixAudioPlacements() по-прежнему собирает единый буфер —
 *   он оставлен для случаев, где такой буфер действительно нужен (MP3 и т.п.),
 *   и для длинных роликов использовать его не следует.
 * - пересечения больше не «замазываются» молча: packStarts возвращает список
 *   конфликтов (kind/trimmedBy/severity), а UI показывает предупреждения про
 *   обрезанные реплики панелей.
 */

/** Роль дорожки: от неё зависит, считать ли обрезку потерей контента. */
export type AudioRole = 'panel' | 'intro' | 'outro' | 'music';

export interface AudioPlacement {
  /** Время начала фрагмента в секундах от начала видео. */
  start: number;
  blob: Blob;
  /** Для диагностики: к какой панели относится фрагмент. */
  label?: string;
  role?: AudioRole;
}

/** Кэш длительностей: Blob → секунды. Живёт в рамках сессии экспорта. */
const durationCache = new WeakMap<Blob, number>();

/**
 * Кэш декодированных буферов под ограниченный бюджет памяти.
 *
 * Зачем: раскладку нельзя построить, не узнав длительности, а длительность без
 * декодирования не получить (MP3/OGG). Поэтому раньше каждый фрагмент
 * декодировался дважды — на измерение и на рендер. Держим уже декодированные
 * буферы, пока суммарный объём укладывается в бюджет; если ролик длиннее —
 * переходим в режим «декодировать дважды», но с честно ограниченной памятью.
 */
const BUFFER_CACHE_BUDGET = 96 * 1024 * 1024; // 96 МБ PCM
const bufferCache = new Map<Blob, { buffer: AudioBuffer; bytes: number }>();
let bufferCacheBytes = 0;

function audioBufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

function cacheGet(blob: Blob): AudioBuffer | null {
  const entry = bufferCache.get(blob);
  if (!entry) return null;
  // Освежаем порядок вытеснения (FIFO по факту использования)
  bufferCache.delete(blob);
  bufferCache.set(blob, entry);
  return entry.buffer;
}

function cacheSet(blob: Blob, buffer: AudioBuffer): void {
  const bytes = audioBufferBytes(buffer);
  if (bytes > BUFFER_CACHE_BUDGET) return; // один фрагмент больше бюджета — не кэшируем
  bufferCache.set(blob, { buffer, bytes });
  bufferCacheBytes += bytes;
  while (bufferCacheBytes > BUFFER_CACHE_BUDGET) {
    const oldest = bufferCache.keys().next();
    if (oldest.done) break;
    const entry = bufferCache.get(oldest.value);
    bufferCache.delete(oldest.value);
    bufferCacheBytes -= entry ? entry.bytes : 0;
  }
}

/** Сколько байт PCM сейчас удерживает кэш (для диагностики и тестов). */
export function cachedBufferBytes(): number {
  return bufferCacheBytes;
}

export function clearBufferCache(): void {
  bufferCache.clear();
  bufferCacheBytes = 0;
}

export interface PackOverlap {
  label?: string;
  requestedStart: number;
  actualStart: number;
  lateBy: number;
  /** trim — хвост предыдущего фрагмента обрезали; shift — фрагмент сдвинули вправо. */
  kind: 'trim' | 'shift';
  /** Сколько секунд отрезано (для trim) — показывается пользователю. */
  trimmedBy: number;
  /**
   * 'warning' — пострадала реплика панели (зритель может не услышать конец),
   * 'info' — служебная дорожка (интро/аутро/музыка), обрезка ожидаема.
   */
  severity: 'warning' | 'info';
  role: AudioRole;
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

export interface PackResult<T = { start: number; duration: number; label?: string; role?: AudioRole }> {
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
  const cached = cacheGet(blob);
  if (cached && cached.sampleRate === sampleRate && cached.numberOfChannels === channels) {
    return cached;
  }

  const decoded = await decodeAudioBlob(blob);
  if (!decoded) return null;
  if (decoded.sampleRate === sampleRate && decoded.numberOfChannels === channels) {
    cacheSet(blob, decoded);
    return decoded;
  }

  try {
    const OfflineCtor = getOfflineCtor();
    const frames = Math.max(1, Math.ceil(decoded.duration * sampleRate));
    const offline = new OfflineCtor(channels, frames, sampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0);
    const resampled = await offline.startRendering();
    cacheSet(blob, resampled);
    return resampled;
  } catch {
    cacheSet(blob, decoded);
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
export function packStarts<T extends { start: number; duration: number; label?: string; role?: AudioRole }>(
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
          const trimmedBy = prevEnd - start;
          prev.playDuration = trimmedPrev;
          prev.trimmed = true;
          const role = prev.role ?? 'panel';
          overlaps.push({
            label: prev.label,
            requestedStart: prev.requestedStart,
            actualStart: prev.start,
            lateBy: 0,
            kind: 'trim',
            trimmedBy,
            severity: role === 'panel' ? 'warning' : 'info',
            role,
          });
        } else {
          // предыдущий слишком короткий — сдвигаем текущий
          start = prev.start + prev.playDuration;
          if (start > requested + 1e-3) {
            const role = item.role ?? 'panel';
            overlaps.push({
              label: item.label,
              requestedStart: requested,
              actualStart: start,
              lateBy: start - requested,
              kind: 'shift',
              trimmedBy: 0,
              severity: 'warning',
              role,
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
  const trimmed = overlaps.filter(o => o.kind === 'trim');
  const shifted = overlaps.filter(o => o.kind === 'shift');
  console.warn(
    `[audioMix] наложения аудио: обрезано ${trimmed.length}, сдвинуто ${shifted.length} — проверьте длину озвучки панелей`,
    formatOverlaps(overlaps)
  );
}

/** Человекочитаемые строки о наложениях — их показывает UI, а не только консоль. */
export function formatOverlaps(overlaps: PackOverlap[]): string[] {
  return overlaps.map(o => {
    const label = o.label || 'дорожка';
    if (o.kind === 'trim') {
      const seconds = o.trimmedBy >= 0.05 ? ` на ${o.trimmedBy.toFixed(1)} с` : '';
      return o.severity === 'warning'
        ? `${label}: конец реплики обрезан${seconds} — следующая начинается раньше`
        : `${label}: хвост обрезан${seconds}`;
    }
    return `${label}: начало сдвинуто на ${o.lateBy.toFixed(1)} с (наложение)`;
  });
}

/** Только те наложения, о которых стоит сказать пользователю. */
export function userFacingOverlaps(overlaps: PackOverlap[]): string[] {
  return formatOverlaps(overlaps.filter(o => o.severity === 'warning'));
}

/**
 * Измеряет длительности фрагментов.
 *
 * Буферы не складываются в массив (раньше это давало ~88 МБ на 50 панелей),
 * но и не выбрасываются сразу: то, что помещается в бюджет, остаётся в
 * LRU-кэше, поэтому второй проход (рендер/выгрузка в muxer) обходится без
 * повторного декодирования. При ролике длиннее бюджета — деградация до двух
 * декодирований, зато память ограничена.
 */
export async function measurePlacements(
  placements: AudioPlacement[],
  options: { sampleRate?: number; channels?: number } = {}
): Promise<number[]> {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;
  const durations: number[] = [];

  for (const placement of placements) {
    const cached = durationCache.get(placement.blob);
    if (cached !== undefined) {
      durations.push(cached);
      continue;
    }
    const buffer = await decodeToTarget(placement.blob, sampleRate, channels);
    const duration = buffer ? buffer.duration : 0;
    if (buffer) durationCache.set(placement.blob, duration);
    durations.push(duration);
  }

  return durations;
}

/** Раскладывает размещения с учётом измеренных длительностей. */
export async function planPlacements(
  placements: AudioPlacement[],
  options: { sampleRate?: number; channels?: number; minDuration?: number } = {}
): Promise<{ plan: PackResult<AudioPlacement & { duration: number }>; durations: number[] }> {
  const durations = await measurePlacements(placements, options);
  const items = placements.map((placement, i) => ({
    ...placement,
    duration: durations[i],
  }));
  const plan = packStarts(items, { minDuration: options.minDuration });
  reportOverlaps(plan.overlaps);
  return { plan, durations };
}

/**
 * Планирует фрагменты в реальном Web Audio графе (canvas-фолбэк, MediaRecorder).
 * Никакого микса в память: по одному декодированному буферу на фрагмент.
 *
 * @returns фактическое время старта (в часах AudioContext) и длительность
 */
export interface PlacementScheduler {
  startedAt: number;
  /** Полная длительность дорожки, сек. */
  duration: number;
  /** Сколько фрагментов уже отдано в граф (после завершения декодирования). */
  readonly scheduled: number;
  total: number;
  overlaps: PackOverlap[];
  /**
   * Готовит и планирует всё, что начинается в первые `seconds` секунд, ДОЖИДАЯСЬ
   * декодирования. Нужен перед стартом записи: без него первый фрагмент может
   * попасть в граф уже после своего времени старта — Web Audio сыграет его
   * немедленно, с глитчем и потерей первых сэмплов.
   */
  prime(seconds?: number): Promise<number>;
  /** Добирает фрагменты, до которых осталось меньше окна опережения. */
  tick(): number;
  /** Сколько фрагментов сейчас декодируется (диагностика и тесты). */
  readonly pending: number;
  /** Останавливает и освобождает всё; после вызова новых источников не будет. */
  dispose(): void;
}

/**
 * Планировщик с опережением: держим в графе только ближайшие `lookahead`
 * секунд, а не все 50 источников сразу (иначе 10 минут стерео — снова 200+ МБ
 * в буферах источников). Отработавшие источники освобождают буфер по onended.
 */
export async function createPlacementScheduler(
  ctx: BaseAudioContext,
  destination: AudioNode,
  placements: AudioPlacement[],
  options: { startAt?: number; sampleRate?: number; channels?: number; lookahead?: number } = {}
): Promise<PlacementScheduler | null> {
  const sampleRate = options.sampleRate ?? ctx.sampleRate ?? 44100;
  const channels = options.channels ?? 2;
  const lookahead = options.lookahead ?? 4;
  const startedAt = options.startAt ?? ctx.currentTime + 0.2;

  const { plan } = await planPlacements(placements, { sampleRate, channels, minDuration: 0.05 });
  if (plan.placements.length === 0) return null;

  const active: AudioBufferSourceNode[] = [];
  let index = 0;
  let scheduledCount = 0;
  let disposed = false;
  let pendingDecodes = 0;

  const release = (src: AudioBufferSourceNode) => {
    try { src.disconnect(); } catch {}
    // отпускаем декодированный буфер, как только он отзвучал
    try { (src as unknown as { buffer: AudioBuffer | null }).buffer = null; } catch {}
    const i = active.indexOf(src);
    if (i >= 0) active.splice(i, 1);
  };

  const schedule = (item: (typeof plan.placements)[number], buffer: AudioBuffer) => {
    if (disposed) return false; // декод завершился после dispose — источник не создаём
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(destination);
    // третий аргумент start() — сколько секунд играть: так обрезается перекрытие
    const when = startedAt + item.start;
    // Если время старта уже прошло (медленный декод), Web Audio всё равно сыграет
    // немедленно и потеряет начало фрагмента — сообщаем, чтобы это не было сюрпризом.
    if (ctx.currentTime > when + 0.05) {
      console.warn(
        `[audioMix] фрагмент ${item.label ?? '?'} опоздал на ${(ctx.currentTime - when).toFixed(2)} с — начало может быть срезано`
      );
    }
    src.start(when, 0, Math.min(item.playDuration, buffer.duration));
    src.onended = () => release(src);
    active.push(src);
    scheduledCount++;
    return true;
  };

  const decodeAndSchedule = async (item: (typeof plan.placements)[number]): Promise<boolean> => {
    pendingDecodes++;
    try {
      const buffer = await decodeToTarget(item.blob, sampleRate, channels);
      return buffer ? schedule(item, buffer) : false;
    } finally {
      pendingDecodes--;
    }
  };

  /**
   * Планирует (дожидаясь декодирования) всё, что стартует в ближайшие `seconds`.
   * Декодируем строго по одному, чтобы не держать в памяти весь ролик.
   */
  const prime = async (seconds = lookahead): Promise<number> => {
    let added = 0;
    while (!disposed && index < plan.placements.length) {
      const item = plan.placements[index];
      if (item.start > seconds) break;
      index++;
      if (await decodeAndSchedule(item)) added++;
    }
    return added;
  };

  /** Синхронный добор: возвращает число взятых в работу фрагментов. */
  const tick = (): number => {
    if (disposed) return 0;
    let added = 0;
    const elapsed = ctx.currentTime - startedAt;
    while (index < plan.placements.length) {
      const item = plan.placements[index];
      if (item.start > elapsed + lookahead) break;
      index++;
      added++;
      void decodeAndSchedule(item);
    }
    return added;
  };

  const dispose = () => {
    disposed = true;
    for (const src of active.splice(0)) {
      try { src.onended = null; src.stop(); src.disconnect(); } catch {}
      try { (src as unknown as { buffer: AudioBuffer | null }).buffer = null; } catch {}
    }
  };

  return {
    startedAt,
    duration: plan.totalDuration,
    get scheduled() { return scheduledCount; },
    total: plan.placements.length,
    overlaps: plan.overlaps,
    prime,
    tick,
    dispose,
    get pending() { return pendingDecodes; },
  };
}

/**
 * Совместимость: микширует всё в один буфер (используется только там, где
 * действительно нужен единый AudioBuffer, например MP3-экспорт небольшого размера).
 * Для длинных роликов предпочитайте createPlacementScheduler / appendPlacements.
 */
export async function mixAudioPlacements(
  placements: AudioPlacement[],
  totalDuration: number,
  options: { sampleRate?: number; channels?: number } = {}
): Promise<MixedAudio | null> {
  if (placements.length === 0) return null;

  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;

  // Раскладка строится по измеренным длительностям (пик памяти — один буфер),
  // и только потом каждый фрагмент декодируется ещё раз и попадает в микс.
  const { plan } = await planPlacements(placements, { sampleRate, channels });
  if (plan.placements.length === 0) return null;

  const duration = Math.max(totalDuration, plan.totalDuration);
  const frames = Math.max(1, Math.ceil(duration * sampleRate));

  const OfflineCtor = getOfflineCtor();
  const offline = new OfflineCtor(channels, frames, sampleRate);
  for (const packed of plan.placements) {
    const buffer = await decodeToTarget(packed.blob, sampleRate, channels);
    if (!buffer) continue;
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(packed.start, 0, Math.min(packed.playDuration, buffer.duration));
  }

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
  options: { sampleRate?: number; channels?: number; onTrim?: (messages: string[]) => void } = {}
): Promise<{ duration: number; overlaps: PackOverlap[] }> {
  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;
  const ctx: BaseAudioContext = getDecodeContext();

  // Проход 1: только длительности (пик памяти — один буфер).
  const { plan } = await planPlacements(placements, { sampleRate, channels });
  if (plan.placements.length === 0) return { duration: 0, overlaps: [] };

  const warnings = userFacingOverlaps(plan.overlaps);
  if (warnings.length > 0) options.onTrim?.(warnings);

  // Проход 2: по одному декодируем и сразу отдаём в muxer — буферы не копятся.
  let cursor = 0;
  for (const packed of plan.placements) {
    const gap = packed.start - cursor;
    if (gap > 0.005) {
      await audioSource.add(createSilence(ctx, gap, sampleRate, channels));
      cursor += gap;
    }
    const buffer = await decodeToTarget(packed.blob, sampleRate, channels);
    if (buffer) {
      await audioSource.add(trimBuffer(buffer, packed.playDuration, sampleRate));
      cursor += Math.min(packed.playDuration, buffer.duration);
    }
  }

  return { duration: cursor, overlaps: plan.overlaps };
}
