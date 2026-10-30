import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextRequest } from 'next/server';
import { POST } from '../src/app/api/llm/route';

/**
 * /api/llm — единственный маршрут, который ходит по адресу, введённому
 * пользователем (custom/baseUrl). Проверяем поведением: мусорный baseUrl
 * отбивается ДО сети, локальный Ollama по-прежнему работает, валидация тела
 * отдаёт 400 с полем, а временный 5xx повторяется транспортом.
 */

interface FetchCall { url: string; body: string }

function mockFetch(specs: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let index = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    const spec = specs[Math.min(index, specs.length - 1)];
    index++;
    return Promise.resolve(new Response(spec.body, { status: spec.status, headers: spec.headers }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function post(body: unknown): Promise<Response> {
  const request = new Request('http://localhost/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

const CHAT_OK = JSON.stringify({ choices: [{ message: { content: 'готово' } }] });

test('custom с baseUrl на метаданные облака — 400 blocked_target и ни одного запроса', async () => {
  const { calls, restore } = mockFetch([{ status: 200, body: CHAT_OK }]);
  try {
    const res = await post({
      providerId: 'custom',
      apiKey: 'k',
      baseUrl: 'http://169.254.169.254/latest',
      messages: [{ role: 'user', content: 'привет' }],
    });
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string };
    assert.equal(data.code, 'blocked_target');
    assert.equal(calls.length, 0, 'SSRF-адрес не должен даже пробовать сеть');
  } finally {
    restore();
  }
});

test('custom с локальным Ollama работает и тело уходит как есть', async () => {
  const { calls, restore } = mockFetch([{ status: 200, body: CHAT_OK, headers: { 'Content-Type': 'application/json' } }]);
  try {
    const res = await post({
      providerId: 'custom',
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'привет' }],
    });
    assert.equal(res.status, 200);
    const data = await res.json() as { content: string };
    assert.equal(data.content, 'готово');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
    const sent = JSON.parse(calls[0].body) as { model: string; messages: unknown[] };
    assert.equal(sent.model, 'llama3.1');
    assert.equal(sent.messages.length, 1);
  } finally {
    restore();
  }
});

test('временный 503 провайдера повторяется транспортом', async () => {
  const { calls, restore } = mockFetch([
    { status: 503, body: 'unavailable' },
    { status: 200, body: CHAT_OK, headers: { 'Content-Type': 'application/json' } },
  ]);
  try {
    const res = await post({
      providerId: 'custom',
      apiKey: 'k',
      baseUrl: 'http://localhost:11434/v1',
      messages: [{ role: 'user', content: 'привет' }],
    });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test('отсутствие сообщений — 400 invalid_request с указанием поля', async () => {
  const { calls, restore } = mockFetch([{ status: 200, body: CHAT_OK }]);
  try {
    const res = await post({ providerId: 'custom', apiKey: 'k', messages: [] });
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string; issues: Array<{ path: string }> };
    assert.equal(data.code, 'invalid_request');
    assert.equal(data.issues[0].path, 'messages');
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('неизвестный провайдер — 400 unknown_provider, а не 500', async () => {
  const { restore } = mockFetch([{ status: 200, body: CHAT_OK }]);
  try {
    const res = await post({
      providerId: 'nope',
      apiKey: 'k',
      messages: [{ role: 'user', content: 'привет' }],
    });
    assert.equal(res.status, 400);
    const data = await res.json() as { code: string };
    assert.equal(data.code, 'unknown_provider');
  } finally {
    restore();
  }
});
