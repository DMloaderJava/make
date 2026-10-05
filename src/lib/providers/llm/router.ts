import { getAllKeys } from '@/lib/storage/local';
import { FREE_FALLBACK_CHAIN, getDefaultLLMVisionModel, getLLMProvider, resolveLLMVisionModel } from './catalog';
import type { LLMOptions, LLMProvider } from './types';

export interface LLMProviderErrorInput {
  providerId: string;
  status: number;
  responseBody: string;
  model?: string;
}

function parseJson(value: string): unknown {
  const candidates = [value.trim()];
  const start = value.search(/[\[{]/);
  if (start > 0) candidates.push(value.slice(start).trim());
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return undefined;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') {
    const nested = parseJson(value);
    return nested === undefined ? [value] : [value, ...collectText(nested, depth + 1)];
  }
  if (Array.isArray(value)) return value.flatMap(item => collectText(item, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(item => collectText(item, depth + 1));
  }
  return [String(value)];
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value == null) return undefined;
  if (typeof value === 'string') {
    const nested = parseJson(value);
    return nested === undefined ? value.trim() || undefined : findMessage(nested, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = findMessage(item, depth + 1);
      if (message) return message;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'detail', 'error_description', 'error', 'code', 'status']) {
      if (!(key in record)) continue;
      const message = findMessage(record[key], depth + 1);
      if (message) return message;
    }
  }
  return undefined;
}

/** Переводит HTTP-ошибки LLM API в сообщения с конкретным следующим шагом. */
export function mapLLMProviderError({ providerId, status, responseBody, model }: LLMProviderErrorInput): string {
  const names: Record<string, string> = {
    'nvidia-nim': 'NVIDIA NIM',
    gemini: 'Gemini',
    'google-ai': 'Gemini',
    groq: 'Groq',
    openrouter: 'OpenRouter',
    mistral: 'Mistral',
    huggingface: 'Hugging Face',
    cloudflare: 'Cloudflare Workers AI',
    siliconflow: 'SiliconFlow',
    zhipu: 'Zhipu AI',
    ai21: 'AI21 Labs',
    novita: 'Novita AI',
    moonshot: 'Moonshot AI',
  };
  const label = names[providerId] || providerId;
  const payload = parseJson(responseBody);
  const normalizedBody = [responseBody, ...collectText(payload)].join(' ');
  const searchable = normalizedBody.toLowerCase();
  let hint: string | undefined;

  if (providerId === 'gemini' && status === 403 && /quota[_\s-]?exceeded|resource_exhausted|daily quota/i.test(searchable)) {
    hint = 'Дневная квота Gemini исчерпана. Сброс квоты — в 00:00 PST.';
  } else if (providerId === 'nvidia-nim' && status === 402) {
    hint = 'Кредиты NVIDIA NIM исчерпаны. Пополните баланс или смените провайдера.';
  } else if (providerId === 'cloudflare' && status === 400 && /account[_\s-]?id|account id/i.test(searchable)) {
    hint = 'Укажите Account ID в поле Cloudflare в настройках провайдера.';
  } else if (providerId === 'mistral' && status === 429 && /experiment/i.test(searchable)) {
    hint = 'Mistral Experiment plan: лимит 5 RPM. Подождите перед повтором.';
  } else if (providerId === 'huggingface' && status === 503) {
    hint = 'Hugging Face Inference API перегружен. Попробуйте позже.';
  } else if (providerId === 'groq' && status === 429) {
    hint = 'Groq: лимит 30 RPM / 1 000 RPD. Попробуйте снова через минуту.';
  } else if (status === 429) {
    hint = 'Превышен лимит запросов (RPM/RPD). Подождите или смените провайдера.';
  }

  if (hint) return `${label} ${status} — ${hint}`;
  const detail = findMessage(payload) || responseBody.trim() || model && `модель ${model}` || 'неизвестная ошибка';
  return `${label} ${status} — ${detail.slice(0, 500)}`;
}

export interface LLMHttpError {
  status: number;
  responseBody: string;
}

export function getLLMHttpError(error: unknown): LLMHttpError | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:error|failed|proxy error|vision error):\s*(\d{3})\s*[—-]\s*([\s\S]*)/i)
    || message.match(/\bHTTP\s*(\d{3})\s*[-—:]?\s*([\s\S]*)/i);
  if (!match) return null;
  return { status: Number(match[1]), responseBody: match[2] || '' };
}

