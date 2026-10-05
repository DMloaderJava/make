import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateGeminiTTS, GEMINI_TTS_SUPPORTED_MODELS } from '../src/lib/providers/tts/gemini';
import { getModels } from '../src/lib/providers/tts/catalog';

interface MockResponse {
  status: number;
  body?: unknown;
  text?: string;
}

function withMockFetch(responses: MockResponse[]) {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const response = responses[Math.min(index, responses.length - 1)];
    index++;
    return new Response(
      response.text ?? JSON.stringify(response.body ?? {}),
      { status: response.status, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

const audioResponse = {
  candidates: [{ content: { parts: [{ inlineData: { data: 'AQIDBA==' } }] } }],
};

test('Gemini request uses the GA model, x-goog-api-key, speech-only prompt, and returns WAV', async () => {
  const { requests, restore } = withMockFetch([{ status: 200, body: audioResponse }]);
  try {
    const wav = await generateGeminiTTS('Hello world.', { apiKey: 'gemini-key', voice: 'Kore' });
    const request = requests[0];
    const body = JSON.parse(String(request.init?.body));

    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent');
    assert.equal(new Headers(request.init?.headers).get('x-goog-api-key'), 'gemini-key');
    assert.equal(body.contents[0].parts[0].text, 'Generate speech audio only. Read the transcript below aloud exactly as written.\n\nTRANSCRIPT:\nHello world.');
    assert.equal(body.generationConfig.responseModalities[0], 'AUDIO');
    assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.equal(new DataView(wav).getUint32(0, true), 0x46464952, 'RIFF');
    assert.equal(requests.length, 1);
  } finally {
    restore();
  }
});

test('Gemini falls back to a supported model after a 404', async () => {
  const { requests, restore } = withMockFetch([
    { status: 404, body: { error: { message: 'model not found' } } },
    { status: 200, body: audioResponse },
  ]);
  try {
    const wav = await generateGeminiTTS('Hello.', { apiKey: 'k', model: 'gemini-legacy-unavailable' });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /gemini-legacy-unavailable/);
    assert.match(requests[1].url, new RegExp(GEMINI_TTS_SUPPORTED_MODELS[0]));
    assert.equal(new DataView(wav).getUint32(0, true), 0x46464952);
  } finally {
    restore();
  }
});

test('Gemini retries a text-only response once before returning audio', async () => {
  const { requests, restore } = withMockFetch([
    { status: 200, body: { candidates: [{ content: { parts: [{ text: 'This is not audio.' }] } }] } },
    { status: 200, body: audioResponse },
  ]);
  try {
    await generateGeminiTTS('Hello.', { apiKey: 'k' });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, requests[1].url, 'retry the same model before falling back');
  } finally {
    restore();
  }
});

test('Gemini marks successful text-only responses as a 422 no-audio error after model fallbacks', async () => {
  const { requests, restore } = withMockFetch([{
    status: 200,
    body: { candidates: [{ content: { parts: [{ text: 'This is not audio.' }] } }] },
  }]);
  try {
    await assert.rejects(
      () => generateGeminiTTS('Hello.', { apiKey: 'k' }),
      (error: unknown) => {
        assert.match(error instanceof Error ? error.message : String(error), /Gemini TTS error: 422/);
        assert.match(error instanceof Error ? error.message : String(error), /No audio data from Gemini/);
        return true;
      },
    );
    assert.equal(requests.length, GEMINI_TTS_SUPPORTED_MODELS.length * 2);
  } finally {
    restore();
  }
});

test('Gemini retries a transient 503 once on the same model', async () => {
  const { requests, restore } = withMockFetch([
    { status: 503, body: { error: { message: 'temporarily unavailable' } } },
    { status: 200, body: audioResponse },
  ]);
  try {
    await generateGeminiTTS('Hello.', { apiKey: 'k' });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, requests[1].url, 'retry the transient server error before model fallback');
  } finally {
    restore();
  }
});

test('Gemini model discovery uses the key header and returns only TTS models', async () => {
  const { requests, restore } = withMockFetch([{
    status: 200,
    body: {
      models: [
        { name: 'models/gemini-3.1-flash-tts-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-lite-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-4.0-audio-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-tts-no-content', supportedGenerationMethods: ['embedContent'] },
      ],
    },
  }]);
  try {
    const models = await getModels('gemini', 'gemini-key');
    assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.equal(requests[0].init?.method, 'GET');
    assert.equal(new Headers(requests[0].init?.headers).get('x-goog-api-key'), 'gemini-key');
    assert.deepEqual(models, [
      'gemini-3.8-flash-tts',
      'gemini-3.8-flash-lite-tts',
      'gemini-3.1-flash-tts-preview',
      'gemini-4.0-audio-tts',
    ]);
  } finally {
    restore();
  }
});
