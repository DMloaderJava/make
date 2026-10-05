import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TTS_PROVIDERS, getServerGenerate } from '../src/lib/providers/tts/catalog';
import { mustUseProxy } from '../src/lib/providers/tts/cors';
import { generateTTS, assertClientContext } from '../src/lib/providers/tts/router';

/**
 * Структурная защита от рекурсии «сервер → /api/tts → сервер».
 *
 * Проверяем поведением, а не поиском подстроки в исходнике: подменяем fetch на
 * «отравленный» (любой поход в /api/tts — это рекурсия) и вызываем серверный
 * путь каждого провайдера. Провайдер либо обязан отказаться от серверного
 * вызова (getServerGenerate → null), либо упасть на сетевой заглушке, но не
 * сходить в собственный API.
 */
test('серверный путь провайдеров не уходит в /api/tts (проверка поведением)', async () => {
  const originalFetch = globalThis.fetch;
  const recursionCalls: string[] = [];
  const poisoned: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/tts')) {
      recursionCalls.push(url);
      throw new Error('RECURSION: серверный путь обратился к /api/tts');
    }
    // Сеть в тестах недоступна — для нас важно лишь, куда именно пошёл вызов.
    throw new Error(`network disabled in test: ${url}`);
  }) as typeof fetch;

  globalThis.fetch = poisoned;
  try {
    for (const provider of TTS_PROVIDERS) {
      const serverGenerate = getServerGenerate(provider);
      if (!serverGenerate) continue; // серверная ветка запрещена — это и есть защита
      await assert.rejects(
        () => serverGenerate('тест', { apiKey: 'dummy', voice: '' }),
        (error: Error) => {
          assert.doesNotMatch(error.message, /RECURSION/, `${provider.id} зациклится на сервере`);
          return true;
        },
        `${provider.id}: серверный путь должен либо отсутствовать, либо не ходить в /api/tts`
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(recursionCalls, [], 'ни один провайдер не должен звать /api/tts с сервера');
});

test('proxyClientSide-провайдеры не имеют серверного пути вообще', () => {
  const proxied = TTS_PROVIDERS.filter(p => p.proxyClientSide);
  assert.ok(proxied.length > 0, 'есть провайдеры, которые ходят через прокси с клиента');
  for (const provider of proxied) {
    assert.equal(getServerGenerate(provider), null, `${provider.id}: серверу нельзя звать клиентскую generate()`);
  }
});

test('провайдеры, обязанные идти через прокси, имеют безопасный серверный путь', () => {
  for (const provider of TTS_PROVIDERS) {
    if (!mustUseProxy(provider.id)) continue;
    const serverImpl = getServerGenerate(provider);
    assert.ok(
      serverImpl !== null || provider.proxyClientSide === true,
      `${provider.id}: нет серверной реализации — сервер вернёт 501 вместо рекурсии`
    );
  }
});

test('getServerGenerate: без флага отдаёт generate(), с флагом — null', () => {
  const safe = TTS_PROVIDERS.find(p => !p.proxyClientSide);
  assert.ok(safe, 'должен быть хотя бы один провайдер с прямой реализацией');
  assert.equal(getServerGenerate(safe!), safe!.generate);

  const proxied = TTS_PROVIDERS.find(p => p.proxyClientSide);
  assert.ok(proxied, 'polly помечен как проксируемый на клиенте');
  assert.equal(getServerGenerate(proxied!), null);
});

test('generateTTS на сервере падает сразу (структурный guard от рекурсии)', async () => {
  // Тест выполняется в Node, где window нет — это ровно серверный контекст.
  assert.throws(() => assertClientContext(), /клиентский путь/);

  await assert.rejects(
    () => generateTTS({ providerId: 'gemini', text: 'тест', apiKey: 'key' }),
    /клиентский путь/,
    'серверный вызов клиентского пути должен падать, а не уходить в /api/tts'
  );
});

test('assertClientContext: полифилл self не отключает защиту от рекурсии', () => {
  // Признак сервера — отсутствие window, а не наличие self: self может
  // появиться от полифилла (jsdom, globalThis.self = globalThis), и проверка
  // на «нет window и нет self» молча пропустила бы серверный вызов.
  const globals = globalThis as Record<string, unknown>;
  const hadSelf = 'self' in globals;
  const previousSelf = globals.self;
  globals.self = globals;
  try {
    assert.throws(() => assertClientContext(), /клиентский путь/, 'self не должен считаться браузером');
  } finally {
    if (hadSelf) globals.self = previousSelf;
    else delete globals.self;
  }
});

test('mustUseProxy покрывает и CORS-провайдеров, и «клиентских»', () => {
  for (const id of ['elevenlabs', 'openai', 'polly', 'azure', 'deepgram', 'playht', 'resemble', 'murf', 'fish', 'hume', 'speechify']) {
    assert.equal(mustUseProxy(id), true, `${id} должен идти через /api/tts`);
  }
  assert.equal(mustUseProxy('gemini'), false);
  assert.equal(mustUseProxy('cartesia'), false);
});

test('Gemini model unavailable returns a readable 404 and suggested model list', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const previousWindow = globals.window;
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globals.window = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const model = url.match(/\/models\/([^:]+):generateContent/)?.[1] || 'unknown';
    return new Response(JSON.stringify({ error: { message: `models/${model} is not found` } }), { status: 404 });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => generateTTS({ providerId: 'gemini', text: 'test', apiKey: 'k', model: 'gemini-legacy-unavailable' }),
      (error: Error) => {
        assert.match(error.message, /Gemini 404/);
        assert.match(error.message, /Модель gemini-3\.1-flash-tts-preview не найдена/);
        assert.match(error.message, /gemini-3\.8-flash-tts/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
  }

  assert.equal(requests.length, 4, 'requested model plus all catalog fallbacks were tried');
});

test('supportsSpeed=false честно означает «speed не уходит в API»', async () => {
  // Поведенческая проверка: провайдеры, помеченные в реестре как не поддерживающие
  // темп, не должны отправлять speed — иначе UI-пометка «не поддерживается» лгала бы.
  //
  // Мок отвечает пустой формой: тест проверяет ТЕЛО ЗАПРОСА, а не парсинг ответа,
  // поэтому смена формата ответа у провайдера его не сломает (ошибки разбора глотаем).
  const { geminiTTS } = await import('../src/lib/providers/tts/gemini');
  const { openAITTS } = await import('../src/lib/providers/tts/openai');
  const { speechifyTTS } = await import('../src/lib/providers/tts/speechify');

  const requests: Array<{ url: string; body: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: 'AQIDBA==' } }] } }] }),
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;

  try {
    await geminiTTS.generate('тест', { apiKey: 'k', voice: 'Puck', speed: 1.6 }).catch(() => {});
    await speechifyTTS.generate('тест', { apiKey: 'k', voice: 'matthew', speed: 1.6 }).catch(() => {});
    await openAITTS.generate('тест', { apiKey: 'k', voice: 'alloy', speed: 1.6 }).catch(() => {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const host = (name: string) => requests.filter(r => r.url.includes(name));
  const gemini = host('generativelanguage.googleapis.com');
  const speechify = host('api.sws.speechify.com');
  const openai = host('api.openai.com');

  assert.equal(gemini.length, 1, `запрос gemini не ушёл: ${requests.map(r => r.url).join(', ')}`);
  assert.equal(speechify.length, 1, `запрос speechify не ушёл: ${requests.map(r => r.url).join(', ')}`);
  assert.equal(openai.length, 1, `запрос openai не ушёл: ${requests.map(r => r.url).join(', ')}`);

  assert.equal(geminiTTS.supportsSpeed, false, 'gemini помечен как не поддерживающий темп');
  assert.equal(speechifyTTS.supportsSpeed, false, 'speechify помечен как не поддерживающий темп');
  assert.ok(!gemini[0].body.includes('speed'), `gemini отправил speed: ${gemini[0].body}`);
  assert.ok(!speechify[0].body.includes('speed'), `speechify отправил speed: ${speechify[0].body}`);
  // Контроль с другой стороны: провайдер, который темп поддерживает, его передаёт.
  assert.ok(openai[0].body.includes('"speed":1.6'), `openai не передал speed: ${openai[0].body}`);
});
