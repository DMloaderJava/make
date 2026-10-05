import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechifyTTS } from '../src/lib/providers/tts/speechify';

test('Speechify defaults to Simba 3.2 and selects Simba 3.0 outside English', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify({ audio_data: btoa('audio-bytes') }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await speechifyTTS.generate('Hello.', { apiKey: 'speechify-key' });
    await speechifyTTS.generate('Bonjour.', { apiKey: 'speechify-key', language: 'fr-FR' });
    await speechifyTTS.generate('Bonjour with legacy model.', { apiKey: 'speechify-key', language: 'fr-FR', model: 'simba-3.2' });
    await speechifyTTS.generate('Hello again.', { apiKey: 'speechify-key', language: 'en-US', model: 'simba-base' });
    await assert.rejects(
      () => speechifyTTS.generate('Привет.', { apiKey: 'speechify-key', language: 'ru' }),
      /Speechify does not support ru/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(speechifyTTS.defaultModel, 'simba-3.2');
  assert.deepEqual(speechifyTTS.supportedModels, ['simba-3.2', 'simba-3.0']);
  assert.deepEqual(bodies.map(body => [body.model, body.language]), [
    ['simba-3.2', 'en-US'],
    ['simba-3.0', 'fr-FR'],
    ['simba-3.0', 'fr-FR'],
    ['simba-3.2', 'en-US'],
  ]);
});
