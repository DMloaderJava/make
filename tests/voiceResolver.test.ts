import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoice, fallbackVoice } from '../src/lib/providers/tts/voice-resolver';
import { buildCartesiaBody } from '../src/lib/providers/tts/cartesia';
import { getTTSProvider } from '../src/lib/providers/tts/catalog';

/**
 * Политика голосов по умолчанию.
 *
 * Правило: экспериментальные провайдеры (playht, resemble, murf, fish, hume,
 * speechify) не получают автоматический голос — только явный выбор пользователя.
 * Причина: их списки без ключа — заглушки-примеры (speechify 'matthew'), а id из
 * FALLBACK_VOICE не подтверждены живым API. Молча подставить такое значение и
 * получить невнятную ошибку от провайдера хуже, чем попросить выбрать голос.
 */

/** Подмена fetch на время одной проверки: тесты не должны ходить в сеть. */
async function withFetch(impl: typeof fetch, fn: () => Promise<unknown>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const forbiddenFetch = ((): typeof fetch => {
  return (async (input: RequestInfo | URL) => {
    throw new Error(`сеть в тестах запрещена: ${String(input)}`);
  }) as typeof fetch;
})();

const jsonFetch = (payload: unknown): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

test('resolveVoice: явный голос у экспериментального провайдера — доверяем без сети', async () => {
  await withFetch(forbiddenFetch, async () => {
    const voice = await resolveVoice('speechify', 'key', 'my-real-voice');
    assert.equal(voice, 'my-real-voice');
  });
});

test('resolveVoice: у resemble собственный id "default" — это выбор, а не пустота', async () => {
  await withFetch(forbiddenFetch, async () => {
    const voice = await resolveVoice('resemble', 'key', 'default');
    assert.equal(voice, 'default');
  });
});

test('resolveVoice: экспериментальный провайдер без явного голоса — понятный отказ', async () => {
  for (const id of ['speechify', 'playht', 'murf', 'fish', 'hume', 'resemble']) {
    const provider = getTTSProvider(id);
    assert.equal(provider?.experimental, true, `${id}: ожидали experimental: true`);
    await withFetch(forbiddenFetch, async () => {
      await assert.rejects(
        () => resolveVoice(id, 'key'),
        (error: Error) => {
          assert.match(error.message, /экспериментальный/);
          assert.match(error.message, /вручную/);
          assert.doesNotMatch(error.message, /matthew/, 'выдуманный id не должен попадать в ошибку');
          return true;
        },
        `${id}: без явного голоса должен быть отказ, а не дефолт из таблицы`
      );
    });
    // Таблица фолбэков остаётся, но в API такие значения больше не уходят.
    assert.equal(typeof fallbackVoice(id), 'string');
  }
});

test('resolveVoice: проверенный провайдер без сети падает в статический фолбэк', async () => {
  await withFetch(forbiddenFetch, async () => {
    const voice = await resolveVoice('cartesia', 'key');
    assert.equal(voice, fallbackVoice('cartesia'));
    assert.equal(voice, '79a125e8-cd45-4c13-8a67-188112f4dd22');
  });
});

test('resolveVoice: проверенный провайдер с рабочим API отдаёт первый реальный голос', async () => {
  await withFetch(jsonFetch({ data: [{ id: 'real-voice-1', name: 'Real 1' }] }), async () => {
    const voice = await resolveVoice('cartesia', 'key');
    assert.equal(voice, 'real-voice-1');
  });
});

test('buildCartesiaBody: mp3 — через bit_rate, без encoding; speed переводится в строку', () => {
  const body = buildCartesiaBody('привет', { speed: 1.6 });
  const output = body.output_format as Record<string, unknown>;

  // В API Cartesia «Text to Speech (Bytes)» версии 2024-06-10 encoding принимает
  // только PCM (pcm_f32le/pcm_s16le/pcm_mulaw/pcm_alaw), а для mp3 нужен bit_rate.
  assert.deepEqual(output, { container: 'mp3', sample_rate: 44100, bit_rate: 128000 });
  assert.ok(!('encoding' in output), 'encoding для mp3 не передаётся');

  // Top-level speed в этой версии — строка-перечисление, не число.
  assert.equal(body.speed, 'fast');
  assert.equal(buildCartesiaBody('x', { speed: 0.5 }).speed, 'slow');
  assert.equal(buildCartesiaBody('x', { speed: 1 }).speed, 'normal');
  assert.equal(buildCartesiaBody('x', {}).speed, 'normal');

  // Дефолты не выдумываются заново: голос и язык из тела совпадают с фолбэком.
  assert.equal((body.voice as Record<string, unknown>).id, fallbackVoice('cartesia'));
  assert.equal(body.language, 'en');
  assert.equal(body.model_id, 'sonic-3');

  // Явные значения проходят как есть.
  const explicit = buildCartesiaBody('x', { voice: 'v-1', language: 'ru', model: 'sonic-3', speed: 1.2 });
  assert.equal((explicit.voice as Record<string, unknown>).id, 'v-1');
  assert.equal(explicit.language, 'ru');
  assert.equal(explicit.speed, 'fast');
});
