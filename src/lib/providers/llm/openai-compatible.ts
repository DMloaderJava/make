import { providerFetch } from '../http';
import { LLMProvider, LLMOptions, Message, ResponseFormatSchema } from './types';

/**
 * Провайдеры, у которых нет json_schema, но есть json_object.
 * OpenRouter, NVIDIA NIM, Groq и Mistral поддерживают json_schema.
 */
const JSON_OBJECT_ONLY_PROVIDERS = new Set(['custom', 'cloudflare', 'novita', 'siliconflow', 'zhipu', 'moonshot', 'huggingface']);

export type ResponseFormatMode = 'schema' | 'object' | 'none';

/** Собирает response_format для OpenAI-совместимого тела запроса. */
export function buildResponseFormat(
  providerId: string,
  responseFormat?: ResponseFormatSchema,
  mode: ResponseFormatMode = 'schema'
): Record<string, unknown> | undefined {
  if (!responseFormat || mode === 'none') return undefined;

  if (mode === 'object' || JSON_OBJECT_ONLY_PROVIDERS.has(providerId)) {
    return { type: 'json_object' };
  }

  return {
    type: 'json_schema',
    json_schema: {
      name: responseFormat.name || 'response',
      schema: responseFormat.schema,
      strict: responseFormat.strict ?? false,
    },
  };
}

/**
 * Провайдер мог не переварить json_schema, хотя формально она «OpenAI-совместима»:
 * тогда 400 прилетает именно на response_format. Запоминаем рабочий режим,
 * чтобы не платить тремя запросами за каждый вызов, и деградируем мягко.
 *
 * Ключ — «провайдер|модель»: у одного и того же провайдера gpt-4o понимает
 * json_schema, а меньшая модель может нет. Кэш на провайдера целиком приводил бы
 * к тому, что вторая модель всегда платит за лишние попытки.
 */
const responseFormatModes = new Map<string, { mode: ResponseFormatMode; expiresAt: number }>();

/** Схема-режим перепроверяем раз в 10 минут: провайдер мог починить json_schema. */
const RESPONSE_FORMAT_TTL_MS = 10 * 60 * 1000;
/** Потолок кэша: длинная сессия в Electron не должна расти бесконечно. */
const RESPONSE_FORMAT_MAX_ENTRIES = 200;

function getCachedMode(key: string): ResponseFormatMode | undefined {
  const entry = responseFormatModes.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    responseFormatModes.delete(key);
    return undefined;
  }
  // Перекладываем запись в конец: вытесняется самый давно использованный
  // (FIFO по вставке выбивал бы как раз активные пары «провайдер|модель»).
  responseFormatModes.delete(key);
  responseFormatModes.set(key, entry);
  return entry.mode;
}

function setCachedMode(key: string, mode: ResponseFormatMode): void {
  responseFormatModes.delete(key); // пере-вставка = свежая позиция в LRU
  // Полноценный schema — не деградация: держим долго и не перепроверяем.
  const ttl = mode === 'schema' ? 24 * 60 * 60 * 1000 : RESPONSE_FORMAT_TTL_MS;
  if (responseFormatModes.size >= RESPONSE_FORMAT_MAX_ENTRIES && !responseFormatModes.has(key)) {
    const oldest = responseFormatModes.keys().next();
    if (!oldest.done) responseFormatModes.delete(oldest.value);
  }
  responseFormatModes.set(key, { mode, expiresAt: Date.now() + ttl });
}

function looksLikeFormatRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = body.toLowerCase();
  return text.includes('response_format') || text.includes('json_schema') || text.includes('response format');
}

/**
 * POST на /chat/completions с деградацией response_format:
 * json_schema → json_object → без него. Ошибки не по формату пробрасываются как есть.
 */
