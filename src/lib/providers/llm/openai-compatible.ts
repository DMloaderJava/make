import { LLMProvider, LLMOptions, Message, ResponseFormatSchema } from './types';

/**
 * Провайдеры, у которых нет json_schema, но есть json_object.
 * Остальные (OpenAI/OpenRouter/Groq/Together/Mistral/...) поддерживают json_schema.
 */
const JSON_OBJECT_ONLY_PROVIDERS = new Set(['custom', 'cloudflare', 'deepinfra', 'novita', 'siliconflow', 'zhipu', 'moonshot', '01ai', 'huggingface', 'cohere']);

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
const responseFormatModes = new Map<string, ResponseFormatMode>();

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
}): Promise<Response> {
  const { configId, name, url, apiKey, body, responseFormat, label = '' } = params;
  const model = typeof body.model === 'string' ? body.model : '';
  const cacheKey = `${configId}|${model}`;

  const known = responseFormatModes.get(cacheKey);
  const candidates: ResponseFormatMode[] = known
    ? known === 'none' ? ['none'] : [known, 'none']
    : ['schema', 'object', 'none'];

  let lastError = '';
  let lastStatus = 0;

  for (const mode of candidates) {
    const responseFormatBody = buildResponseFormat(configId, responseFormat, mode);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...body,
        ...(responseFormatBody ? { response_format: responseFormatBody } : {}),
      }),
    });

    if (response.ok) {
      responseFormatModes.set(cacheKey, responseFormatBody ? mode : 'none');
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
    console.warn(
      `[llm:${cacheKey}] response_format=${mode} отклонён (${response.status}) — пробую ${mode === 'schema' ? 'json_object' : 'без response_format'}`
    );
  }

  throw new Error(`${name}${label} error: ${lastStatus} — ${lastError.slice(0, 500)}`);
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
}): LLMProvider {
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
    supportsVision: config.vision,
    async chat(messages: Message[], options: LLMOptions): Promise<string> {
      const baseUrl = options.baseUrl || config.baseUrl;
      const model = options.model || config.defaultModel;
      
      // Convert messages to OpenAI format
      const openAIMessages = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      // For custom/localhost, use server proxy to avoid CORS
      if (typeof window !== 'undefined' && shouldProxy(baseUrl)) {
        const res = await fetch('/api/llm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: config.id,
            messages: openAIMessages,
            apiKey: options.apiKey,
            model,
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            baseUrl,
          })
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`${config.name} proxy error: ${res.status} — ${err.slice(0,500)}`);
        }
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.content || '';
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
      });

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    },

    async vision(imageBase64: string, prompt: string, options: LLMOptions): Promise<string> {
      const baseUrl = options.baseUrl || config.baseUrl;
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
        const res = await fetch('/api/llm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: config.id,
            messages,
            apiKey: options.apiKey,
            model,
            temperature: 0.2,
            maxTokens: options.maxTokens,
            baseUrl,
          })
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`${config.name} vision proxy error: ${res.status} — ${err.slice(0,500)}`);
        }
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.content || '';
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
      });

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    }
  };
}
