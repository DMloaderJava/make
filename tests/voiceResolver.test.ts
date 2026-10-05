import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVoice, fallbackVoice } from '../src/lib/providers/tts/voice-resolver';
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

test('resolveVoice: сентинел "default" не считается выбором ни у одного провайдера', async () => {
  // У resemble и fish 'default' встречается в курированном списке как заглушка:
  // если принять её за выбор, в API уйдёт voice_id='default' и ошибку
  // сформулирует провайдер. Лучше отказать сразу и попросить настоящий id.
  for (const id of ['resemble', 'fish', 'speechify', 'murf', 'hume', 'playht']) {
    await withFetch(forbiddenFetch, async () => {
      await assert.rejects(
        () => resolveVoice(id, 'key', 'default'),
        /вручную|укажите голос/i,
        `${id}: 'default' не должен уходить в API как голос`
      );
    });
  }
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

test('resolveVoice: Deepgram chooses Aura-2 by requested language and Flux by default', async () => {
  assert.equal(await resolveVoice('deepgram', 'key'), 'flux-hannah-en');
  assert.equal(await resolveVoice('deepgram', 'key', undefined, 'es-ES'), 'aura-2-celeste-es');
  assert.equal(await resolveVoice('deepgram', 'key', undefined, 'ja-JP'), 'aura-2-izanami-ja');
  await assert.rejects(() => resolveVoice('deepgram', 'key', undefined, 'ru'), /не поддерживает язык ru/);
});

test('resolveVoice: проверенный провайдер с рабочим API отдаёт первый реальный голос', async () => {
  await withFetch(jsonFetch({ data: [{ id: 'real-voice-1', name: 'Real 1' }] }), async () => {
    const voice = await resolveVoice('cartesia', 'key');
    assert.equal(voice, 'real-voice-1');
  });
});
