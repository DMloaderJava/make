import { NextRequest, NextResponse } from 'next/server';
import { mapLLMProviderError } from '@/lib/providers/llm/router';
import { getLLMProvider } from '@/lib/providers/llm/catalog';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sceneDescription, characters, duration, providerId, apiKey, model, baseUrl, accountId } = body;

    if (!sceneDescription || !apiKey || !providerId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }
    if (!getLLMProvider(providerId)) {
      return NextResponse.json({ error: `Unknown LLM provider ${providerId}` }, { status: 400 });
    }

    const { SEO_SYSTEM_PROMPT, SEO_USER_PROMPT } = await import('@/lib/prompts/seo-prompt');

    const messages = [
      { role: 'system', content: SEO_SYSTEM_PROMPT },
      { role: 'user', content: SEO_USER_PROMPT(sceneDescription, characters || [], duration || 180) }
    ];

    if (providerId === 'custom' && !baseUrl) {
      return NextResponse.json({ error: 'Custom provider requires baseUrl' }, { status: 400 });
    }
    if (providerId === 'cloudflare' && !String(accountId || '').trim()) {
      return NextResponse.json({ error: mapLLMProviderError({ providerId, status: 400, responseBody: 'missing account_id' }) }, { status: 400 });
    }
    if (providerId === 'anthropic') {
      return NextResponse.json({ error: 'Anthropic API is not OpenAI-compatible (uses /v1/messages). Use direct browser call for SEO generation.' }, { status: 501 });
    }

    // Proxy to LLM - full map from /api/llm
    const providerConfigs: Record<string, string> = {
      'nvidia-nim': baseUrl || 'https://integrate.api.nvidia.com/v1',
      'openrouter': baseUrl || 'https://openrouter.ai/api/v1',
      'mistral': baseUrl || 'https://api.mistral.ai/v1',
      'groq': baseUrl || 'https://api.groq.com/openai/v1',
      'github-models': baseUrl || 'https://models.inference.ai.azure.com',
      'cerebras': baseUrl || 'https://api.cerebras.ai/v1',
      'sambanova': baseUrl || 'https://api.sambanova.ai/v1',
      'openai': baseUrl || 'https://api.openai.com/v1',
      'cloudflare': (baseUrl || 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1').replace('{account_id}', encodeURIComponent(String(accountId || ''))),
      'cohere': baseUrl || 'https://api.cohere.ai/compatibility/v1',
      'huggingface': baseUrl || 'https://router.huggingface.co/v1',
      'deepseek': baseUrl || 'https://api.deepseek.com/v1',
      'together': baseUrl || 'https://api.together.xyz/v1',
      'fireworks': baseUrl || 'https://api.fireworks.ai/inference/v1',
      'deepinfra': baseUrl || 'https://api.deepinfra.com/v1/openai',
      'novita': baseUrl || 'https://api.novita.ai/openai',
      'siliconflow': baseUrl || 'https://api.siliconflow.com/v1',
      'zhipu': baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
      'moonshot': baseUrl || 'https://api.moonshot.ai/v1',
      '01ai': baseUrl || 'https://api.01.ai/v1',
      'perplexity': baseUrl || 'https://api.perplexity.ai',
      'custom': baseUrl || '',
      'ai21': baseUrl || 'https://api.ai21.com/studio/v1',
      'gemini': 'google',
      'google-ai': 'google',
    };

    let content: string;

    if (providerId === 'gemini' || providerId === 'google-ai') {
      const modelName = model || 'gemini-3-flash-preview';
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
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
      const base = providerConfigs[providerId];
      if (!base) return NextResponse.json({ error: `Unknown provider ${providerId}` }, { status: 400 });
      if (!base && (providerId === 'custom' || providerId === 'cloudflare')) {
        return NextResponse.json({ error: `${providerId} requires baseUrl` }, { status: 400 });
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(providerId === 'openrouter' ? { 'HTTP-Referer': 'https://manga-voice.local', 'X-Title': 'Manga Voice Studio' } : {})
        },
        body: JSON.stringify({
          model,
          messages,
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
