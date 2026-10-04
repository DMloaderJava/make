import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCartesiaBody, generateCartesia, CARTESIA_DEFAULT_VOICE } from '../src/lib/providers/tts/cartesia';

/**
 * Cartesia — самое «схемозависимое» место в патче: тело собрано по документации
 * версии API 2024-06-10, а живого ключа при разработке нет. Здесь зафиксировано
 * и само тело, и страховка: если API отвергнет `speed`, запрос повторяется без
 * него (единственное поле, которое в разных версиях бывает и строкой, и числом).
 */

interface Call {
  url: string;
  body: Record<string, unknown>;
}

/** Подмена fetch: возвращает заранее заданные ответы и записывает тела запросов. */
function mockFetch(responses: Array<{ status: number; text?: string; bytes?: number[] }>): {
  calls: Call[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body || '{}')) });
    const spec = responses[Math.min(index, responses.length - 1)];
    index++;
    if (spec.bytes) {
      return new Response(new Uint8Array(spec.bytes), { status: spec.status });
    }
    return new Response(spec.text ?? '', { status: spec.status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('buildCartesiaBody: mp3 — через bit_rate, без encoding; speed только когда темп меняли', () => {
  const body = buildCartesiaBody('привет', { speed: 1.6 });
  const output = body.output_format as Record<string, unknown>;

  // В API Cartesia «Text to Speech (Bytes)» версии 2024-06-10 encoding принимает
  // только PCM (pcm_f32le/pcm_s16le/pcm_mulaw/pcm_alaw), а для mp3 нужен bit_rate.
  assert.deepEqual(output, { container: 'mp3', sample_rate: 44100, bit_rate: 128000 });
  assert.ok(!('encoding' in output), 'encoding для mp3 не передаётся');

  // Top-level speed в этой версии — строка-перечисление, не число.
  assert.equal(body.speed, 'fast');
  assert.equal(buildCartesiaBody('x', { speed: 0.5 }).speed, 'slow');
  // 'normal' — дефолт API: поле не отправляем, чтобы не зависеть от схемы зря.
  assert.ok(!('speed' in buildCartesiaBody('x', { speed: 1 })), 'normal не отправляется');
  assert.ok(!('speed' in buildCartesiaBody('x', {})), 'без темпа поля speed нет');
  assert.equal(buildCartesiaBody('x', { speed: 1.2 }).speed, 'fast');

  assert.equal((body.voice as Record<string, unknown>).id, CARTESIA_DEFAULT_VOICE);
  assert.equal(body.language, 'en');
  assert.equal(body.model_id, 'sonic-3');

  const explicit = buildCartesiaBody('x', { voice: 'v-1', language: 'ru', model: 'sonic-3', speed: 1.2 });
  assert.equal((explicit.voice as Record<string, unknown>).id, 'v-1');
  assert.equal(explicit.language, 'ru');
});

test('generateCartesia: успешный ответ возвращает байты и делает один запрос', async () => {
  const { calls, restore } = mockFetch([{ status: 200, bytes: [1, 2, 3, 4] }]);
  try {
    const buffer = await generateCartesia('привет', { apiKey: 'k', speed: 1.4 });
    assert.equal(buffer.byteLength, 4);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.cartesia\.ai\/tts\/bytes/);
    assert.equal(calls[0].body.speed, 'fast');
    assert.equal(calls[0].body.transcript, 'привет');
  } finally {
    restore();
  }
});

test('generateCartesia: 400 на speed → повтор без speed, результат отдаётся', async () => {
  const { calls, restore } = mockFetch([
    { status: 400, text: '{"error":"Unknown field: speed"}' },
    { status: 200, bytes: [9, 9] },
  ]);
  try {
    const buffer = await generateCartesia('привет', { apiKey: 'k', speed: 0.5 });
    assert.equal(buffer.byteLength, 2);
    assert.equal(calls.length, 2, 'должен быть ровно один повтор');
    assert.equal(calls[0].body.speed, 'slow');
    assert.ok(!('speed' in calls[1].body), 'в повторе speed уже нет');
    assert.equal(calls[1].body.output_format !== undefined, true, 'остальное тело сохранено');
  } finally {
    restore();
  }
});

test('generateCartesia: 400 не про speed и 5xx — без повторов, со статусом в ошибке', async () => {
  for (const spec of [
    { status: 400, text: '{"error":"invalid voice id"}', calls: 1 },
    { status: 500, text: 'boom', calls: 1 },
  ]) {
    const { calls, restore } = mockFetch([{ status: spec.status, text: spec.text }]);
    try {
      await assert.rejects(
        () => generateCartesia('привет', { apiKey: 'k', speed: 1.4 }),
        (error: Error & { status?: number }) => {
          assert.match(error.message, /Cartesia error/);
          assert.equal(error.status, spec.status);
          return true;
        }
      );
      assert.equal(calls.length, spec.calls, `статус ${spec.status}: повторов быть не должно`);
    } finally {
      restore();
    }
  }
});
