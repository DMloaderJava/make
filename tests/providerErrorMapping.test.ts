import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTTS, mapTTSProviderError } from '../src/lib/providers/tts/router';

test('ElevenLabs 401 missing_permissions explains how to enable the Text to Speech scope', () => {
  const providerPayload = {
    detail: {
      status: 'missing_permissions',
      message: 'The API key does not have permission to use this endpoint.',
    },
  };
  // /api/tts wraps the upstream message in its own { error } JSON response.
  const responseBody = JSON.stringify({ error: `ElevenLabs error: ${JSON.stringify(providerPayload)}` });

  const message = mapTTSProviderError({ providerId: 'elevenlabs', status: 401, responseBody });

  assert.match(message, /ElevenLabs 401/);
  assert.match(message, /text_to_speech/);
  assert.match(message, /API Keys → Edit → Scopes/);
  assert.match(message, /Text to Speech/);
});

test('ElevenLabs 403 also explains how to enable the Text to Speech scope', () => {
  const message = mapTTSProviderError({ providerId: 'elevenlabs', status: 403, responseBody: '{"detail":"forbidden"}' });

  assert.match(message, /ElevenLabs 403/);
  assert.match(message, /text_to_speech/);
});

test('generateTTS turns a proxied JSON error into an actionable message', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const previousWindow = globals.window;
  const originalFetch = globalThis.fetch;
  globals.window = {};
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  )) as typeof fetch;

  try {
    await assert.rejects(
      () => generateTTS({ providerId: 'openai', text: 'test', apiKey: 'invalid' }),
      /OpenAI 401 — Неверный API-ключ OpenAI/
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
  }
});

test('Gemini 404 names the unavailable model and lists supported TTS models', () => {
  const message = mapTTSProviderError({
    providerId: 'gemini',
    status: 404,
    responseBody: JSON.stringify({ error: { code: 404, message: 'model not found' } }),
    model: 'gemini-3.8-flash-tts',
  });

  assert.match(message, /Модель gemini-3\.8-flash-tts не найдена/);
  assert.match(message, /gemini-3\.8-flash-tts/);
  assert.match(message, /gemini-3\.1-flash-tts-preview/);
});

test('OpenAI 429 explains quota and retry options', () => {
  const message = mapTTSProviderError({
    providerId: 'openai',
    status: 429,
    responseBody: JSON.stringify({ error: { message: 'Rate limit reached' } }),
  });

  assert.equal(message, 'OpenAI 429 — Превышен лимит запросов OpenAI. Подождите или проверьте квоту.');
});

test('OpenAI 401 explains that the API key is invalid', () => {
  const message = mapTTSProviderError({
    providerId: 'openai',
    status: 401,
    responseBody: JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
  });

  assert.equal(message, 'OpenAI 401 — Неверный API-ключ OpenAI.');
});

test('Gemini 422 with no audio explains the successful response without audio data', () => {
  const message = mapTTSProviderError({
    providerId: 'gemini',
    status: 422,
    responseBody: JSON.stringify({ error: 'Gemini TTS error: 422 — {"error":"No audio data from Gemini"}' }),
  });

  assert.match(message, /Gemini TTS вернул успешный ответ без аудиоданных/);
  assert.match(message, /Проверьте выбранную модель/);
});

test('generateTTS maps Gemini no-audio responses to the specialized 422 message', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const previousWindow = globals.window;
  const originalFetch = globalThis.fetch;
  globals.window = {};
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'No speech audio.' }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch;

  try {
    await assert.rejects(
      () => generateTTS({ providerId: 'gemini', text: 'test', apiKey: 'gemini-key' }),
      /Gemini 422 — Gemini TTS вернул успешный ответ без аудиоданных/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
  }
});

test('legacy Gemini 500 no-audio errors remain actionable', () => {
  const message = mapTTSProviderError({
    providerId: 'gemini',
    status: 500,
    responseBody: JSON.stringify({ error: 'No audio data from Gemini' }),
  });

  assert.match(message, /Gemini вернул текст вместо аудио/);
  assert.match(message, /Попробуйте ещё раз/);
});

test('Deepgram errors map to actionable TTS guidance', () => {
  const auth = mapTTSProviderError({ providerId: 'deepgram', status: 401, responseBody: 'Invalid credentials' });
  const request = mapTTSProviderError({ providerId: 'deepgram', status: 400, responseBody: 'Unsupported language' });
  const rateLimit = mapTTSProviderError({ providerId: 'deepgram', status: 429, responseBody: 'Too many requests' });

  assert.match(auth, /Ключ Deepgram недействителен/);
  assert.match(request, /Flux поддерживает английский/);
  assert.match(rateLimit, /лимит запросов Deepgram/);
});

test('Cartesia 400 and missing Polly SDK have actionable hints', () => {
  const cartesia = mapTTSProviderError({ providerId: 'cartesia', status: 400, responseBody: '{"error":"invalid request"}' });
  const polly = mapTTSProviderError({ providerId: 'polly', status: 500, responseBody: '{"error":"AWS SDK not installed"}' });

  assert.match(cartesia, /Cartesia отверг запрос/);
  assert.match(cartesia, /2026-03-01/);
  assert.match(polly, /npm install @aws-sdk\/client-polly --no-save --no-audit --no-fund/);
});
