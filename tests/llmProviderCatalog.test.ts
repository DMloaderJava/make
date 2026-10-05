import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, getSettings, LS_KEYS } from '../src/lib/storage/local';
import { FREE_FALLBACK_CHAIN, getDefaultLLMVisionModel, getLLMProvider, getLLMProviderVisionModels, isLLMModelVisionCapable, LLM_PROVIDERS, resolveLLMVisionModel } from '../src/lib/providers/llm/catalog';
import { generateLLM, mapLLMProviderError } from '../src/lib/providers/llm/router';

const permanentFreeIds = [
  'nvidia-nim', 'gemini', 'groq', 'openrouter', 'mistral',
  'huggingface', 'cloudflare', 'siliconflow', 'zhipu',
];
const trialIds = ['ai21', 'novita', 'moonshot'];

test('LLM catalog exposes the nine selected permanent free providers', () => {
  const freeProviders = LLM_PROVIDERS.filter(provider => provider.freeTier);
  assert.deepEqual(freeProviders.map(provider => provider.id).sort(), [...permanentFreeIds].sort());
  for (const provider of freeProviders) {
    assert.ok(provider.freeTierNote, `${provider.id} must explain its free tier`);
    assert.ok(provider.limitsUrl, `${provider.id} must link to its limits`);
  }
});

test('NVIDIA NIM free-tier metadata reflects the reviewed signup credits and RPM', () => {
  const nvidia = getLLMProvider('nvidia-nim')!;
  assert.match(nvidia.freeTierNote || '', /1 000 кредитов/);
  assert.match(nvidia.freeTierNote || '', /40 RPM/);
});

test('trial providers are not represented as permanent free tiers', () => {
  const trials = LLM_PROVIDERS.filter(provider => provider.trialOnly);
  assert.deepEqual(trials.map(provider => provider.id).sort(), [...trialIds].sort());
  for (const provider of trials) {
    assert.equal(provider.freeTier, false, `${provider.id} is trial-only`);
    assert.ok(provider.freeTierNote);
    assert.ok(provider.limitsUrl);
  }
  assert.equal(getLLMProvider('ai21')?.freeTierNote, '$10 кредит на 3 месяца');
});

test('the default OpenRouter model is free and vision-capable', () => {
  const openrouter = getLLMProvider('openrouter')!;
  assert.equal(openrouter.defaultModel, 'google/gemma-4-31b-it:free');
  assert.ok(openrouter.models.includes(DEFAULT_SETTINGS.defaultVisionModel));
  assert.equal(DEFAULT_SETTINGS.defaultVisionModel, openrouter.defaultModel);
  assert.match(DEFAULT_SETTINGS.defaultVisionModel, /:free$/);
  assert.ok(openrouter.models.every(model => model.endsWith(':free')), 'OpenRouter choices must be free endpoints');
});

test('legacy OpenRouter text models are rejected as vision models, with or without :free', () => {
  const openrouter = getLLMProvider('openrouter')!;
  for (const model of ['qwen/qwen3-coder', 'qwen/qwen3-coder:free']) {
    assert.equal(isLLMModelVisionCapable('openrouter', model), false);
    assert.equal(resolveLLMVisionModel(openrouter, model), openrouter.defaultModel);
  }
  assert.equal(resolveLLMVisionModel(openrouter, 'nvidia/nemotron-3-ultra-550b-a55b:free'), openrouter.defaultModel);
});

test('vision model allowlists reject text-only providers and resolve provider-specific vision defaults', () => {
  for (const id of ['siliconflow', 'zhipu']) {
    const provider = getLLMProvider(id)!;
    assert.equal(provider.supportsVision, false);
    assert.deepEqual(getLLMProviderVisionModels(provider), []);
    assert.equal(resolveLLMVisionModel(provider, provider.defaultModel), null);
  }

  const nvidia = getLLMProvider('nvidia-nim')!;
  assert.equal(isLLMModelVisionCapable(nvidia, 'deepseek-ai/deepseek-v4.1-flash'), false);
  assert.equal(resolveLLMVisionModel(nvidia, nvidia.defaultModel), 'meta-llama/llama-3.2-90b-vision-instruct');
  assert.equal(getDefaultLLMVisionModel(nvidia), 'meta-llama/llama-3.2-90b-vision-instruct');

  const mistral = getLLMProvider('mistral')!;
  assert.equal(isLLMModelVisionCapable(mistral, 'mistral-small-latest'), false);
  assert.equal(resolveLLMVisionModel(mistral, mistral.defaultModel), 'pixtral-12b-2409');
});

