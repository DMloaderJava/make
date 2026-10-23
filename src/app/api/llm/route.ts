import { NextRequest, NextResponse } from 'next/server';
import { mapLLMProviderError } from '@/lib/providers/llm/router';
import {
  getRegistryEntry,
  isGeminiApi,
  isProxyUnsupported,
  resolveLLMProxyUrl,
} from '@/lib/providers/registry';

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
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

const GEMINI_DEFAULT_MODEL = 'gemini-3-flash-preview';

function geminiBaseUrl(): string {
  return getRegistryEntry('llm', 'gemini')?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { providerId, messages, apiKey, model, temperature, maxTokens, baseUrl, accountId } = body;

    if (!providerId || !apiKey) {
      return NextResponse.json({ error: 'Missing providerId or apiKey' }, { status: 400 });
    }
    const entry = getRegistryEntry('llm', providerId);
    if (!entry) {
      return NextResponse.json({ error: `Unknown LLM provider ${providerId}` }, { status: 400 });
    }
    if (entry.requiresAccountId && !String(accountId || '').trim()) {
      return NextResponse.json({
        error: mapLLMProviderError({ providerId, status: 400, responseBody: 'missing account_id' }),
      }, { status: 400 });
    }
    if (isProxyUnsupported(providerId)) {
      return NextResponse.json({ error: 'Anthropic API is not OpenAI-compatible (uses /v1/messages, different format). Use direct browser call via LLM provider catalog, not proxy.' }, { status: 501 });
    }

    console.warn(`[LEGACY] /api/llm proxy called for ${providerId}. Consider using direct browser requests for CORS-friendly providers.`);

    if (isGeminiApi(providerId)) {
      const modelName = model || entry.defaultModel || GEMINI_DEFAULT_MODEL;
      const systemInstruction = messages.find((m: any) => m.role === 'system')?.content || '';
      const contents = messages.filter((m: any) => m.role !== 'system').map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: typeof m.content === 'string'
          ? [{ text: m.content }]
          : m.content.map((c: any) => {
              if (c.type === 'text') return { text: c.text };
              if (c.type === 'image_url') {
                const url = c.image_url.url;
                const base64 = url.includes(',') ? url.split(',')[1] : url;
                const mime = url.match(/data:(.*);base64/)?.[1] || 'image/jpeg';
                return { inlineData: { data: base64, mimeType: mime } };
              }
              return { text: '' };
            })
      }));

      const res = await fetch(`${geminiBaseUrl()}/models/${encodeURIComponent(modelName)}:generateContent`, {
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
      });

      if (!res.ok) {
        const err = await res.text();
        return NextResponse.json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model: modelName }) }, { status: res.status });
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return NextResponse.json({ content: text, raw: data, _legacy: true, _note: 'This proxy is legacy. For CORS-friendly providers, requests should go directly from browser.' });
    }

    const target = resolveLLMProxyUrl(providerId, { baseUrl, accountId });
    if (!target) {
      return NextResponse.json({ error: 'Custom provider requires baseUrl' }, { status: 400 });
    }

    const res = await fetch(`${target}/chat/completions`, {
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
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: mapLLMProviderError({ providerId, status: res.status, responseBody: err, model }) }, { status: res.status });
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    return NextResponse.json({ content, raw: data, _legacy: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Internal error' }, { status: 500 });
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
