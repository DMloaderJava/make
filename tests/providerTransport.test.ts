import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProviderTarget,
  computeRetryDelay,
  parseRetryAfter,
  providerFailureCode,
  providerFailureStatus,
  providerFetch,
  ProviderHttpError,
} from '../src/lib/providers/http';

/**
 * Транспорт провайдеров проверяется поведением: подменяем `fetch`, часы и
 * `sleep`. Никаких проверок исходного текста — только то, что реально уходит в
 * сеть и что получает вызывающий.
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

type Spec =
  | { kind: 'response'; status: number; body?: string; headers?: Record<string, string> }
  | { kind: 'network'; message: string }
  | { kind: 'hang' };

function mockFetch(specs: Spec[]): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let index = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = specs[Math.min(index, specs.length - 1)];
    index++;
    if (spec.kind === 'network') return Promise.reject(new TypeError(spec.message));
    if (spec.kind === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
    return Promise.resolve(new Response(spec.body ?? 'ok', { status: spec.status, headers: spec.headers }));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Подмена пауз: тесты не должны спать по-настоящему. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

test('providerFetch: успешный ответ — один запрос и тело доступно вызывающему', async () => {
  const { calls, restore } = mockFetch([{ kind: 'response', status: 200, body: 'audio' }]);
  try {
    const res = await providerFetch('demo', 'https://api.example.com/tts', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'audio');
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('providerFetch: 429 с Retry-After повторяется через указанную паузу', async () => {
  const { calls, restore } = mockFetch([
    { kind: 'response', status: 429, body: 'slow down', headers: { 'retry-after': '2' } },
    { kind: 'response', status: 200, body: 'ok' },
  ]);
  const { delays, sleep } = recordingSleep();
  try {
    const res = await providerFetch('demo', 'https://api.example.com', {}, { sleep, random: () => 0 });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(delays, [2000], 'Retry-After важнее экспоненциальной паузы');
  } finally {
    restore();
  }
});

test('providerFetch: без Retry-After пауза растёт экспоненциально и упирается в потолок', async () => {
  const { calls, restore } = mockFetch([{ kind: 'response', status: 503, body: 'down' }]);
  const { delays, sleep } = recordingSleep();
  try {
    await assert.rejects(
      () => providerFetch('demo', 'https://api.example.com', {}, {
        sleep,
        random: () => 0,
        retryBaseMs: 100,
        retryMaxDelayMs: 150,
        retries: 3,
      }),
      (error: ProviderHttpError) => {
        assert.equal(error.code, 'http');
        assert.equal(error.status, 503);
        assert.equal(error.attempts, 4, 'исходная попытка + 3 повтора');
        return true;
      }
    );
    assert.equal(calls.length, 4);
    assert.deepEqual(delays, [50, 100, 150], 'джиттер 0.5–1.0 от базы, но не выше потолка');
  } finally {
    restore();
  }
});

test('providerFetch: 400 не повторяется, тело и статус доезжают до ошибки', async () => {
  const { calls, restore } = mockFetch([{ kind: 'response', status: 400, body: '{"error":"bad voice"}' }]);
  const { delays, sleep } = recordingSleep();
  try {
    await assert.rejects(
      () => providerFetch('demo', 'https://api.example.com', {}, { label: 'Demo', sleep }),
      (error: ProviderHttpError) => {
        assert.equal(error.code, 'http');
        assert.equal(error.status, 400);
        assert.equal(error.body, '{"error":"bad voice"}');
        assert.equal(error.attempts, 1);
        // Контракт сообщения: его разбирают mapTTSProviderError/getLLMHttpError.
        assert.match(error.message, /^Demo error: 400 — \{"error":"bad voice"\}$/);
        return true;
      }
    );
    assert.equal(calls.length, 1, 'ошибка входа не повторяется');
    assert.deepEqual(delays, []);
  } finally {
    restore();
  }
});

test('providerFetch: длинное тело обрезается в сообщении, но не в error.body', async () => {
  const long = 'x'.repeat(2000);
  const { restore } = mockFetch([{ kind: 'response', status: 500, body: long }]);
  const { sleep } = recordingSleep();
  try {
    await assert.rejects(
      () => providerFetch('demo', 'https://api.example.com', {}, { retries: 0, sleep }),
      (error: ProviderHttpError) => {
        assert.equal(error.body.length, 2000);
        assert.ok(error.message.length < 600, 'сообщение не должно раздуваться до килобайт');
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('providerFetch: сетевой сбой повторяется, отмена вызывающим — нет', async () => {
  const network = mockFetch([{ kind: 'network', message: 'ECONNRESET' }, { kind: 'response', status: 200 }]);
  const { sleep } = recordingSleep();
  try {
    const res = await providerFetch('demo', 'https://api.example.com', {}, { sleep, random: () => 0 });
    assert.equal(res.status, 200, 'после сетевого сбоя попытка повторяется');
    assert.equal(network.calls.length, 2);
  } finally {
    network.restore();
  }

  const cancelled = mockFetch([{ kind: 'response', status: 200 }]);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      () => providerFetch('demo', 'https://api.example.com', {}, { signal: controller.signal, sleep }),
      (error: ProviderHttpError) => {
        assert.equal(error.code, 'aborted');
        assert.equal(providerFailureStatus(error), 499);
        assert.equal(providerFailureCode(error), 'aborted');
        return true;
      }
    );
    assert.equal(cancelled.calls.length, 0, 'отменённый запрос не должен уходить в сеть');
  } finally {
    cancelled.restore();
  }
});

test('providerFetch: зависший апстрим обрывается по таймауту, а не висит до maxDuration', async () => {
  const { restore } = mockFetch([{ kind: 'hang' }]);
  const { sleep } = recordingSleep();
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => providerFetch('demo', 'https://api.example.com', {}, { timeoutMs: 30, retries: 0, sleep }),
      (error: ProviderHttpError) => {
        assert.equal(error.code, 'timeout');
        assert.equal(providerFailureStatus(error), 504);
        assert.equal(providerFailureCode(error), 'provider_timeout');
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 2000, 'таймаут срабатывает быстро');
  } finally {
    restore();
  }
});

test('providerFetch: общий бюджет не даёт растянуть паузы за maxDuration', async () => {
  const { calls, restore } = mockFetch([{ kind: 'response', status: 503, body: 'down' }]);
  const { sleep } = recordingSleep();
  try {
    await assert.rejects(
      () => providerFetch('demo', 'https://api.example.com', {}, {
        sleep,
        random: () => 0,
        retryBaseMs: 1000,
        retryMaxDelayMs: 1000,
        deadlineMs: 30,
      }),
      (error: ProviderHttpError) => {
        assert.equal(error.code, 'http');
        return true;
      }
    );
    assert.equal(calls.length, 1, 'ждать паузу дольше бюджета бессмысленно — сдаёмся сразу');
  } finally {
    restore();
  }
});

test('providerFetch: throwOnHttpError=false отдаёт не-2xx ответ вызывающему', async () => {
  const { restore } = mockFetch([{ kind: 'response', status: 422, body: 'schema rejected' }]);
  const { sleep } = recordingSleep();
  try {
    const res = await providerFetch('demo', 'https://api.example.com', {}, { throwOnHttpError: false, retries: 0, sleep });
    assert.equal(res.status, 422);
    assert.equal(await res.text(), 'schema rejected');
  } finally {
    restore();
  }
});

test('parseRetryAfter понимает секунды, HTTP-дату и мусор', () => {
  const now = Date.parse('2026-10-29T10:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('0.5', now), 500);
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 10:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter(null, now), null);
  // Дата в прошлом — «ждать 0», а не отрицательная пауза.
  assert.equal(parseRetryAfter('Thu, 29 Oct 2026 09:59:00 GMT', now), 0);
});

test('computeRetryDelay: экспонента с джиттером, но не выше потолка', () => {
  const policy = { retryBaseMs: 100, retryMaxDelayMs: 250, random: () => 0 };
  assert.equal(computeRetryDelay(1, null, policy), 50);
  assert.equal(computeRetryDelay(2, null, policy), 100);
  assert.equal(computeRetryDelay(3, null, policy), 200);
  assert.equal(computeRetryDelay(6, null, policy), 250, 'потолок соблюдается');
  assert.equal(computeRetryDelay(1, 9000, policy), 250, 'Retry-After тоже упирается в потолок');
});

test('assertProviderTarget: метаданные облака и не-HTTP схемы запрещены всегда', () => {
  const blockedHosts = [
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
    'http://169.254.1.1/',
  ];
  for (const url of blockedHosts) {
    assert.throws(
      () => assertProviderTarget(url),
      (error: ProviderHttpError) => {
        assert.equal(error.code, 'blocked');
        assert.equal(providerFailureStatus(error), 400, `${url}: это ошибка клиента, а не сбой провайдера`);
        return true;
      },
      url
    );
  }

  assert.throws(() => assertProviderTarget('file:///etc/passwd'), ProviderHttpError);
  assert.throws(() => assertProviderTarget('not a url'), ProviderHttpError);
  // Креденшелы в URL утекают в логи прокси — передаём ключ отдельным полем.
  assert.throws(() => assertProviderTarget('https://user:pass@example.com/v1'), /креденшелы/);
});

test('assertProviderTarget: локальные LLM разрешены по умолчанию и блокируются флагом', () => {
  assert.equal(assertProviderTarget('http://localhost:11434/v1').hostname, 'localhost');
  assert.equal(assertProviderTarget('http://192.168.1.20:1234/v1').hostname, '192.168.1.20');
  assert.equal(assertProviderTarget('https://api.openai.com/v1').hostname, 'api.openai.com');

  const previous = process.env.MVS_BLOCK_PRIVATE_PROVIDERS;
  process.env.MVS_BLOCK_PRIVATE_PROVIDERS = '1';
  try {
    assert.throws(
      () => assertProviderTarget('http://localhost:11434/v1'),
      /приватные адреса запрещены/
    );
    assert.equal(assertProviderTarget('https://api.openai.com/v1').hostname, 'api.openai.com');
  } finally {
    if (previous === undefined) delete process.env.MVS_BLOCK_PRIVATE_PROVIDERS;
    else process.env.MVS_BLOCK_PRIVATE_PROVIDERS = previous;
  }
});
