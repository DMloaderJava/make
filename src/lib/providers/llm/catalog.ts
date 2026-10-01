import { createOpenAICompatibleProvider } from './openai-compatible';
import { LLMProvider } from './types';
import { getProviderLink } from '../links';

function linkDesc(id: string, fallback: string) {
  const link = getProviderLink(id, 'llm');
  if (!link) return fallback;
  return `${link.limits} · ${link.freeTierDetail}`;
}

export const LLM_PROVIDERS: LLMProvider[] = [
  createOpenAICompatibleProvider({
    id: 'openrouter',
    name: 'OpenRouter',
    description: linkDesc('openrouter', '20 RPM / 50 RPD · 25+ free моделей'),
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'inclusionai/ling-3.0-flash-vl:free',
      'meta-llama/llama-4-maverick:free',
      'meta-llama/llama-4-scout:free',
      'google/gemini-2.0-flash-exp:free',
      'qwen/qwen2.5-vl-32b-instruct:free',
      'mistralai/mistral-small-3.1-24b-instruct:free',
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-haiku',
    ],
    defaultModel: 'inclusionai/ling-3.0-flash-vl:free',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    description: linkDesc('nvidia-nim', '40 RPM · 189+ моделей'),
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      'meta/llama-3.2-90b-vision-instruct',
      'meta/llama-3.2-11b-vision-instruct',
      'microsoft/phi-3-vision-128k-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'meta/llama-3.1-405b-instruct',
    ],
    defaultModel: 'meta/llama-3.2-90b-vision-instruct',
    freeTier: true,
    vision: true,
  }),
  {
    id: 'google-ai',
    name: 'Google AI Studio',
    description: linkDesc('google-ai', 'Gemini 2.5 Flash, 10 RPM / 250 RPD'),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
    ],
    defaultModel: 'gemini-2.5-flash',
    freeTier: true,
    supportsVision: true,
    async chat(messages, options) {
      const model = options.model || 'gemini-2.5-flash';
      const systemInstruction = messages.find(m => m.role === 'system')?.content as string || '';
      const contents = messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: typeof m.content === 'string' ? [{ text: m.content }] : (m.content as any[]).map((c: any) => {
          if (c.type === 'text') return { text: c.text };
          if (c.type === 'image_url') {
            const url = c.image_url!.url;
            const base64 = url.includes(',') ? url.split(',')[1] : url;
            const mime = url.match(/data:(.*);base64/)?.[1] || 'image/jpeg';
            return { inlineData: { data: base64, mimeType: mime } };
          }
          return { text: '' };
        })
      }));

      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${options.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction }] } : undefined,
          contents,
          generationConfig: {
            temperature: options.temperature ?? 0.7,
            maxOutputTokens: options.maxTokens ?? 4000,
          }
        })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Google AI error: ${res.status} — ${err.slice(0, 500)}`);
      }
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    },
    async vision(imageBase64: string, prompt: string, options: any) {
      const model = options.model || 'gemini-2.5-flash';
      let base64 = imageBase64;
      let mime = 'image/jpeg';
      if (imageBase64.startsWith('data:')) {
        const match = imageBase64.match(/data:(.*);base64,/);
        if (match) mime = match[1];
        base64 = imageBase64.split(',')[1];
      }
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${options.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{
            role: 'user',
            parts: [
              { text: 'Проанализируй изображение и верни JSON.' },
              { inlineData: { data: base64, mimeType: mime } }
            ]
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: options.maxTokens ?? 4000 }
        })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Google AI vision error: ${res.status} — ${err.slice(0,500)}`);
      }
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
  } as LLMProvider,
  createOpenAICompatibleProvider({
    id: 'groq',
    name: 'Groq',
    description: linkDesc('groq', 'Llama 4 Scout, очень быстрый'),
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['meta-llama/llama-4-scout-17b-16e-instruct', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'llama-3.2-90b-vision-preview', 'llama-3.2-11b-vision-preview'],
    defaultModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'mistral',
    name: 'Mistral AI',
    description: linkDesc('mistral', 'Pixtral Large, ~1B tokens/month'),
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['pixtral-large-latest', 'pixtral-12b-2409', 'mistral-large-latest', 'mistral-small-latest'],
    defaultModel: 'pixtral-large-latest',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'github-models',
    name: 'GitHub Models',
    description: linkDesc('github-models', '40+ моделей (GPT-5, Claude, DeepSeek)'),
    baseUrl: 'https://models.inference.ai.azure.com',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'claude-3.5-sonnet', 'DeepSeek-R1', 'Meta-Llama-3.1-405B-Instruct'],
    defaultModel: 'gpt-4o-mini',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'cerebras',
    name: 'Cerebras',
    description: linkDesc('cerebras', 'Ultra-fast, $5 credit'),
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b', 'llama-3.1-8b', 'llama3.1-70b'],
    defaultModel: 'llama-3.3-70b',
    freeTier: false,
    vision: false,
  }),
  createOpenAICompatibleProvider({
    id: 'sambanova',
    name: 'SambaNova',
    description: linkDesc('sambanova', '20 requests/day'),
    baseUrl: 'https://api.sambanova.ai/v1',
    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.2-90B-Vision-Instruct', 'Llama-4-Maverick-17B-128E-Instruct'],
    defaultModel: 'Meta-Llama-3.2-90B-Vision-Instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    description: linkDesc('cloudflare', '10k Neurons/day · Llama 3.2 11B Vision'),
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    models: ['@cf/meta/llama-3.2-11b-vision-instruct', '@cf/meta/llama-3.2-90b-vision-instruct', '@cf/meta/llama-3.1-8b-instruct', '@cf/mistral/mistral-7b-instruct-v0.1'],
    defaultModel: '@cf/meta/llama-3.2-11b-vision-instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'cohere',
    name: 'Cohere',
    description: linkDesc('cohere', '1000 req/month trial'),
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    models: ['command-a-03-2025', 'command-r-plus', 'command-r', 'command'],
    defaultModel: 'command-a-03-2025',
    freeTier: true,
    vision: false,
  }),
  createOpenAICompatibleProvider({
    id: 'huggingface',
    name: 'Hugging Face Inference',
    description: linkDesc('huggingface', '300 req/hour · 100k+ моделей'),
    baseUrl: 'https://api-inference.huggingface.co/v1',
    models: ['meta-llama/Llama-3.2-90B-Vision-Instruct', 'Qwen/Qwen2.5-VL-32B-Instruct', 'mistralai/Pixtral-12B-2409'],
    defaultModel: 'Qwen/Qwen2.5-VL-32B-Instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    description: linkDesc('deepseek', 'Free tier, очень дёшево'),
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3'],
    defaultModel: 'deepseek-chat',
    freeTier: true,
    vision: false,
  }),
  createOpenAICompatibleProvider({
    id: 'together',
    name: 'Together AI',
    description: linkDesc('together', '$5 credit · Qwen 2.5 VL vision'),
    baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-VL-72B-Instruct', 'meta-llama/Llama-Vision-Free'],
    defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'fireworks',
    name: 'Fireworks AI',
    description: linkDesc('fireworks', '$1 credit · Llama 3.2 Vision'),
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: ['accounts/fireworks/models/llama-v3p2-90b-vision-instruct', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    defaultModel: 'accounts/fireworks/models/llama-v3p2-90b-vision-instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'deepinfra',
    name: 'DeepInfra',
    description: linkDesc('deepinfra', '$1 credit · Llama 3.2 90B Vision'),
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    models: ['meta-llama/Llama-3.2-90B-Vision-Instruct', 'Qwen/Qwen2.5-VL-72B-Instruct', 'meta-llama/Llama-3.3-70B-Instruct'],
    defaultModel: 'meta-llama/Llama-3.2-90B-Vision-Instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'novita',
    name: 'Novita AI',
    description: linkDesc('novita', '$0.5 credit · Llama 3.2 Vision'),
    baseUrl: 'https://api.novita.ai/v3/openai',
    models: ['meta-llama/llama-3.2-90b-vision-instruct', 'qwen/qwen2.5-vl-72b-instruct', 'meta-llama/llama-3.3-70b-instruct'],
    defaultModel: 'meta-llama/llama-3.2-90b-vision-instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'siliconflow',
    name: 'SiliconFlow',
    description: linkDesc('siliconflow', 'Free tier щедрый · Qwen 2.5 VL'),
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-VL-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'Pro/Qwen/Qwen2.5-VL-7B-Instruct'],
    defaultModel: 'Qwen/Qwen2.5-VL-72B-Instruct',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'zhipu',
    name: 'Zhipu AI (Z.ai)',
    description: linkDesc('zhipu', 'GLM-4.6V-Flash, 1 concurrent'),
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4v-flash', 'glm-4v', 'glm-4-flash', 'glm-4-plus'],
    defaultModel: 'glm-4v-flash',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'moonshot',
    name: 'Moonshot AI',
    description: linkDesc('moonshot', 'Free tier · Kimi Vision'),
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-128k-vision-preview', 'moonshot-v1-8k', 'moonshot-v1-32k'],
    defaultModel: 'moonshot-v1-128k-vision-preview',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: '01ai',
    name: '01.AI',
    description: linkDesc('01ai', 'Free tier · Yi-Vision'),
    baseUrl: 'https://api.01.ai/v1',
    models: ['yi-vision', 'yi-large', 'yi-medium'],
    defaultModel: 'yi-vision',
    freeTier: true,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'perplexity',
    name: 'Perplexity',
    description: linkDesc('perplexity', '$5/mo Pro · Sonar для SEO'),
    baseUrl: 'https://api.perplexity.ai',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning'],
    defaultModel: 'sonar-pro',
    freeTier: true,
    vision: false,
  }),
  createOpenAICompatibleProvider({
    id: 'openai',
    name: 'OpenAI',
    description: linkDesc('openai', 'GPT-4o, o1, платно'),
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'],
    defaultModel: 'gpt-4o-mini',
    freeTier: false,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'anthropic',
    name: 'Anthropic',
    description: linkDesc('anthropic', 'Claude 3.5, платно'),
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-3-5-sonnet-20241022',
    freeTier: false,
    vision: true,
  }),
  createOpenAICompatibleProvider({
    id: 'custom',
    name: 'Custom OpenAI-compatible',
    description: linkDesc('custom', 'LM Studio, Ollama, vLLM'),
    baseUrl: '',
    models: ['custom-model'],
    defaultModel: 'custom-model',
    freeTier: true,
    vision: true,
  }),
];

export function getLLMProvider(id: string) {
  return LLM_PROVIDERS.find(p => p.id === id);
}
