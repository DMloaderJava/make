import { NextRequest, NextResponse } from 'next/server';
import { mapLLMProviderError } from '@/lib/providers/llm/router';
import {
  getRegistryEntry,
  isGeminiApi,
  isProxyUnsupported,
  resolveLLMProxyUrl,
} from '@/lib/providers/registry';
import {
  assertProviderTarget,
  providerFailureCode,
  providerFailureStatus,
  providerFetch,
  ProviderHttpError,
} from '@/lib/providers/http';
import { LLMRequestSchema, parseJsonBody } from '@/lib/providers/schemas';

/**
 * LEGACY PROXY - kept for backward compatibility and for providers that block CORS
 *
 * In v1.1, LLM requests go DIRECTLY from browser for CORS-friendly providers:
 * - OpenRouter, NVIDIA NIM, Google AI, Groq, Mistral - all allow browser CORS
 * - Keys do NOT go through our server for those
 *
 * This /api/llm proxy is ONLY needed if:
 * - Provider blocks CORS (rare for LLM)
 * - User explicitly wants to proxy
 * - Old code still calls it
 *
 * URL и протокол берутся из единого реестра (`providers/registry.ts`):
 * локальная карта URL-ов дублировала его и уже расходилась с
 * каталогом (например, для провайдеров без UI-карточки).
 *
 * Запросы идут через `providerFetch`: таймаут, повторы на 429/5xx и общий
 * бюджет. Адрес пользовательского провайдера проверяется `assertProviderTarget`
 * — иначе сервер был бы открытым SSRF-прокси (в том числе в облачные метаданные).
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_DEFAULT_MODEL = 'gemini-3-flash-preview';

/** Бюджет меньше maxDuration: успеваем вернуть понятную 504, а не быть убитыми. */
const LLM_REQUEST_BUDGET_MS = 50_000;

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function geminiBaseUrl(): string {
  return getRegistryEntry('llm', 'gemini')?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
}

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req, LLMRequestSchema);
  if (!parsed.ok) {
    if (parsed.reason === 'invalid_json') {
      return json({ error: 'Тело запроса должно быть JSON-объектом.', code: 'invalid_json' }, 400);
    }
    const first = parsed.issues[0];
    return json(
      {
        error: first
          ? `Некорректный запрос: поле «${first.path}» — ${first.message}`
          : 'Некорректный запрос',
        code: 'invalid_request',
        issues: parsed.issues,
      },
      400
    );
  }

  const { providerId, messages, apiKey, model, temperature, maxTokens, baseUrl, accountId } = parsed.data;

  const entry = getRegistryEntry('llm', providerId);
  if (!entry) {
    return json({ error: `Unknown LLM provider ${providerId}`, code: 'unknown_provider' }, 400);
  }
  if (entry.requiresAccountId && !String(accountId || '').trim()) {
    return json({
      error: mapLLMProviderError({ providerId, status: 400, responseBody: 'missing account_id' }),
      code: 'missing_account_id',
    }, 400);
  }
  if (isProxyUnsupported(providerId)) {
    return json({
      error: 'Anthropic API is not OpenAI-compatible (uses /v1/messages, different format). Use direct browser call via LLM provider catalog, not proxy.',
      code: 'proxy_unsupported',
    }, 501);
  }

  console.warn(`[LEGACY] /api/llm proxy called for ${providerId}. Consider using direct browser requests for CORS-friendly providers.`);

  try {
    if (isGeminiApi(providerId)) {
      const modelName = model || entry.defaultModel || GEMINI_DEFAULT_MODEL;
      // Только строковый system-промпт: массив частей сюда не годится —
      // в Gemini он уехал бы как «[object Object]» в поле text.
      const systemContent = messages.find(m => m.role === 'system')?.content;
      const systemInstruction = typeof systemContent === 'string' ? systemContent : '';
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map(c => {
              if (c.type === 'text') return { text: c.text };
              if (c.type === 'image_url') {
                const url = c.image_url?.url || '';
                const base64 = url.includes(',') ? url.split(',')[1] : url;
                const mime = url.match(/data:(.*);base64/)?.[1] || 'image/jpeg';
                return { inlineData: { data: base64, mimeType: mime } };
              }
              return { text: '' };
            })
      }));

      const res = await providerFetch('gemini', `${geminiBaseUrl()}/models/${encodeURIComponent(modelName)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          contents,
          generationConfig: {
            temperature: temperature ?? 0.7,
            maxOutputTokens: maxTokens ?? 4000,
          }
        })
      }, {
        label: 'Gemini',
        retries: 1,
        timeoutMs: 25_000,
        deadlineMs: LLM_REQUEST_BUDGET_MS,
        signal: req.signal,
        throwOnHttpError: false,
      });

      if (!res.ok) {
        const err = await res.text();
        return json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model: modelName }) }, res.status);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return json({ content: text, raw: data, _legacy: true, _note: 'This proxy is legacy. For CORS-friendly providers, requests should go directly from browser.' }, 200);
    }

    const target = resolveLLMProxyUrl(providerId, { baseUrl, accountId });
    if (!target) {
      return json({ error: 'Custom provider requires baseUrl', code: 'missing_base_url' }, 400);
    }

    // Единственная точка, где в сеть уходит адрес, выбранный пользователем.
    const endpoint = `${target}/chat/completions`;
    assertProviderTarget(endpoint);

    const res = await providerFetch(providerId, endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(providerId === 'openrouter' ? {
          'HTTP-Referer': 'https://manga-voice.local',
          'X-Title': 'Manga Voice Studio'
        } : {})
      },
      body: JSON.stringify({
        model: model || entry.defaultModel,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens ?? 4000,
      })
    }, {
      label: entry.name,
      retries: 1,
      timeoutMs: 25_000,
      deadlineMs: LLM_REQUEST_BUDGET_MS,
      signal: req.signal,
      throwOnHttpError: false,
    });

    if (!res.ok) {
      const err = await res.text();
      return json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model }) }, res.status);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    return json({ content, raw: data, _legacy: true }, 200);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      // Таймаут/сеть/запрещённый адрес: статус по классу сбоя, текст — из транспорта.
      return json({ error: error.message, code: providerFailureCode(error) }, providerFailureStatus(error));
    }
    return json({ error: error instanceof Error ? error.message : 'Internal error', code: 'internal_error' }, 500);
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'LLM proxy ready (LEGACY)',
    note: 'In v1.1, direct browser requests are preferred for CORS-friendly providers. This proxy is kept for backward compat and CORS-blocked providers.',
    directProviders: ['openrouter', 'nvidia-nim', 'gemini', 'groq', 'mistral'],
    proxyRequired: ['elevenlabs (TTS)']
  });
}
