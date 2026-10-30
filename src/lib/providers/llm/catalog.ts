/**
 * Каталог LLM-провайдеров.
 *
 * Метаданные (имя, baseUrl, модели, vision, free tier) больше не дублируются
 * здесь — они берутся из единого реестра (`../registry.ts`). В этом файле
 * остаются только реализации протоколов:
 * - Gemini (`generateContent`) — отдельная ветка, потому что формат не
 *   OpenAI-совместимый;
 * - всё остальное — фабрика `createOpenAICompatibleProvider`.
 *
 * Чтобы добавить провайдера: одна запись в `registry.ts` (+ при необходимости
 * файл реализации протокола). `tests/providerRegistry.test.ts` проверит
 * консистентность.
 */

import { providerFetch } from '../http';
import { getImplementedProviders, type ProviderRegistryEntry } from '../registry';
import { createOpenAICompatibleProvider } from './openai-compatible';
import { LLMOptions, LLMProvider, Message, MessageContent } from './types';

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

async function generateGemini(
  baseUrl: string,
  fallbackModel: string,
  messages: Message[],
  options: LLMOptions
): Promise<string> {
  const model = options.model || fallbackModel;
  // Один повтор на 429/5xx: Gemini в LLM-режиме не имеет своего цикла повторов.
  const response = await providerFetch(baseUrl, `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
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
    },
    {
      label: 'Gemini',
      retries: 1,
      timeoutMs: 25_000,
      signal: options.signal,
      deadlineMs: options.deadlineMs,
    }
  );

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
}

function createGeminiProvider(entry: ProviderRegistryEntry): LLMProvider {
  const baseUrl = entry.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const defaultModel = entry.defaultModel || entry.models?.[0] || 'gemini-3-flash-preview';
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    baseUrl,
    models: entry.models ?? [],
    defaultModel,
    freeTier: entry.freeTier,
    freeTierNote: entry.freeTierNote,
    trialOnly: entry.trialOnly,
    limitsUrl: entry.limitsUrl,
    rateLimits: entry.rateLimits,
    apiKeyPrefix: entry.apiKeyPrefix,
    supportsVision: Boolean(entry.supportsVision),
    visionModels: entry.visionModels,
    async chat(messages, options) {
      return generateGemini(baseUrl, defaultModel, messages, options);
    },
    async vision(imageBase64, prompt, options) {
      const imageUrl = imageBase64.startsWith('data:')
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;
      return generateGemini(baseUrl, defaultModel, [
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
}

function createLLMProvider(entry: ProviderRegistryEntry): LLMProvider {
  if (entry.api === 'gemini') return createGeminiProvider(entry);
  if (entry.api === 'anthropic') {
    // Anthropic не OpenAI-совместимый: в каталоге его нет, а /api/llm отвечает 501.
    throw new Error(`LLM provider ${entry.id} uses the Anthropic protocol and cannot be created as OpenAI-compatible`);
  }

  const models = entry.models ?? [];
  const defaultModel = entry.defaultModel || models[0] || '';
  return createOpenAICompatibleProvider({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    baseUrl: entry.baseUrl ?? '',
    models,
    defaultModel,
    freeTier: entry.freeTier,
    vision: Boolean(entry.supportsVision),
    visionModels: entry.visionModels,
    freeTierNote: entry.freeTierNote,
    trialOnly: entry.trialOnly,
    limitsUrl: entry.limitsUrl,
    rateLimits: entry.rateLimits,
    apiKeyPrefix: entry.apiKeyPrefix,
    requiresAccountId: entry.requiresAccountId,
  });
}

/** Провайдеры с реализацией в каталоге, в порядке `catalogOrder` реестра. */
export const LLM_PROVIDERS: LLMProvider[] = getImplementedProviders('llm').map(createLLMProvider);

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