test('local settings migrate both legacy Qwen OpenRouter IDs to the free vision default', () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const hadWindow = 'window' in globals;
  const previousWindow = globals.window;
  const hadStorage = 'localStorage' in globals;
  const previousStorage = globals.localStorage;
  const values = new Map<string, string>();
  globals.window = {};
  globals.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };

  try {
    for (const legacyModel of ['qwen/qwen3-coder', 'qwen/qwen3-coder:free']) {
      values.set(LS_KEYS.SETTINGS, JSON.stringify({
        ...DEFAULT_SETTINGS,
        defaultLLMProvider: 'openrouter',
        defaultVisionModel: legacyModel,
      }));
      const settings = getSettings();
      assert.equal(settings.defaultVisionModel, DEFAULT_SETTINGS.defaultVisionModel);
      assert.equal(JSON.parse(values.get(LS_KEYS.SETTINGS) || '{}').defaultVisionModel, DEFAULT_SETTINGS.defaultVisionModel);
    }
  } finally {
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
    if (hadStorage) globals.localStorage = previousStorage;
    else delete globals.localStorage;
  }
});

test('Cloudflare has a separate Account ID setting and a templated endpoint', () => {
  const cloudflare = getLLMProvider('cloudflare');
  assert.equal(cloudflare?.requiresAccountId, true);
  assert.match(cloudflare?.baseUrl || '', /accounts\/\{account_id\}\/ai\/v1$/);
  assert.equal(DEFAULT_SETTINGS.cloudflareAccountId, '');
});

test('excluded providers are absent and the fallback chain only uses permanent free providers', () => {
  const excludedIds = ['together', 'replicate', 'deepseek', 'anthropic', 'xai', 'cohere', 'perplexity'];
  for (const id of excludedIds) {
    assert.equal(LLM_PROVIDERS.some(provider => provider.id === id), false, `${id} must be excluded`);
    assert.equal(FREE_FALLBACK_CHAIN.includes(id as typeof FREE_FALLBACK_CHAIN[number]), false);
  }
  for (const id of FREE_FALLBACK_CHAIN) {
    const provider = getLLMProvider(id);
    assert.equal(provider?.freeTier, true, `${id} must be permanently free`);
    assert.equal(provider?.trialOnly, undefined);
  }
});

test('old Google AI provider ID migrates to Gemini', () => {
  assert.equal(getLLMProvider('google-ai')?.id, 'gemini');
});

test('LLM error mapping gives actionable quota and provider-specific messages', () => {
  assert.match(mapLLMProviderError({ providerId: 'groq', status: 429, responseBody: '{}' }), /30 RPM \/ 1 000 RPD/);
  assert.match(mapLLMProviderError({ providerId: 'gemini', status: 403, responseBody: '{"error":{"status":"quotaExceeded"}}' }), /00:00 PST/);
  assert.match(mapLLMProviderError({ providerId: 'nvidia-nim', status: 402, responseBody: 'payment required' }), /кредиты NVIDIA NIM исчерпаны/i);
  const cloudflareHint = mapLLMProviderError({ providerId: 'cloudflare', status: 400, responseBody: 'Укажите Account ID в настройках провайдера.' });
  assert.match(cloudflareHint, /Account ID/);
  assert.match(cloudflareHint, /поле Cloudflare/);
  assert.match(mapLLMProviderError({ providerId: 'mistral', status: 429, responseBody: 'Experiment plan limit' }), /5 RPM/);
  assert.match(mapLLMProviderError({ providerId: 'huggingface', status: 503, responseBody: 'overloaded' }), /перегружен/i);
});

test('generateLLM switches from a 429 provider to the next configured free provider', async () => {
  const primary = getLLMProvider('openrouter')!;
  const calls: Array<{ providerId: string; apiKey: string; model: string }> = [];
  const result = await generateLLM({
    provider: primary,
    options: { apiKey: 'openrouter-key', model: primary.defaultModel },
    apiKeys: { gemini: 'gemini-key', together: 'excluded-key', deepseek: 'excluded-key' },
    invoke: async (provider, options) => {
      calls.push({ providerId: provider.id, apiKey: options.apiKey, model: options.model });
      if (provider.id === 'openrouter') throw new Error('OpenRouter error: 429 — {"message":"rate limit"}');
      if (provider.id === 'gemini') return 'fallback response';
      throw new Error(`unexpected provider ${provider.id}`);
    },
  });

  assert.equal(result, 'fallback response');
  assert.deepEqual(calls, [
    { providerId: 'openrouter', apiKey: 'openrouter-key', model: primary.defaultModel },
    { providerId: 'gemini', apiKey: 'gemini-key', model: getLLMProvider('gemini')!.defaultModel },
  ]);
});