async function postChatCompletion(params: {
  configId: string;
  name: string;
  url: string;
  apiKey: string;
  body: Record<string, unknown>;
  responseFormat?: ResponseFormatSchema;
  label?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<Response> {
  const { configId, name, url, apiKey, body, responseFormat, label = '', signal, deadlineMs } = params;
  const model = typeof body.model === 'string' ? body.model : '';
  const cacheKey = `${configId}|${model}`;

  const known = getCachedMode(cacheKey);
  const candidates: ResponseFormatMode[] = known
    ? known === 'none' ? ['none'] : [known, 'none']
    : ['schema', 'object', 'none'];

  let lastError = '';
  let lastStatus = 0;

  for (const mode of candidates) {
    const responseFormatBody = buildResponseFormat(configId, responseFormat, mode);
    // throwOnHttpError: false — деградация response_format анализирует 400/422
    // по телу. Ретраи транспорта сюда не мешают: 400/422 не входят в список
    // повторяемых статусов, поэтому число запросов не растёт.
    const response = await providerFetch(configId, url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        ...(responseFormatBody ? { response_format: responseFormatBody } : {}),
      }),
    }, {
      label: `${name}${label}`,
      retries: 1,
      timeoutMs: 25_000,
      deadlineMs,
      signal,
      throwOnHttpError: false,
    });

    if (response.ok) {
      setCachedMode(cacheKey, responseFormatBody ? mode : 'none');
      return response;
    }

    const errText = await response.text();
    lastError = errText;
    lastStatus = response.status;

    if (!looksLikeFormatRejection(response.status, errText) || mode === 'none') {
      throw new Error(`${name}${label} error: ${response.status} — ${errText.slice(0, 500)}`);
    }

    // NB: каждый повтор — это повторная отправка промпта (для vision — с картинками),
    // поэтому рабочий режим запоминается, и следующий вызов идёт сразу в него.
    // Но деградация ('object'/'none') кэшируется с TTL: иначе разовый сбой
    // провайдера навсегда лишал бы нас строгой схемы до перезагрузки вкладки.
    console.warn(
      `[llm:${cacheKey}] response_format=${mode} отклонён (${response.status}) — пробую ${mode === 'schema' ? 'json_object' : 'без response_format'}`
    );
  }

  throw new Error(`${name}${label} error: ${lastStatus} — ${lastError.slice(0, 500)}`);
}

/**
 * Сколько клиент ждёт легаси-прокси /api/llm. Сервер отвечает за 50 с, поэтому
 * 55 с — это «сервер точно не ответит», а не конкурирующий таймаут.
 */
const CLIENT_PROXY_TIMEOUT_MS = 55_000;

/**
 * Один клиентский путь через /api/llm для chat и vision. Раньше эти два блока
 * были копиями друг друга (и разошлись бы при следующей правке).
 *
 * Формат ошибки сохранён: `"<Name>[ vision] proxy error: <status> — <body>"` —
 * его разбирает getLLMHttpError, чтобы роутер LLM переключился на резервного
 * провайдера при 429/402.
 */
