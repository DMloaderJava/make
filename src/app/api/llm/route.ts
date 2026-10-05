import { NextRequest, NextResponse } from 'next/server';
import { mapLLMProviderError } from '@/lib/providers/llm/router';
import { getLLMProvider } from '@/lib/providers/llm/catalog';

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
 * For TTS, ElevenLabs DOES block CORS, so /api/tts is still needed
 * This route is marked legacy but kept functional
 */

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { providerId, messages, apiKey, model, temperature, maxTokens, baseUrl, accountId } = body;

    if (!providerId || !apiKey) {
      return NextResponse.json({ error: 'Missing providerId or apiKey' }, { status: 400 });
    }
    if (!getLLMProvider(providerId)) {
      return NextResponse.json({ error: `Unknown LLM provider ${providerId}` }, { status: 400 });
    }

    if (providerId === 'cloudflare' && !String(accountId || '').trim()) {
      return NextResponse.json({
        error: mapLLMProviderError({ providerId, status: 400, responseBody: 'missing account_id' }),
      }, { status: 400 });
    }

    if (providerId === 'anthropic') {
      return NextResponse.json({ error: 'Anthropic API is not OpenAI-compatible (uses /v1/messages, different format). Use direct browser call via LLM provider catalog, not proxy.' }, { status: 501 });
    }

    console.warn(`[LEGACY] /api/llm proxy called for ${providerId}. Consider using direct browser requests for CORS-friendly providers.`);

    const providerConfigs: Record<string, { url: string; isGoogle?: boolean }> = {
      'nvidia-nim': { url: baseUrl || 'https://integrate.api.nvidia.com/v1' },
      'openrouter': { url: baseUrl || 'https://openrouter.ai/api/v1' },
      'mistral': { url: baseUrl || 'https://api.mistral.ai/v1' },
      'groq': { url: baseUrl || 'https://api.groq.com/openai/v1' },
      'github-models': { url: baseUrl || 'https://models.inference.ai.azure.com' },
      'cerebras': { url: baseUrl || 'https://api.cerebras.ai/v1' },
      'sambanova': { url: baseUrl || 'https://api.sambanova.ai/v1' },
      'openai': { url: baseUrl || 'https://api.openai.com/v1' },
      'cloudflare': { url: (baseUrl || 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1').replace('{account_id}', encodeURIComponent(String(accountId || ''))) },
      'cohere': { url: baseUrl || 'https://api.cohere.ai/compatibility/v1' },
      'huggingface': { url: baseUrl || 'https://router.huggingface.co/v1' },
      'deepseek': { url: baseUrl || 'https://api.deepseek.com/v1' },
      'together': { url: baseUrl || 'https://api.together.xyz/v1' },
      'fireworks': { url: baseUrl || 'https://api.fireworks.ai/inference/v1' },
      'deepinfra': { url: baseUrl || 'https://api.deepinfra.com/v1/openai' },
      'novita': { url: baseUrl || 'https://api.novita.ai/openai' },
      'siliconflow': { url: baseUrl || 'https://api.siliconflow.com/v1' },
      'zhipu': { url: baseUrl || 'https://open.bigmodel.cn/api/paas/v4' },
      'moonshot': { url: baseUrl || 'https://api.moonshot.ai/v1' },
      '01ai': { url: baseUrl || 'https://api.01.ai/v1' },
      'perplexity': { url: baseUrl || 'https://api.perplexity.ai' },
      'custom': { url: baseUrl },
      'ai21': { url: baseUrl || 'https://api.ai21.com/studio/v1' },
      'gemini': { url: 'https://generativelanguage.googleapis.com/v1beta', isGoogle: true },
      'google-ai': { url: 'https://generativelanguage.googleapis.com/v1beta', isGoogle: true },
    };

    const config = providerConfigs[providerId];
    if (!config) {
      return NextResponse.json({ error: `Unknown provider ${providerId}` }, { status: 400 });
    }

    if (config.isGoogle) {
      const modelName = model || 'gemini-3-flash-preview';
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

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
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
    } else {
      if (!config.url) {
        return NextResponse.json({ error: 'Custom provider requires baseUrl' }, { status: 400 });
      }

      const res = await fetch(`${config.url}/chat/completions`, {
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
          model: model,
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
    }
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
