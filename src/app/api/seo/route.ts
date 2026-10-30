import { NextRequest, NextResponse } from 'next/server';
import { mapLLMProviderError } from '@/lib/providers/llm/router';
import { getLLMProvider } from '@/lib/providers/llm/catalog';
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
import { parseJsonBody, SEORequestSchema } from '@/lib/providers/schemas';

/**
 * SEO-пакет для обложки/описания: тот же LLM-провайдер, что и в /api/llm, но со
 * своим промптом. Запрос идёт через общий транспорт (таймаут, повторы, бюджет),
 * а пользовательский baseUrl проверяется `assertProviderTarget` — маршрут был
 * вторым (после /api/llm) открытым SSRF-прокси с той же дырой.
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_DEFAULT_MODEL = 'gemini-3-flash-preview';
const SEO_REQUEST_BUDGET_MS = 50_000;

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: NextRequest) {
  const parsed = await parseJsonBody(req, SEORequestSchema);
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

  const { sceneDescription, characters, duration, providerId, apiKey, model, baseUrl, accountId } = parsed.data;

  // SEO-генерация работает только через каталог LLM (там есть реализации и
  // дефолтные модели). Реестр используется для URL/протокола, чтобы карта
  // провайдеров больше не дублировалась в этом файле.
  if (!getLLMProvider(providerId)) {
    return json({ error: `Unknown LLM provider ${providerId}`, code: 'unknown_provider' }, 400);
  }
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
      error: 'Anthropic API is not OpenAI-compatible (uses /v1/messages). Use direct browser call for SEO generation.',
      code: 'proxy_unsupported',
    }, 501);
  }

  const { SEO_SYSTEM_PROMPT, SEO_USER_PROMPT } = await import('@/lib/prompts/seo-prompt');
  const userPrompt = SEO_USER_PROMPT(sceneDescription, characters || [], duration || 180);

  try {
    let content: string;

    if (isGeminiApi(providerId)) {
      const modelName = model || entry.defaultModel || GEMINI_DEFAULT_MODEL;
      const res = await providerFetch('gemini', `${entry.baseUrl}/models/${encodeURIComponent(modelName)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SEO_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
        })
      }, {
        label: 'Gemini',
        retries: 1,
        timeoutMs: 25_000,
        deadlineMs: SEO_REQUEST_BUDGET_MS,
        signal: req.signal,
        throwOnHttpError: false,
      });
      if (!res.ok) {
        const err = await res.text();
        return json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model: modelName }) }, res.status);
      }
      const data = await res.json();
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const target = resolveLLMProxyUrl(providerId, { baseUrl, accountId });
      if (!target) {
        return json({ error: 'Custom provider requires baseUrl', code: 'missing_base_url' }, 400);
      }
      const endpoint = `${target}/chat/completions`;
      assertProviderTarget(endpoint);

      const res = await providerFetch(providerId, endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(providerId === 'openrouter' ? { 'HTTP-Referer': 'https://manga-voice.local', 'X-Title': 'Manga Voice Studio' } : {})
        },
        body: JSON.stringify({
          model: model || entry.defaultModel,
          messages: [
            { role: 'system', content: SEO_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 4000
        })
      }, {
        label: entry.name,
        retries: 1,
        timeoutMs: 25_000,
        deadlineMs: SEO_REQUEST_BUDGET_MS,
        signal: req.signal,
        throwOnHttpError: false,
      });

      if (!res.ok) {
        const err = await res.text();
        return json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model }) }, res.status);
      }

      const data = await res.json();
      content = data.choices?.[0]?.message?.content || '';
    }

    // Try to parse JSON
    let seoPackage;
    try {
      seoPackage = JSON.parse(content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          seoPackage = JSON.parse(match[0]);
        } catch {
          return json({ error: 'LLM returned invalid JSON', raw: content }, 500);
        }
      } else {
        return json({ error: 'No JSON found in LLM response', raw: content }, 500);
      }
    }

    return json({ seo: seoPackage, raw: content }, 200);
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      return json({ error: error.message, code: providerFailureCode(error) }, providerFailureStatus(error));
    }
    return json({ error: error instanceof Error ? error.message : 'Internal error', code: 'internal_error' }, 500);
  }
}

export async function GET() {
  return NextResponse.json({ status: 'SEO API ready' });
}
