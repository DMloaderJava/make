/**
 * PCM → WAV wrapper.
 *
 * Gemini TTS (generateContent с responseModalities:['AUDIO']) отдаёт сырой PCM
 * (L16, 24 кГц, моно, little-endian) БЕЗ контейнера. Такой буфер не декодируется
 * ни через `decodeAudioData`, ни через `<audio>`, поэтому его обязательно нужно
 * обернуть в RIFF/WAVE перед сохранением в Blob/OPFS.
 */

export interface WavOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
}

export function pcmToWav(pcm: ArrayBuffer, options: WavOptions = {}): ArrayBuffer {
  const sampleRate = options.sampleRate ?? 24000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;

  const dataLength = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

  new Uint8Array(buffer, 44).set(new Uint8Array(pcm));

  return buffer;
}

/** Проверка, что буфер уже является RIFF/WAVE-контейнером. */
export function isWav(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const head = new Uint8Array(buffer, 0, 12);
  const tag = (offset: number) => String.fromCharCode(head[offset], head[offset + 1], head[offset + 2], head[offset + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}
