import { LLMProvider, LLMOptions, Message, ResponseFormatSchema } from './types';

/**
 * Провайдеры, у которых нет json_schema, но есть json_object.
 * Остальные (OpenAI/OpenRouter/Groq/Together/Mistral/...) поддерживают json_schema.
 */
const JSON_OBJECT_ONLY_PROVIDERS = new Set(['custom', 'cloudflare', 'deepinfra', 'novita', 'siliconflow', 'zhipu', 'moonshot', '01ai', 'huggingface', 'cohere']);

/** Собирает response_format для OpenAI-совместимого тела запроса. */
export function buildResponseFormat(
  providerId: string,
  responseFormat?: ResponseFormatSchema
): Record<string, unknown> | undefined {
  if (!responseFormat) return undefined;

  if (JSON_OBJECT_ONLY_PROVIDERS.has(providerId)) {
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

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: openAIMessages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 4000,
          ...(buildResponseFormat(config.id, options.responseFormat)
            ? { response_format: buildResponseFormat(config.id, options.responseFormat) }
            : {}),
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`${config.name} error: ${response.status} — ${err.slice(0, 500)}`);
      }

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

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.2,
          max_tokens: options.maxTokens ?? 4000,
          ...(buildResponseFormat(config.id, options.responseFormat)
            ? { response_format: buildResponseFormat(config.id, options.responseFormat) }
            : {}),
        })
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`${config.name} vision error: ${response.status} — ${err.slice(0, 500)}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    }
  };
}
