import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepgramTTS, generateDeepgramTTS, getDeepgramSpeakUrl } from '../src/lib/providers/tts/deepgram';

test('Deepgram Flux uses the batch REST /v2/speak endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; authorization: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization') || '',
      body: String(init?.body || ''),
    });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }) as typeof fetch;

  try {
    const audio = await generateDeepgramTTS('Hello from Flux.', {
      apiKey: 'deepgram-key',
      voice: 'flux-hannah-en',
    });
    assert.equal(audio.byteLength, 3);
    assert.deepEqual(requests, [{
      url: 'https://api.deepgram.com/v2/speak?model=flux-hannah-en',
      authorization: 'Token deepgram-key',
      body: JSON.stringify({ text: 'Hello from Flux.' }),
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Deepgram Aura-2 stays on /v1/speak and requests MP3', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(new Uint8Array([4, 5]), { status: 200 });
  }) as typeof fetch;

  try {
    await generateDeepgramTTS('Hola.', { apiKey: 'deepgram-key', voice: 'aura-2-celeste-es' });
    assert.deepEqual(urls, ['https://api.deepgram.com/v1/speak?model=aura-2-celeste-es&encoding=mp3']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Deepgram catalog includes English Flux and Aura-2 voices for its seven languages', async () => {
  const voices = await deepgramTTS.getVoices('');
  assert.equal(deepgramTTS.defaultModel, 'flux-hannah-en');
  assert.ok(voices.some(voice => voice.id === 'flux-hannah-en' && voice.language === 'en'));
  for (const language of ['en', 'es', 'de', 'fr', 'nl', 'it', 'ja']) {
    assert.ok(voices.some(voice => voice.id.startsWith('aura-2-') && voice.language === language), `Aura-2 voice for ${language}`);
  }
  assert.equal(voices.some(voice => voice.language === 'ru'), false);
});

test('Deepgram URL selects API version from the model family', () => {
  assert.equal(getDeepgramSpeakUrl('flux-kit-en'), 'https://api.deepgram.com/v2/speak?model=flux-kit-en');
  assert.equal(getDeepgramSpeakUrl('aura-2-thalia-en'), 'https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3');
});
