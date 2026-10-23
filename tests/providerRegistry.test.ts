import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROVIDER_REGISTRY,
  getImplementedProviders,
  getProxiedTTSProviderIds,
  getRegistryByKind,
  getRegistryEntry,
  getTTSCorsPolicy,
  isGeminiApi,
  isProxyUnsupported,
  resolveLLMProxyUrl,
} from '../src/lib/providers/registry';
import { LLM_PROVIDERS } from '../src/lib/providers/llm/catalog';
import { TTS_PROVIDERS } from '../src/lib/providers/tts/catalog';
import {
  CORS_BLOCKED_PROVIDERS,
  CLIENT_PROXY_PROVIDERS,
  mustUseProxy,
} from '../src/lib/providers/tts/cors';
import { getProviderLink } from '../src/lib/providers/links';

/**
 * P0-2: реестр — единственный источник правды.
 *
 * Тест ловит именно тот класс ошибки, из-за которого ТЗ и появилось: провайдер
 * добавили в каталог, но забыли в links/API/CORS — и он либо не показывается,
 * либо тихо ломается в рантайме.
 */

test('реестр: составные ключи уникальны, обязательные поля заполнены', () => {
  const keys = new Set<string>();
  for (const entry of PROVIDER_REGISTRY) {
    const key = `${entry.kind}:${entry.id}`;
    assert.ok(!keys.has(key), `дубль записи ${key}`);
    keys.add(key);

    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/, `${key}: id должен быть slug-ом`);
    assert.ok(entry.name.trim(), `${key}: пустое имя`);
    assert.ok(entry.description.trim(), `${key}: пустое описание`);
    assert.ok(entry.limits.trim(), `${key}: не указаны лимиты`);
    assert.ok(entry.freeTierDetail.trim(), `${key}: не указан free tier`);
    // У custom нет страницы получения ключа — это единственное исключение.
    if (entry.id !== 'custom') {
      assert.match(entry.keyUrl, /^https:\/\//, `${key}: ссылка на ключ должна быть https`);
    }
  }
});

test('реестр: у каждого LLM есть рабочий путь в /api/llm (или документированный отказ)', () => {
  for (const entry of getRegistryByKind('llm')) {
    if (isProxyUnsupported(entry.id)) {
      assert.equal(entry.api, 'anthropic', `${entry.id}: 501 должен быть только у Anthropic-протокола`);
      assert.equal(resolveLLMProxyUrl(entry.id), null);
      continue;
    }
    if (isGeminiApi(entry.id)) {
      assert.ok(entry.baseUrl, `${entry.id}: Gemini-ветке нужен baseUrl`);
      continue;
    }
    if (entry.id === 'custom') {
      // baseUrl задаёт пользователь — проверяем, что дефолта нет и запрос без него отвергается.
      assert.equal(resolveLLMProxyUrl('custom'), null);
      assert.equal(resolveLLMProxyUrl('custom', { baseUrl: 'http://localhost:1234/v1' }), 'http://localhost:1234/v1');
      continue;
    }
    // Провайдеры с accountId (Cloudflare) без него принципиально не проксируются.
    const url = resolveLLMProxyUrl(entry.id, entry.requiresAccountId ? { accountId: 'test-account' } : undefined);
    assert.ok(url, `${entry.id}: нет baseUrl для прокси — провайдер в реестре, но недоступен`);
  }
});

test('реестр: account_id подставляется, а не уходит шаблоном', () => {
  const withoutAccount = resolveLLMProxyUrl('cloudflare');
  assert.equal(withoutAccount, null, 'Cloudflare без accountId не должен давать URL');

  const url = resolveLLMProxyUrl('cloudflare', { accountId: 'acc/with space' });
  assert.ok(url && !url.includes('{account_id}'), 'шаблон должен быть заменён');
  assert.ok(url!.includes('acc%2Fwith%20space'), 'accountId кодируется');
});

test('каталог LLM целиком выводится из реестра', () => {
  const registryImpl = getImplementedProviders('llm');
  assert.deepEqual(
    LLM_PROVIDERS.map(provider => provider.id),
    registryImpl.map(entry => entry.id),
    'порядок и состав LLM должны совпадать с catalogOrder реестра'
  );

  for (const entry of registryImpl) {
    const provider = LLM_PROVIDERS.find(item => item.id === entry.id);
    assert.ok(provider, `${entry.id}: запись в реестре без реализации в каталоге`);
    assert.equal(provider!.name, entry.name, `${entry.id}: имя разъехалось с реестром`);
    assert.equal(provider!.description, entry.description);
    assert.equal(provider!.baseUrl, entry.baseUrl);
    assert.equal(provider!.defaultModel, entry.defaultModel || entry.models?.[0]);
    assert.equal(provider!.freeTier, entry.freeTier);
    assert.equal(provider!.trialOnly, entry.trialOnly);
    assert.equal(provider!.supportsVision, Boolean(entry.supportsVision));
    assert.deepEqual(provider!.visionModels ?? [], entry.visionModels ?? []);
    assert.deepEqual(provider!.models, entry.models ?? []);
  }

  // И наоборот: каждый провайдер каталога обязан быть в реестре.
  for (const provider of LLM_PROVIDERS) {
    assert.ok(getRegistryEntry('llm', provider.id), `${provider.id}: есть в каталоге, но нет в реестре`);
  }
});