async function callLLMProxy(params: {
  providerId: string;
  name: string;
  label: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<string> {
  const { providerId, name, label, payload, signal } = params;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_PROXY_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch('/api/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId, ...payload }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error(`${name}${label} proxy error: 499 — запрос отменён`);
    if (controller.signal.aborted) {
      throw new Error(`${name}${label} proxy error: 504 — прокси не ответил за ${CLIENT_PROXY_TIMEOUT_MS / 1000} с`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${name}${label} proxy error: ${res.status} — ${err.slice(0, 500)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.content || '';
}

export function createOpenAICompatibleProvider(config: {
  id: string;
  name: string;
  description: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  freeTier: boolean;
  vision: boolean;
  visionModels?: string[];
  freeTierNote?: string;
  trialOnly?: boolean;
  limitsUrl?: string;
  rateLimits?: { rpm?: number; rpd?: number };
  apiKeyPrefix?: string;
  requiresAccountId?: boolean;
}): LLMProvider {
  const resolveBaseUrl = (options: LLMOptions): string => {
    let baseUrl = options.baseUrl || config.baseUrl;
    if (!config.requiresAccountId) return baseUrl;

    const accountId = options.accountId?.trim();
    if (!accountId) {
      throw new Error('Cloudflare error: 400 — Укажите Account ID в настройках провайдера.');
    }
    baseUrl = baseUrl.replace('{account_id}', encodeURIComponent(accountId));
    if (baseUrl.includes('{account_id}')) {
      throw new Error('Cloudflare error: 400 — Не удалось подставить Account ID в endpoint.');
    }
    return baseUrl;
  };

  const isLocalHost = (url: string) => {
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0' || u.hostname === '::1';
    } catch {
      return url.includes('localhost') || url.includes('127.0.0.1');
    }
  };

  const shouldProxy = (baseUrl: string) => {
    // Custom provider (Ollama, LM Studio) usually runs on localhost without CORS headers
    // Force through /api/llm Node.js proxy which ignores CORS
    return config.id === 'custom' || isLocalHost(baseUrl);
  };

  return {
    id: config.id,
    name: config.name,
    description: config.description,
    baseUrl: config.baseUrl,
    models: config.models,
    defaultModel: config.defaultModel,
    freeTier: config.freeTier,
    freeTierNote: config.freeTierNote,
    trialOnly: config.trialOnly,
    limitsUrl: config.limitsUrl,
    rateLimits: config.rateLimits,
    apiKeyPrefix: config.apiKeyPrefix,
    requiresAccountId: config.requiresAccountId,
    supportsVision: config.vision,
    visionModels: config.visionModels,
    async chat(messages: Message[], options: LLMOptions): Promise<string> {
      const baseUrl = resolveBaseUrl(options);
      const model = options.model || config.defaultModel;
      
      // Convert messages to OpenAI format
      const openAIMessages = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      // For custom/localhost, use server proxy to avoid CORS
      if (typeof window !== 'undefined' && shouldProxy(baseUrl)) {
        return callLLMProxy({
          providerId: config.id,
          name: config.name,
          label: '',
          signal: options.signal,
          payload: {
            messages: openAIMessages,
            apiKey: options.apiKey,
            model,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            baseUrl: options.baseUrl || config.baseUrl,
            accountId: options.accountId,
          },
        });
      }

      const response = await postChatCompletion({
        configId: config.id,
        name: config.name,
        url: `${baseUrl}/chat/completions`,
        apiKey: options.apiKey,
        body: {
          model,
          messages: openAIMessages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 4000,
        },
        responseFormat: options.responseFormat,
        signal: options.signal,
        deadlineMs: options.deadlineMs,
      });

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    },

    async vision(imageBase64: string, prompt: string, options: LLMOptions): Promise<string> {
      const baseUrl = resolveBaseUrl(options);
      const model = options.model || config.defaultModel;

      // Ensure base64 has data URL prefix
      let imageUrl = imageBase64;
      if (!imageBase64.startsWith('data:')) {
        imageUrl = `data:image/jpeg;base64,${imageBase64}`;
      }

      const messages = [
        {
          role: 'system' as const,
          content: prompt
        },
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'Проанализируй это изображение и верни JSON по схеме.' },
            { type: 'image_url' as const, image_url: { url: imageUrl } }
          ]
        }
      ];

      if (typeof window !== 'undefined' && shouldProxy(baseUrl)) {
        return callLLMProxy({
          providerId: config.id,
          name: config.name,
          label: ' vision',
          signal: options.signal,
          payload: {
            messages,
            apiKey: options.apiKey,
            model,
            temperature: 0.2,
            maxTokens: options.maxTokens,
            baseUrl: options.baseUrl || config.baseUrl,
            accountId: options.accountId,
          },
        });
      }

      const response = await postChatCompletion({
        configId: config.id,
        name: config.name,
        url: `${baseUrl}/chat/completions`,
        apiKey: options.apiKey,
        body: {
          model,
          messages,
          temperature: 0.2,
          max_tokens: options.maxTokens ?? 4000,
        },
        responseFormat: options.responseFormat,
        label: ' vision',
        signal: options.signal,
        deadlineMs: options.deadlineMs,
      });

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    }
  };
}
