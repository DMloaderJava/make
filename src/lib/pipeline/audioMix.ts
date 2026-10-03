/**
 * Микширование аудио по таймлайну.
 *
 * Зачем: раньше экспорт просто склеивал аудио-блобы подряд (без пауз 0.3s между
 * панелями) и в canvas-фолбэке вообще не подмешивал звук. Плюс при копировании
 * декодированных буферов «как есть» терялся ресемплинг: Gemini отдаёт 24 кГц,
 * а микшировалось в 44.1 кГц → звук ускорялся.
 *
 * Теперь каждый блоб размещается на своём времени через OfflineAudioContext,
 * что даёт корректный ресемплинг и точную синхронизацию с кадрами.
 */

export interface AudioPlacement {
  /** Время начала фрагмента в секундах от начала видео. */
  start: number;
  blob: Blob;
}

export interface MixedAudio {
  buffer: AudioBuffer;
  duration: number;
}

let decodeContext: BaseAudioContext | null = null;

function getDecodeContext(): BaseAudioContext {
  if (!decodeContext) {
    const OfflineCtx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    decodeContext = new OfflineCtx(1, 1, 44100) as BaseAudioContext;
  }
  return decodeContext;
}

export async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer | null> {
  try {
    const ab = await blob.arrayBuffer();
    return await getDecodeContext().decodeAudioData(ab.slice(0));
  } catch {
    return null;
  }
}

/**
 * Микширует фрагменты в один буфер с корректным размещением по времени.
 * @param totalDuration желаемая минимальная длительность (длительность видео)
 */
export async function mixAudioPlacements(
  placements: AudioPlacement[],
  totalDuration: number,
  options: { sampleRate?: number; channels?: number } = {}
): Promise<MixedAudio | null> {
  if (placements.length === 0) return null;

  const sampleRate = options.sampleRate ?? 44100;
  const channels = options.channels ?? 2;

  const decoded: Array<{ start: number; buffer: AudioBuffer }> = [];
  for (const p of placements) {
    const buffer = await decodeAudioBlob(p.blob);
    if (buffer) decoded.push({ start: p.start, buffer });
  }
  if (decoded.length === 0) return null;

  // Раздвигаем пересечения: следующий стартует не раньше конца предыдущего
  decoded.sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const d of decoded) {
    if (d.start < cursor) d.start = cursor;
    cursor = d.start + d.buffer.duration;
  }

  const duration = Math.max(totalDuration, cursor);
  const frames = Math.max(1, Math.ceil(duration * sampleRate));

  const OfflineCtx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  const offline: OfflineAudioContext = new OfflineCtx(channels, frames, sampleRate);

  for (const { start, buffer } of decoded) {
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(start);
  }

  const rendered = await offline.startRendering();
  return { buffer: rendered, duration: rendered.duration };
}
