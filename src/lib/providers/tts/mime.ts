/**
 * MIME аудио: один источник правды + определение контейнера по magic bytes.
 *
 * Зачем определять по байтам: провайдеры не всегда отдают то, что просили
 * (Gemini — raw PCM, Resemble/Hume могут вернуть WAV, кто-то — OGG), и тогда
 * неверный Content-Type ломает decodeAudioData и склейку. Поэтому мы
 * предпочитаем факт, а не пожелание: сначала смотрим на сигнатуру, потом на
 * таблицу по провайдеру, и только в последнюю очередь — на 'audio/mpeg'.
 */

export type AudioMimeType =
  | 'audio/wav'
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/flac'
  | 'audio/aac'
  | 'audio/webm'
  | 'audio/mp4'
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

/** Определяет MIME по сигнатуре контейнера. */
export function detectAudioMime(buffer: ArrayBuffer): AudioMimeType | null {
  if (buffer.byteLength < 12) return null;

  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(buffer, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(buffer, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(buffer, 0, 3) === 'ID3') return 'audio/mpeg';

  const bytes = new Uint8Array(buffer, 0, 2);

  // ADTS AAC проверяем ДО общего MPEG frame sync: синхро-слово ADTS (0xFFF)
  // удовлетворяет и широкому условию (b1 & 0xE0) === 0xE0, поэтому при обратном
  // порядке эта ветка была недостижима и сырой AAC подписывался как mp3.
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
