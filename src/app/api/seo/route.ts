import { NextRequest, NextResponse } from 'next/server';
import { mapLLMProviderError } from '@/lib/providers/llm/router';
import { getLLMProvider } from '@/lib/providers/llm/catalog';
import {
  getRegistryEntry,
  isGeminiApi,
  isProxyUnsupported,
  resolveLLMProxyUrl,
} from '@/lib/providers/registry';

export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_DEFAULT_MODEL = 'gemini-3-flash-preview';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sceneDescription, characters, duration, providerId, apiKey, model, baseUrl, accountId } = body;

    if (!sceneDescription || !apiKey || !providerId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    // SEO-генерация работает только через каталог LLM (там есть реализации и
    // дефолтные модели). Реестр используется для URL/протокола, чтобы карта
    // провайдеров больше не дублировалась в этом файле.
    if (!getLLMProvider(providerId)) {
      return NextResponse.json({ error: `Unknown LLM provider ${providerId}` }, { status: 400 });
    }
    const entry = getRegistryEntry('llm', providerId);
    if (!entry) {
      return NextResponse.json({ error: `Unknown LLM provider ${providerId}` }, { status: 400 });
    }

    const { SEO_SYSTEM_PROMPT, SEO_USER_PROMPT } = await import('@/lib/prompts/seo-prompt');

    if (entry.requiresAccountId && !String(accountId || '').trim()) {
      return NextResponse.json({ error: mapLLMProviderError({ providerId, status: 400, responseBody: 'missing account_id' }) }, { status: 400 });
    }
    if (isProxyUnsupported(providerId)) {
      return NextResponse.json({ error: 'Anthropic API is not OpenAI-compatible (uses /v1/messages). Use direct browser call for SEO generation.' }, { status: 501 });
    }

    let content: string;

    if (isGeminiApi(providerId)) {
      const modelName = model || entry.defaultModel || GEMINI_DEFAULT_MODEL;
      const res = await fetch(`${entry.baseUrl}/models/${encodeURIComponent(modelName)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SEO_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: SEO_USER_PROMPT(sceneDescription, characters || [], duration || 180) }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 4000 }
        })
      });
      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model: modelName }) }, { status: res.status });
      }
      const data = await res.json();
      content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const target = resolveLLMProxyUrl(providerId, { baseUrl, accountId });
      if (!target) {
        return NextResponse.json({ error: 'Custom provider requires baseUrl' }, { status: 400 });
      }

      const res = await fetch(`${target}/chat/completions`, {
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
            { role: 'user', content: SEO_USER_PROMPT(sceneDescription, characters || [], duration || 180) }
          ],
          temperature: 0.7,
          max_tokens: 4000
        })
      });

      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model }) }, { status: res.status });
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
          return NextResponse.json({ error: 'LLM returned invalid JSON', raw: content }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: 'No JSON found in LLM response', raw: content }, { status: 500 });
      }
    }

    return NextResponse.json({ seo: seoPackage, raw: content });

  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ status: 'SEO API ready' });
}
