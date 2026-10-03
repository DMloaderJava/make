import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcmToWav, isWav } from '../src/lib/providers/tts/wav';

test('pcmToWav: заголовок RIFF/WAVE и корректные размеры', () => {
  const samples = new Int16Array([0, 100, -100, 32767, -32768]);

  for (const sampleRate of [16000, 24000, 44100]) {
    const wav = pcmToWav(samples.buffer as ArrayBuffer, { sampleRate, channels: 1 });
    const view = new DataView(wav);

    assert.equal(readAscii(wav, 0, 4), 'RIFF');
    assert.equal(readAscii(wav, 8, 4), 'WAVE');
    assert.equal(readAscii(wav, 12, 4), 'fmt ');
    assert.equal(readAscii(wav, 36, 4), 'data');

    assert.equal(view.getUint32(4, true), wav.byteLength - 8, 'RIFF size = filesize - 8');
    assert.equal(view.getUint16(20, true), 1, 'PCM format');
    assert.equal(view.getUint16(22, true), 1, 'channels');
    assert.equal(view.getUint32(24, true), sampleRate, 'sample rate');
    assert.equal(view.getUint32(28, true), sampleRate * 2, 'byte rate = rate * blockAlign');
    assert.equal(view.getUint16(32, true), 2, 'block align = 16 bit * 1 ch');
    assert.equal(view.getUint16(34, true), 16, 'bits per sample');
    assert.equal(view.getUint32(40, true), samples.byteLength, 'data size');
    assert.equal(wav.byteLength, 44 + samples.byteLength, '44-byte header');
  }
});

test('pcmToWav: сэмплы не портятся', () => {
  const samples = new Int16Array([-32768, -1, 0, 1, 32767]);
  const wav = pcmToWav(samples.buffer as ArrayBuffer, { sampleRate: 24000, channels: 1 });
  const body = new Int16Array(wav, 44);
  assert.deepEqual(Array.from(body), Array.from(samples));
});

test('pcmToWav: стерео (channels=2) даёт удвоенный byte rate', () => {
  const samples = new Int16Array(8);
  const wav = pcmToWav(samples.buffer as ArrayBuffer, { sampleRate: 44100, channels: 2 });
  const view = new DataView(wav);
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(28, true), 44100 * 2 * 2);
});

test('isWav: отличает WAV от mp3/ogg/мусора', () => {
  const wav = pcmToWav(new Int16Array([1, 2, 3]).buffer as ArrayBuffer, { sampleRate: 24000, channels: 1 });
  assert.equal(isWav(wav), true);

  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
  assert.equal(isWav(mp3), false);

  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
  assert.equal(isWav(ogg), false);

  assert.equal(isWav(new ArrayBuffer(4)), false, 'слишком короткий буфер');
});

function readAscii(buffer: ArrayBuffer, offset: number, length: number): string {
  return String.fromCharCode(...new Uint8Array(buffer, offset, length));
}