test('каталог TTS целиком выводится из реестра', () => {
  const registryImpl = getImplementedProviders('tts');
  assert.deepEqual(
    TTS_PROVIDERS.map(provider => provider.id),
    registryImpl.map(entry => entry.id),
    'порядок и состав TTS должны совпадать с catalogOrder реестра'
  );

  for (const entry of registryImpl) {
    const provider = TTS_PROVIDERS.find(item => item.id === entry.id);
    assert.ok(provider, `${entry.id}: запись в реестре без реализации`);
    assert.equal(provider!.name, entry.name);
    assert.equal(provider!.description, entry.description);
    assert.equal(provider!.freeTier, entry.freeTier);
    assert.deepEqual(provider!.languages, entry.languages);
    assert.equal(Boolean(provider!.experimental), Boolean(entry.experimental));
    assert.equal(Boolean(provider!.proxyClientSide), Boolean(entry.proxyClientSide));
    assert.equal(provider!.baseUrl, entry.baseUrl);
    if (entry.defaultModel) assert.equal(provider!.defaultModel, entry.defaultModel);
  }

  for (const provider of TTS_PROVIDERS) {
    assert.ok(getRegistryEntry('tts', provider.id), `${provider.id}: есть в каталоге, но нет в реестре`);
  }
});

test('links.ts — проекция реестра: каждая запись доступна по своему виду', () => {
  for (const entry of PROVIDER_REGISTRY) {
    const link = getProviderLink(entry.id, entry.kind);
    assert.ok(link, `${entry.kind}:${entry.id}: нет ссылки для UI`);
    assert.equal(link!.category, entry.kind);
    assert.equal(link!.name, entry.name);
    assert.equal(link!.keyUrl, entry.keyUrl);
    assert.equal(link!.description, entry.linkDescription ?? entry.description);
  }

  // Поиск без категории разрешается в порядке llm → tts → stt (историческое поведение).
  assert.equal(getProviderLink('openai')?.category, 'llm');
  assert.equal(getProviderLink('openai', 'tts')?.category, 'tts');
  assert.equal(getProviderLink('openai-tts', 'tts')?.id, 'openai');
});

test('CORS-политика выводится из реестра и не противоречит сама себе', () => {
  const proxied = getProxiedTTSProviderIds();
  const registryProxied = getRegistryByKind('tts').filter(entry => getTTSCorsPolicy(entry.id) === 'proxy').map(entry => entry.id);
  assert.deepEqual([...proxied].sort(), [...registryProxied].sort());

  for (const provider of TTS_PROVIDERS) {
    assert.equal(mustUseProxy(provider.id), getTTSCorsPolicy(provider.id) === 'proxy', `${provider.id}: политика CORS разъехалась`);
    if (getTTSCorsPolicy(provider.id) !== 'proxy') {
      assert.equal(provider.proxyClientSide ?? false, false, `${provider.id}: direct-провайдер не может ходить через прокси с клиента`);
    }
  }

  // Разделение на «CORS blocked» и «нет клиентской реализации» сохраняется для UI.
  for (const id of CORS_BLOCKED_PROVIDERS) {
    assert.ok(!CLIENT_PROXY_PROVIDERS.has(id), `${id}: не может быть в обоих списках`);
    assert.equal(mustUseProxy(id), true);
  }
  for (const id of CLIENT_PROXY_PROVIDERS) {
    const entry = getRegistryEntry('tts', id);
    assert.equal(entry?.experimental, true, `${id}: в CLIENT_PROXY только экспериментальные`);
  }
  assert.deepEqual(
    [...new Set([...CORS_BLOCKED_PROVIDERS, ...CLIENT_PROXY_PROVIDERS])].sort(),
    [...proxied].sort(),
    'объединение списков должно покрывать всех проксируемых провайдеров'
  );
});

test('добавление провайдера не требует правок в API-маршрутах', () => {
  // Структурные guard-ы: если в маршрут снова заведут локальную карту URL,
  // тест упадёт и напомнит, что источник правды — реестр.
  const llmRoute = readFileSync('src/app/api/llm/route.ts', 'utf8');
  const seoRoute = readFileSync('src/app/api/seo/route.ts', 'utf8');
  for (const [name, source] of [['/api/llm', llmRoute], ['/api/seo', seoRoute]] as const) {
    assert.match(source, /resolveLLMProxyUrl/, `${name} должен брать URL из реестра`);
    assert.doesNotMatch(source, /providerConfigs/, `${name}: локальная карта провайдеров вернулась`);
    assert.doesNotMatch(source, /api\.(openai|groq|mistral)\.com/, `${name}: URL провайдера захардкожен`);
  }

  // У каждого TTS-провайдера с cors=proxy есть либо serverGenerate, либо
  // честный proxyClientSide-запрет (иначе сервер молча сходит в /api/tts).
  for (const provider of TTS_PROVIDERS) {
    if (getTTSCorsPolicy(provider.id) !== 'proxy') continue;
    const serverPath = provider.serverGenerate ?? (provider.proxyClientSide ? null : provider.generate);
    assert.ok(
      serverPath !== null || provider.proxyClientSide === true,
      `${provider.id}: проксируемый провайдер без серверного пути`
    );
  }
});

test('реестр не содержит «маркетинговых» записей без пути использования', () => {
  for (const entry of PROVIDER_REGISTRY) {
    if (entry.kind === 'stt') {
      // STT-провайдеры показываются только как ссылки/справка — у них нет
      // отдельного маршрута, это осознанно (см. README).
      assert.equal(entry.implemented, false);
      continue;
    }
    if (entry.implemented) continue;
    // LLM без UI-карточки обязан быть доступен через прокси, иначе это мёртвая ссылка.
    if (entry.kind === 'llm') {
      assert.ok(
        isProxyUnsupported(entry.id) || resolveLLMProxyUrl(entry.id),
        `${entry.id}: не реализован в каталоге и не доступен через /api/llm`
      );
    }
  }
});
