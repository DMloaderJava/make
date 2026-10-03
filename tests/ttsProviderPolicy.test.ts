import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TTS_PROVIDERS, getServerGenerate } from '../src/lib/providers/tts/catalog';
import { mustUseProxy } from '../src/lib/providers/tts/cors';
import { generateTTS, assertClientContext } from '../src/lib/providers/tts/router';

const TTS_DIR = join(process.cwd(), 'src/lib/providers/tts');

/**
 * Структурная защита от рекурсии «сервер → /api/tts → сервер».
 *
 * Проверяем не список известных провайдеров, а сам факт: если клиентская
 * реализация обращается к /api/tts, провайдер обязан быть помечен
 * `proxyClientSide: true` — тогда сервер откажется её вызывать.
 */
test('провайдер, чья generate() ходит в /api/tts, обязан иметь proxyClientSide: true', () => {
  const offenders: string[] = [];

  for (const file of readdirSync(TTS_DIR).filter(f => f.endsWith('.ts'))) {
    const source = readFileSync(join(TTS_DIR, file), 'utf8');
    // Интересуют только модули-провайдеры, а не router/catalog/mime.
    if (!/:\s*TTSProvider\s*=/.test(source)) continue;
    const callsProxy = /fetch\(\s*['"`]\/api\/tts['"`]/.test(source);
    if (!callsProxy) continue;
    if (!/proxyClientSide\s*:\s*true/.test(source)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    `Эти файлы зовут /api/tts, но не помечены proxyClientSide — сервер может зациклиться: ${offenders.join(', ')}`
  );
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

test('mustUseProxy покрывает и CORS-провайдеров, и «клиентских»', () => {
  for (const id of ['elevenlabs', 'openai', 'polly', 'azure', 'deepgram', 'playht', 'resemble', 'murf', 'fish', 'hume', 'speechify']) {
    assert.equal(mustUseProxy(id), true, `${id} должен идти через /api/tts`);
  }
  assert.equal(mustUseProxy('gemini'), false);
  assert.equal(mustUseProxy('cartesia'), false);
});