test('vision fallback selects a vision model instead of the provider text default', async () => {
  const primary = getLLMProvider('openrouter')!;
  const calls: Array<{ providerId: string; model: string }> = [];
  const result = await generateLLM({
    provider: primary,
    task: 'vision',
    options: { apiKey: 'openrouter-key', model: primary.defaultModel },
    apiKeys: { 'nvidia-nim': 'nvidia-key' },
    invoke: async (provider, options) => {
      calls.push({ providerId: provider.id, model: options.model });
      if (provider.id === 'openrouter') throw new Error('OpenRouter error: 429 — {"message":"rate limit"}');
      return 'vision fallback response';
    },
  });

  assert.equal(result, 'vision fallback response');
  assert.deepEqual(calls, [
    { providerId: 'openrouter', model: primary.defaultModel },
    { providerId: 'nvidia-nim', model: 'meta-llama/llama-3.2-90b-vision-instruct' },
  ]);
});

test('generateLLM resolves a text default to the provider vision model for a vision task', async () => {
  const provider = getLLMProvider('nvidia-nim')!;
  let modelUsed = '';
  const result = await generateLLM({
    provider,
    task: 'vision',
    options: { apiKey: 'nvidia-key', model: provider.defaultModel },
    apiKeys: {},
    invoke: async (_candidate, options) => {
      modelUsed = options.model;
      return 'vision result';
    },
  });

  assert.equal(result, 'vision result');
  assert.equal(modelUsed, 'meta-llama/llama-3.2-90b-vision-instruct');
});

test('generateLLM rejects a vision task for providers with no vision model', async () => {
  const provider = getLLMProvider('siliconflow')!;
  let calls = 0;
  await assert.rejects(
    () => generateLLM({
      provider,
      task: 'vision',
      options: { apiKey: 'siliconflow-key', model: provider.defaultModel },
      apiKeys: {},
      invoke: async () => { calls++; return 'unexpected'; },
    }),
    /не имеет доступной модели для анализа изображений/,
  );
  assert.equal(calls, 0);
});

test('Gemini quota-exhausted 403 also triggers free-provider fallback', async () => {
  const primary = getLLMProvider('gemini')!;
  const calls: string[] = [];
  const result = await generateLLM({
    provider: primary,
    options: { apiKey: 'gemini-key', model: primary.defaultModel },
    apiKeys: { groq: 'groq-key' },
    invoke: async candidate => {
      calls.push(candidate.id);
      if (candidate.id === 'gemini') {
        throw new Error('Gemini error: 403 — {"error":{"status":"RESOURCE_EXHAUSTED"}}');
      }
      return 'fallback response';
    },
  });
  assert.equal(result, 'fallback response');
  assert.deepEqual(calls, ['gemini', 'groq']);
});

test('generateLLM does not fall back for non-quota failures', async () => {
  const primary = getLLMProvider('openrouter')!;
  const calls: string[] = [];
  await assert.rejects(
    () => generateLLM({
      provider: primary,
      options: { apiKey: 'openrouter-key', model: primary.defaultModel },
      apiKeys: { gemini: 'gemini-key' },
      invoke: async candidate => {
        calls.push(candidate.id);
        throw new Error('OpenRouter error: 400 — invalid model');
      },
    }),
    /OpenRouter 400 — invalid model/
  );
  assert.deepEqual(calls, ['openrouter']);
});

test('Cloudflare substitutes Account ID into its OpenAI-compatible URL', async () => {
  const cloudflare = getLLMProvider('cloudflare')!;
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const response = await cloudflare.chat([{ role: 'user', content: 'hi' }], {
      apiKey: 'cloudflare-token',
      accountId: 'account-123',
      model: cloudflare.defaultModel,
    });
    assert.equal(response, 'ok');
    assert.equal(urls[0], 'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/chat/completions');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
