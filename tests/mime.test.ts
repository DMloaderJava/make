import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAudioMime, resolveAudioMime, providerMimeType } from '../src/lib/providers/tts/mime';
import { pcmToWav } from '../src/lib/providers/tts/wav';

function bytes(...values: number[]): ArrayBuffer {
  const arr = new Uint8Array(16);
  arr.set(values.slice(0, 16));
  return arr.buffer;
}

test('detectAudioMime: WAV / OGG / FLAC / MP3(ID3) / MP3(sync) / M4A / WebM', () => {
  const wav = pcmToWav(new Int16Array([1, 2, 3, 4]).buffer as ArrayBuffer, { sampleRate: 24000, channels: 1 });
  assert.equal(detectAudioMime(wav), 'audio/wav');

  assert.equal(detectAudioMime(bytes(0x4f, 0x67, 0x67, 0x53)), 'audio/ogg'); // OggS
  assert.equal(detectAudioMime(bytes(0x66, 0x4c, 0x61, 0x43)), 'audio/flac'); // fLaC
  assert.equal(detectAudioMime(bytes(0x49, 0x44, 0x33)), 'audio/mpeg'); // ID3
  assert.equal(detectAudioMime(bytes(0xff, 0xfb)), 'audio/mpeg'); // MPEG frame sync
  assert.equal(detectAudioMime(bytes(0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70)), 'audio/mp4'); // ftyp
  assert.equal(detectAudioMime(bytes(0x1a, 0x45, 0xdf, 0xa3)), 'audio/webm'); // EBML
});

test('detectAudioMime: ADTS AAC не путается с MP3 (порядок проверок)', () => {
  // 0xFF 0xF1 — синхро-слово ADTS (MPEG-4 AAC, без CRC)
  assert.equal(detectAudioMime(bytes(0xff, 0xf1, 0x50, 0x80)), 'audio/aac');
  // 0xFF 0xF9 — ADTS MPEG-2
  assert.equal(detectAudioMime(bytes(0xff, 0xf9, 0x50, 0x80)), 'audio/aac');
  // 0xFF 0xFB — настоящий MP3 (MPEG-1 Layer III), не ADTS
  assert.equal(detectAudioMime(bytes(0xff, 0xfb, 0x90, 0x00)), 'audio/mpeg');
  // 0xFF 0xF3 — MPEG-2 Layer III
  assert.equal(detectAudioMime(bytes(0xff, 0xf3, 0x90, 0x00)), 'audio/mpeg');
});

test('detectAudioMime: неизвестный контейнер → null, короткий буфер → null', () => {
  assert.equal(detectAudioMime(bytes(0x00, 0x01, 0x02, 0x03)), null);
  assert.equal(detectAudioMime(new ArrayBuffer(8)), null);
});

test('resolveAudioMime: сигнатура важнее таблицы провайдера', () => {
  // Провайдер заявлен как mp3, но реально прислал WAV (resemble/hume так умеют)
  const wav = pcmToWav(new Int16Array([1, 2, 3, 4]).buffer as ArrayBuffer, { sampleRate: 24000, channels: 1 });
  assert.equal(resolveAudioMime('resemble', wav), 'audio/wav');
  assert.equal(resolveAudioMime('elevenlabs', wav), 'audio/wav');

  // MP3-байты, провайдеру по таблице и положен mp3
  const mp3 = bytes(0xff, 0xfb);
  assert.equal(resolveAudioMime('elevenlabs', mp3), 'audio/mpeg');
});

test('resolveAudioMime: неизвестные байты → таблица провайдера → audio/mpeg', () => {
  const unknown = bytes(0x00, 0x11, 0x22, 0x33);
  // Сигнатура не распознана: gemini по таблице — wav (мы оборачиваем PCM сами)
  assert.equal(resolveAudioMime('gemini', unknown), 'audio/wav');
  assert.equal(resolveAudioMime('elevenlabs', unknown), 'audio/mpeg');
  assert.equal(providerMimeType('неизвестный-провайдер'), 'audio/mpeg');
});