export interface GenerateLLMRequest {
  provider: LLMProvider;
  options: LLMOptions;
  task?: 'chat' | 'vision';
  /** Test seam; production defaults to the keys saved in browser localStorage. */
  apiKeys?: Record<string, string>;
  invoke: (provider: LLMProvider, options: LLMOptions) => Promise<string>;
}

function providerKey(keys: Record<string, string>, providerId: string): string {
  if (providerId === 'gemini') return keys.gemini || keys['google-ai'] || '';
  return keys[providerId] || '';
}

/**
 * Executes one LLM operation and starts cross-provider fallback on 429/402,
 * plus Gemini's explicit 403 quota-exhausted response. Trial providers and
 * paid/legacy providers are never fallback targets.
 */
export async function generateLLM(request: GenerateLLMRequest): Promise<string> {
  const { provider, options, apiKeys, invoke } = request;
  const task = request.task || 'chat';
  const primary = getLLMProvider(provider.id) || provider;
  const primaryId = primary.id;
  const primaryModel = task === 'vision'
    ? resolveLLMVisionModel(primary, options.model)
    : options.model;
  if (task === 'vision' && !primaryModel) {
    throw new Error(`${primary.name} не имеет доступной модели для анализа изображений. Выберите vision-совместимого провайдера.`);
  }
  const effectivePrimaryModel = primaryModel || options.model;
  try {
    return await invoke(primary, { ...options, apiKey: options.apiKey, model: effectivePrimaryModel });
  } catch (primaryError) {
    const primaryHttpError = getLLMHttpError(primaryError);
    const geminiQuotaExhausted = primaryId === 'gemini'
      && primaryHttpError?.status === 403
      && /quota[_\s-]?exceeded|resource_exhausted|daily quota/i.test(primaryHttpError.responseBody);
    if (!primaryHttpError || (!([429, 402].includes(primaryHttpError.status)) && !geminiQuotaExhausted)) {
      if (primaryHttpError) {
        throw new Error(mapLLMProviderError({
          providerId: primaryId,
          status: primaryHttpError.status,
          responseBody: primaryHttpError.responseBody,
          model: effectivePrimaryModel,
        }));
      }
      throw primaryError;
    }

    const keys = apiKeys || getAllKeys();
    const failures = [mapLLMProviderError({
      providerId: primaryId,
      status: primaryHttpError.status,
      responseBody: primaryHttpError.responseBody,
      model: effectivePrimaryModel,
    })];

    console.warn(`[llm:${primaryId}] HTTP ${primaryHttpError.status}; пытаюсь переключиться на следующий free-провайдер`);
    for (const fallbackId of FREE_FALLBACK_CHAIN) {
      if (fallbackId === primaryId) continue;
      const fallbackProvider = getLLMProvider(fallbackId);
      const apiKey = providerKey(keys, fallbackId);
      if (!fallbackProvider || !apiKey) continue;
      const fallbackModel = task === 'vision'
        ? getDefaultLLMVisionModel(fallbackProvider)
        : fallbackProvider.defaultModel;
      if (!fallbackModel) {
        failures.push(`${fallbackProvider.name} — нет модели с поддержкой image input`);
        continue;
      }

      try {
        const result = await invoke(fallbackProvider, {
          ...options,
          apiKey,
          model: fallbackModel,
          baseUrl: undefined,
          accountId: fallbackProvider.requiresAccountId ? options.accountId : undefined,
        });
        console.info(`[llm:${primaryId}] fallback успешно выполнен через ${fallbackId}`);
        return result;
      } catch (fallbackError) {
        const httpError = getLLMHttpError(fallbackError);
        failures.push(httpError
          ? mapLLMProviderError({
            providerId: fallbackId,
            status: httpError.status,
            responseBody: httpError.responseBody,
            model: fallbackModel,
          })
          : `${fallbackProvider.name} — ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      }
    }

    throw new Error([
      failures[0],
      'Автоматический fallback не помог:',
      ...failures.slice(1).map(message => `• ${message}`),
      failures.length === 1 ? '• Нет других free-провайдеров с сохранёнными ключами.' : '',
    ].filter(Boolean).join('\n'));
  }
}
