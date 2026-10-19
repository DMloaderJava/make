/**
 * MIME аудио: один источник правды + определение контейнера по magic bytes
 * (Этап 3, пункты 21, 22, 24).
 *
 * Зачем определять по байтам: провайдеры и пользователи не всегда дают верное
 * расширение или Content-Type (Gemini — raw PCM, переименованный .wav в .mp3 и т.д.).
 * Поэтому мы всегда определяем MIME по сигнатуре файла, храним и исходный, и
 * нормализованный MIME, а при необходимости конвертируем в WAV fallback.
 */

export type AudioMimeType =
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/flac'
  | 'audio/aac'
  | 'audio/webm'
  | 'audio/mp4'
  | 'audio/aiff'
  | 'audio/x-caf'
  | 'application/octet-stream';

/** Что провайдер отдаёт в норме (когда сигнатуру распознать не удалось). */
const PROVIDER_MIME: Record<string, AudioMimeType> = {
  gemini: 'audio/wav',        // raw L16 PCM, мы оборачиваем в WAV
  'google-cloud': 'audio/mpeg',
  azure: 'audio/mpeg',
  elevenlabs: 'audio/mpeg',
  openai: 'audio/mpeg',
  polly: 'audio/mpeg',
  cartesia: 'audio/mpeg',
  deepgram: 'audio/mpeg',
  qwen: 'audio/mpeg',
  playht: 'audio/mpeg',
  resemble: 'audio/mpeg',
  murf: 'audio/mpeg',
  fish: 'audio/mpeg',
  hume: 'audio/mpeg',
  speechify: 'audio/mpeg',
};

export function providerMimeType(providerId: string): AudioMimeType {
  return PROVIDER_MIME[providerId] || 'audio/mpeg';
}

function ascii(buffer: ArrayBuffer, offset: number, length: number): string {
  if (buffer.byteLength < offset + length) return '';
  const bytes = new Uint8Array(buffer, offset, length);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  return out;
}

/** Определяет MIME по сигнатуре контейнера (magic bytes). */
export function detectAudioMime(buffer: ArrayBuffer): AudioMimeType | null {
  if (buffer.byteLength < 4) return null;

  if (buffer.byteLength >= 12 && ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WAVE') {
    return 'audio/wav';
  }
  if (
    buffer.byteLength >= 12 &&
    ascii(buffer, 0, 4) === 'FORM' &&
    (ascii(buffer, 8, 4) === 'AIFF' || ascii(buffer, 8, 4) === 'AIFC')
  ) {
    return 'audio/aiff';
  }
  if (ascii(buffer, 0, 4) === 'caff') return 'audio/x-caf';
  if (ascii(buffer, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(buffer, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(buffer, 0, 3) === 'ID3') return 'audio/mpeg';

  if (buffer.byteLength < 12) return null;

  const bytes = new Uint8Array(buffer, 0, 2);

  // ADTS AAC проверяем ДО общего MPEG frame sync: синхро-слово ADTS (0xFFF)
  // удовлетворяет и широкому условию (b1 & 0xE0) === 0xE0.
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'audio/aac';
  // MPEG frame sync (mp3 без ID3)
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';

  if (ascii(buffer, 4, 4) === 'ftyp') return 'audio/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45) return 'audio/webm'; // EBML

  return null;
}

/**
 * Итоговый MIME: сигнатура важнее таблицы, таблица — важнее дефолта.
 * @param providerId провайдер, у которого запросили аудио
 * @param buffer полученные байты
 */
export function resolveAudioMime(providerId: string, buffer: ArrayBuffer): AudioMimeType {
  return detectAudioMime(buffer) || providerMimeType(providerId);
}

/**
 * Приводит произвольную MIME-строку к каноническому AudioMimeType.
 */
export function canonicalizeMimeString(rawMime: string | undefined): AudioMimeType {
  const m = (rawMime || '').trim().toLowerCase().split(';')[0].trim();
  if (!m) return 'application/octet-stream';
  if (m === 'audio/wav' || m === 'audio/wave' || m === 'audio/x-wav') return 'audio/wav';
  if (m === 'audio/mpeg' || m === 'audio/mp3' || m === 'audio/x-mp3') return 'audio/mpeg';
  if (m === 'audio/ogg' || m === 'audio/opus' || m === 'application/ogg') return 'audio/ogg';
  if (m === 'audio/flac' || m === 'audio/x-flac') return 'audio/flac';
  if (m === 'audio/aac' || m === 'audio/x-aac') return 'audio/aac';
  if (m === 'audio/mp4' || m === 'audio/m4a' || m === 'audio/x-m4a' || m === 'video/mp4') return 'audio/mp4';
  if (m === 'audio/webm' || m === 'video/webm') return 'audio/webm';
  if (m === 'audio/aiff' || m === 'audio/x-aiff') return 'audio/aiff';
  if (m === 'audio/x-caf' || m === 'audio/caf') return 'audio/x-caf';
  return 'application/octet-stream';
}

export interface NormalizedAudioMimeInfo {
  originalMime: string;
  normalizedMime: AudioMimeType;
  detectedBySignature: boolean;
  /** Нужна ли конвертация в WAV fallback для гарантированного воспроизведения во всех браузерах. */
  needsWavFallback: boolean;
  blob: Blob;
}

/**
 * Определяет MIME блоба по сигнатуре первых байт (а не по расширению файла)
 * и возвращает нормализованный Blob вместе с исходным и нормализованным MIME
 * (Этап 3, п. 21, 24).
 */
export async function normalizeAudioBlobMime(
  blob: Blob,
  bufferOverride?: ArrayBuffer
): Promise<NormalizedAudioMimeInfo> {
  const originalMime = (blob.type || 'application/octet-stream').trim() || 'application/octet-stream';
  const headerSlice = bufferOverride
    ? bufferOverride.slice(0, Math.min(32, bufferOverride.byteLength))
    : await blob.slice(0, 32).arrayBuffer();
  const bySignature = detectAudioMime(headerSlice);
  const normalizedMime: AudioMimeType = bySignature ?? canonicalizeMimeString(originalMime);
  const needsWavFallback = normalizedMime === 'audio/aiff' || normalizedMime === 'audio/x-caf';
  // P1 п. 1: переиспользуем bufferOverride или переназначаем MIME через blob.slice(0, size, mime) без копирования буфера
  const normalizedBlob =
    blob.type === normalizedMime
      ? blob
      : bufferOverride
        ? new Blob([bufferOverride], { type: normalizedMime })
        : blob.slice(0, blob.size, normalizedMime);

  return {
    originalMime,
    normalizedMime,
    detectedBySignature: bySignature !== null,
    needsWavFallback,
    blob: normalizedBlob,
  };
}
