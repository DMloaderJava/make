import { createOpenAICompatibleProvider } from './openai-compatible';
import { LLMOptions, LLMProvider, Message, MessageContent } from './types';

const geminiModels = ['gemini-3-flash-preview', 'gemini-3.6-flash'];

function toGeminiPart(content: MessageContent) {
  if (content.type === 'text') return { text: content.text || '' };
  if (content.type === 'image_url' && content.image_url?.url) {
    const url = content.image_url.url;
    const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
    return {
      inlineData: {
        mimeType: match?.[1] || 'image/jpeg',
        data: match?.[2] || (url.includes(',') ? url.slice(url.indexOf(',') + 1) : url),
      },
    };
  }
  return { text: '' };
}

function toGeminiContents(messages: Message[]) {
  const systemInstruction = messages.find(message => message.role === 'system')?.content;
  const contents = messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: typeof message.content === 'string'
        ? [{ text: message.content }]
        : message.content.map(toGeminiPart),
    }));
  return {
    systemInstruction: typeof systemInstruction === 'string' && systemInstruction
      ? { parts: [{ text: systemInstruction }] }
      : undefined,
    contents,
  };
}

async function generateGemini(messages: Message[], options: LLMOptions): Promise<string> {
  const model = options.model || geminiModels[0];
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': options.apiKey,
      },
      body: JSON.stringify({
        ...toGeminiContents(messages),
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 4000,
        },
      }),
    }
  );

  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(`Gemini error: ${response.status} — ${details.slice(0, 500)}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
}

const geminiProvider: LLMProvider = {
  id: 'gemini',
  name: 'Google Gemini',
  description: 'Free tier без карты · vision',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  models: geminiModels,
  defaultModel: geminiModels[0],
  freeTier: true,
  freeTierNote: '~30 промптов/день, vision + audio',
  limitsUrl: 'https://ai.google.dev/pricing',
  rateLimits: { rpm: 15, rpd: 30 },
  supportsVision: true,
  visionModels: geminiModels,
  async chat(messages, options) {
    return generateGemini(messages, options);
  },
  async vision(imageBase64, prompt, options) {
    const imageUrl = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;
    return generateGemini([
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Проанализируй изображение и верни JSON.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ], { ...options, temperature: options.temperature ?? 0.2 });
  },
};

const permanentFreeProviders: LLMProvider[] = [
  createOpenAICompatibleProvider({
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    description: '~1 000 кредитов при регистрации, ~40 RPM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'deepseek-ai/deepseek-v4.1-flash',
      'moonshotai/kimi-k3',
      'nvidia/nemotron-3-nano-omni-30b',
      'meta-llama/llama-3.2-90b-vision-instruct',
    ],
    defaultModel: 'deepseek-ai/deepseek-v4.1-flash',
    freeTier: true,
    freeTierNote: '~1 000 кредитов при регистрации, ~40 RPM',
    limitsUrl: 'https://build.nvidia.com/',
    rateLimits: { rpm: 40 },
    apiKeyPrefix: 'nvapi-',
    vision: true,
    visionModels: ['meta-llama/llama-3.2-90b-vision-instruct'],
  }),
  geminiProvider,
  createOpenAICompatibleProvider({
    id: 'groq',
    name: 'Groq',
    description: '30 RPM, 1 000 RPD, сверхбыстрый inference',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3.8-27b'],
    defaultModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    freeTier: true,
    freeTierNote: '30 RPM, 1 000 RPD, сверхбыстрый inference',
    limitsUrl: 'https://console.groq.com/docs/rate-limits',
    rateLimits: { rpm: 30, rpd: 1000 },
    vision: true,
    visionModels: ['meta-llama/llama-4-scout-17b-16e-instruct'],
  }),
  createOpenAICompatibleProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Каталог бесплатных моделей, включая :free',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'google/gemma-4-31b-it:free',
      'qwen/qwen3-coder:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'deepseek/deepseek-r1:free',
    ],
    defaultModel: 'google/gemma-4-31b-it:free',
    freeTier: true,
    freeTierNote: 'Каталог :free моделей; Gemma 4 31B поддерживает vision',
    limitsUrl: 'https://openrouter.ai/models?max_price=0',
    vision: true,
    visionModels: ['google/gemma-4-31b-it:free'],
  }),
  createOpenAICompatibleProvider({
    id: 'mistral',
    name: 'Mistral AI',
    description: '500K TPM, 1B токенов/мес (Experiment plan)',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'mistral-medium-3.5', 'pixtral-12b-2409'],
    defaultModel: 'mistral-small-latest',
    freeTier: true,
    freeTierNote: '500K TPM, 1B токенов/мес (Experiment plan)',
    limitsUrl: 'https://docs.mistral.ai/deployment/laplateforme/tier/',
    rateLimits: { rpm: 5 },
    vision: true,
    visionModels: ['pixtral-12b-2409'],
  }),
  createOpenAICompatibleProvider({
    id: 'huggingface',
    name: 'Hugging Face',
    description: '$0.10/мес, около 1 000 запросов/день',
    baseUrl: 'https://router.huggingface.co/v1',
    models: [
      'meta-llama/Llama-3.2-11B-Vision-Instruct',
      'Qwen/Qwen2-VL-72B-Instruct',
    ],
    defaultModel: 'meta-llama/Llama-3.2-11B-Vision-Instruct',
    freeTier: true,
    freeTierNote: '$0.10/мес кредитов, около 1 000 запросов/день',
    limitsUrl: 'https://huggingface.co/docs/api-inference/rate-limits',
    apiKeyPrefix: 'hf_',
    vision: true,
    visionModels: ['meta-llama/Llama-3.2-11B-Vision-Instruct', 'Qwen/Qwen2-VL-72B-Instruct'],
  }),
  createOpenAICompatibleProvider({
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description: '10 000 Neurons/день бесплатно',
    // OpenAI-compatible Workers AI API: /ai/v1/chat/completions.
    // /ai/run/{model} is the model-specific API and has a different request shape.
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    models: ['@cf/moonshotai/kimi-k2.5', '@cf/meta/llama-4-scout-17b-16e-instruct'],
    defaultModel: '@cf/moonshotai/kimi-k2.5',
    freeTier: true,
    freeTierNote: '10 000 Neurons/день, Kimi K2.5, Llama 4 Scout',
    limitsUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    requiresAccountId: true,
    vision: true,
    visionModels: ['@cf/meta/llama-4-scout-17b-16e-instruct'],
  }),
  createOpenAICompatibleProvider({
    id: 'siliconflow',
    name: 'SiliconFlow',
    description: '$1 при регистрации + постоянно-бесплатные модели',
    baseUrl: 'https://api.siliconflow.com/v1',
    models: ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B'],
    defaultModel: 'Qwen/Qwen3-8B',
    freeTier: true,
    freeTierNote: '$1 при регистрации + постоянно-бесплатные модели',
    limitsUrl: 'https://siliconflow.com/pricing',
    vision: false,
  }),
  createOpenAICompatibleProvider({
    id: 'zhipu',
    name: 'Zhipu AI (GLM)',
    description: 'GLM-4.7-Flash — полностью бесплатный API',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.7-flash', 'glm-5.3'],
    defaultModel: 'glm-4.7-flash',
    freeTier: true,
    freeTierNote: 'GLM-4.7-Flash — полностью бесплатный API',
    limitsUrl: 'https://open.bigmodel.cn/pricing',
    vision: false,
  }),
];

const trialProviders: LLMProvider[] = [
  createOpenAICompatibleProvider({
    id: 'ai21',
    name: 'AI21 Labs',
    description: '$10 кредит на 3 месяца',
    baseUrl: 'https://api.ai21.com/studio/v1',
    models: ['jamba-large', 'jamba-mini'],
    defaultModel: 'jamba-large',
    freeTier: false,
    trialOnly: true,
    freeTierNote: '$10 кредит на 3 месяца',
    limitsUrl: 'https://docs.ai21.com/docs/usage-cost',
    vision: false,
  }),
  createOpenAICompatibleProvider({
    id: 'novita',
    name: 'Novita AI',
    description: '$100 promotional credits после короткого опроса',
    baseUrl: 'https://api.novita.ai/openai',
    models: ['inclusionai/ling-3.0-flash-vl', 'deepseek/deepseek-v4.1-flash'],
    defaultModel: 'inclusionai/ling-3.0-flash-vl',
    freeTier: false,
    trialOnly: true,
    freeTierNote: '$100 promotional credits после короткого опроса',
    limitsUrl: 'https://novita.ai/pricing',
    vision: true,
    visionModels: ['inclusionai/ling-3.0-flash-vl'],
  }),
  createOpenAICompatibleProvider({
    id: 'moonshot',
    name: 'Moonshot AI (Kimi)',
    description: '$5 кредитов каждые 30 дней для free-пользователей',
    baseUrl: 'https://api.moonshot.ai/v1',
    models: ['kimi-k2.6', 'moonshot-v1-8k-vision-preview'],
    defaultModel: 'kimi-k2.6',
    freeTier: false,
    trialOnly: true,
    freeTierNote: '$5 кредитов каждые 30 дней',
    limitsUrl: 'https://platform.moonshot.ai/docs/pricing',
    vision: true,
    visionModels: ['moonshot-v1-8k-vision-preview'],
  }),
];

const customProvider = createOpenAICompatibleProvider({
  id: 'custom',
  name: 'Custom OpenAI-compatible',
  description: 'Пользовательский OpenAI-совместимый endpoint',
  baseUrl: '',
  models: ['custom-model'],
  defaultModel: 'custom-model',
  freeTier: false,
  vision: true,
});

/** 9 постоянных free-провайдеров, 3 trial-провайдера и отдельный custom endpoint. */
export const LLM_PROVIDERS: LLMProvider[] = [
  ...permanentFreeProviders,
  ...trialProviders,
  customProvider,
];

/** Explicit allowlist: a provider flag alone cannot prove that every model accepts images. */
export function getLLMProviderVisionModels(provider: LLMProvider): string[] {
  if (!provider.supportsVision || provider.id === 'custom') return [];
  return (provider.visionModels || []).filter(model => provider.models.includes(model));
}

export function isLLMModelVisionCapable(provider: LLMProvider | string, model: string): boolean {
  if (!model) return false;
  const resolvedProvider = typeof provider === 'string' ? getLLMProvider(provider) : provider;
  if (!resolvedProvider || !resolvedProvider.supportsVision) return false;
  if (resolvedProvider.id === 'custom') return true;
  return getLLMProviderVisionModels(resolvedProvider).includes(model);
}

/** Выбирает конкретную модель с image input, либо сообщает, что у провайдера её нет. */
export function resolveLLMVisionModel(provider: LLMProvider, requestedModel: string): string | null {
  if (provider.id === 'custom') return requestedModel || provider.defaultModel || null;
  const visionModels = getLLMProviderVisionModels(provider);
  if (visionModels.length === 0) return null;
  return visionModels.includes(requestedModel) ? requestedModel : visionModels[0];
}

export function getDefaultLLMVisionModel(provider: LLMProvider): string | null {
  if (provider.id === 'custom') return provider.defaultModel || null;
  return getLLMProviderVisionModels(provider)[0] || null;
}

/** Переключаемся только между постоянными бесплатными провайдерами. */
export const FREE_FALLBACK_CHAIN = ['gemini', 'groq', 'nvidia-nim', 'openrouter', 'mistral'] as const;

export function getLLMProvider(id: string): LLMProvider | undefined {
  // Migration alias for projects created before the Google provider was renamed.
  const canonicalId = id === 'google-ai' ? 'gemini' : id;
  return LLM_PROVIDERS.find(provider => provider.id === canonicalId);
}
