import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioSignature, decideAudioSource } from '../src/lib/pipeline/generateAudio';

const base = {
  text: 'Привет, мир',
  voice: 'Puck',
  provider: 'gemini',
  model: 'gemini-2.5-flash-preview-tts',
  speed: 1,
  language: 'ru',
};

test('buildAudioSignature: стабильна для одинаковых параметров', async () => {
  const a = await buildAudioSignature(base);
  const b = await buildAudioSignature({ ...base });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]+$/, 'hex');
  assert.equal(a.length, 16, 'hashSHA256 усекается до 16 символов');
});

test('buildAudioSignature: любой значимый параметр меняет подпись', async () => {
  const a = await buildAudioSignature(base);

  const variants: Array<Partial<typeof base>> = [
    { text: 'Привет, мир!' },
    { voice: 'Charon' },
    { provider: 'elevenlabs' },
    { model: 'gemini-2.5-pro-preview-tts' },
    { speed: 1.2 },
    { language: 'en' },
  ];

  for (const variant of variants) {
    const b = await buildAudioSignature({ ...base, ...variant });
    assert.notEqual(a, b, `подпись обязана измениться при ${JSON.stringify(variant)}`);
  }
});

test('buildAudioSignature: необязательные поля не ломают хэш', async () => {
  const a = await buildAudioSignature({ text: 't', voice: 'v', provider: 'p' });
  const b = await buildAudioSignature({ text: 't', voice: 'v', provider: 'p', model: undefined, speed: undefined, language: undefined });
  assert.equal(a, b);
});

test('buildAudioSignature: разделитель не даёт коллизий склейки', async () => {
  const a = await buildAudioSignature({ text: 'a|b', voice: 'c', provider: 'p' });
  const b = await buildAudioSignature({ text: 'a', voice: 'b|c', provider: 'p' });
  assert.notEqual(a, b);
});

test('decideAudioSource: обычный прогон переиспользует кэши', () => {
  assert.equal(decideAudioSource({ hasPersisted: true, hasCached: true }), 'persisted');
  assert.equal(decideAudioSource({ hasPersisted: false, hasCached: true }), 'tts-cache');
  assert.equal(decideAudioSource({ hasPersisted: false, hasCached: false }), 'generate');
  assert.equal(decideAudioSource({ hasPersisted: true, hasCached: false }), 'persisted');
});

test('decideAudioSource: forceRegenerate игнорирует ЛЮБОЙ кэш', () => {
  assert.equal(decideAudioSource({ forceRegenerate: true, hasPersisted: true, hasCached: true }), 'generate');
  assert.equal(decideAudioSource({ forceRegenerate: true, hasPersisted: false, hasCached: true }), 'generate');
  assert.equal(decideAudioSource({ forceRegenerate: true, hasPersisted: false, hasCached: false }), 'generate');
});
