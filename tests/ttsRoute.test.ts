import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { POST } from '../src/app/api/tts/route';
import { describeProviderFailure } from '../src/lib/providers/tts/router';
import { ProviderHttpError } from '../src/lib/providers/http';

/**
 * Маршрут /api/tts проверяется как чёрный ящик: POST с обычным Request и
 * подменённый fetch. Никаких проверок «в файле нет switch» — только поведение:
 * какие статусы и коды получает клиент и что реально уходит провайдеру.
 *
 * Это же покрывает главную цель рефакторинга: маршрут больше не содержит
 * ручных веток, поэтому провайдер, добавленный в каталог, обслуживается без
 * правки route.ts.
 */

interface FetchCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function mockFetch(specs: Array<{ status: number; body?: string; bytes?: number[]; headers?: Record<string, string> }>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let index = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ''),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const spec = specs[Math.min(index, specs.length - 1)];
    index++;
    if (spec.bytes) return Promise.resolve(new Response(new Uint8Array(spec.bytes), { status: spec.status, headers: spec.headers }));
    return Promise.resolve(new Response(spec.body ?? '', { status: spec.status, headers: spec.headers }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function post(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

const WAV_BYTES = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45];
const MP3_ID3 = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00];

test('не-JSON тело — 400 invalid_json, без обращения к провайдеру', async () => {
  const { calls, restore } = mockFetch([{ status: 200, bytes: MP3_ID3 }]);
  try {
    const res = await post('это не json');
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string };
    assert.equal(data.code, 'invalid_json');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('пустое тело — 400 invalid_request со списком проблем по полям', async () => {
  const { restore } = mockFetch([{ status: 200, bytes: MP3_ID3 }]);
  try {
    const res = await post({});
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string; issues: Array<{ path: string; message: string }> };
    assert.equal(data.code, 'invalid_request');
    const paths = data.issues.map(issue => issue.path);
    assert.ok(paths.includes('providerId'), 'ошибка указывает конкретное поле');
    assert.ok(paths.includes('text'));
    assert.ok(paths.includes('apiKey'));
    assert.match(data.issues[0].message, /обязательное поле/, 'причина отказа — по-русски, для UI');
  } finally {
    restore();
  }
});

test('неизвестный провайдер — 400 not_implemented', async () => {
  const { calls, restore } = mockFetch([{ status: 200, bytes: MP3_ID3 }]);
  try {
    const res = await post({ providerId: 'no-such-provider', text: 'привет', apiKey: 'k' });
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string };
    assert.equal(data.code, 'not_implemented');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('экспериментальный провайдер без голоса — 400 voice_required, а не выдуманный дефолт', async () => {
  const { calls, restore } = mockFetch([{ status: 200, bytes: MP3_ID3 }]);
  try {
    const res = await post({ providerId: 'hume', text: 'привет', apiKey: 'k' });
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string };
    assert.equal(data.code, 'voice_required');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('успешный синтез: аудио и MIME по сигнатуре, тело собрано провайдером', async () => {
  // hume возвращает base64-аудио из JSON, поэтому отвечаем на запрос JSON-ом.
  // Проверяем не формат ответа провайдера, а диспетчеризацию: тело запроса
  // собрано реализацией провайдера (utterances/voice), а не веткой маршрута.
  const payload = JSON.stringify({ generations: [{ audio: Buffer.from(MP3_ID3).toString('base64') }] });
  const { calls, restore } = mockFetch([{ status: 200, body: payload, headers: { 'Content-Type': 'application/json' } }]);
  try {
    const res = await post({ providerId: 'hume', text: 'Привет, мир', apiKey: 'hume-key', voice: 'ITO' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), MP3_ID3);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.hume\.ai/);
    const sent = JSON.parse(calls[0].body) as { utterances: Array<{ text: string; voice: { name: string } }> };
    assert.equal(sent.utterances[0].text, 'Привет, мир');
    assert.equal(sent.utterances[0].voice.name, 'ITO');
    assert.equal(calls[0].headers['x-hume-api-key'], 'hume-key');
  } finally {
    restore();
  }
});

test('ошибка провайдера доезжает до клиента статусом и actionable-подсказкой', async () => {
  const { restore } = mockFetch([
    {
      status: 401,
      body: JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }),
      headers: { 'Content-Type': 'application/json' },
    },
  ]);
  try {
    const res = await post({ providerId: 'openai', text: 'привет', apiKey: 'bad' });
    assert.equal(res.status, 401);
    const data = await res.json() as { error: string; code: string };
    assert.match(data.error, /Неверный API-ключ OpenAI/);
    assert.equal(data.code, 'provider_http_error');
  } finally {
    restore();
  }
});

test('временный 5xx провайдера повторяется транспортом, затем успех', async () => {
  const { calls, restore } = mockFetch([
    { status: 503, body: 'temporarily unavailable' },
    { status: 200, bytes: WAV_BYTES, headers: { 'Content-Type': 'audio/mpeg' } },
  ]);
  try {
    // fish — экспериментальный: 'default' дал бы voice_required, поэтому голос
    // задан явно, хотя по сценарию fish всё равно вернёт 503 → повтор → 200.
    const res = await post({ providerId: 'fish', text: 'привет', apiKey: 'k', voice: 'fish-voice-1' });
    assert.equal(res.status, 200, 'вторая попытка должна пройти');
    assert.equal(res.headers.get('content-type'), 'audio/wav', 'MIME определяется по байтам RIFF');
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test('провайдер с серверным переопределением вызывается без сети (polly)', async () => {
  const { calls, restore } = mockFetch([{ status: 200, bytes: MP3_ID3 }]);
  try {
    // Валидный JSON-ключ, но SDK не установлен ⇒ переопределение polly
    // действительно вызвано (а не fallback на клиентскую generate()).
    const res = await post({
      providerId: 'polly',
      text: 'привет',
      apiKey: JSON.stringify({ accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'eu-central-1' }),
    });
    assert.equal(res.status, 500);
    const data = await res.json() as { error: string };
    assert.match(data.error, /AWS SDK not installed/);
    assert.equal(calls.length, 0, 'никакого похода в /api/tts изнутри сервера');
  } finally {
    restore();
  }
});

test('описание сбоя: legacy-сообщение провайдера сохраняет свой статус', () => {
  const legacy = new Error('Azure TTS error: 418 — teapot');
  const failure = describeProviderFailure('azure', legacy);
  assert.equal(failure.status, 418);
  assert.match(failure.message, /Azure/);

  const timeout = new ProviderHttpError({ providerId: 'azure', code: 'timeout', attempts: 2 });
  assert.equal(describeProviderFailure('azure', timeout).status, 504);

  const blocked = new ProviderHttpError({ providerId: 'custom', code: 'blocked', body: 'metadata', attempts: 1 });
  assert.equal(describeProviderFailure('custom', blocked).status, 400);

  const unknown = new Error('boom');
  assert.equal(describeProviderFailure('azure', unknown).status, 500);
});
