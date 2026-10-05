import { TTSProvider, TTSOptions, Voice } from './types';
import { base64ToArrayBuffer } from '@/lib/utils';
import { pcmToWav } from './wav';

export const GEMINI_TTS_SUPPORTED_MODELS = [
  'gemini-3.8-flash-tts',
  'gemini-3.8-flash-lite-tts',
  'gemini-3.1-flash-tts-preview',
];

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_TTS_PROMPT = 'Generate speech audio only. Read the transcript below aloud exactly as written.\n\nTRANSCRIPT:\n';
const GEMINI_RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const GEMINI_ATTEMPTS_PER_MODEL = 2;

interface GeminiModelInfo {
  name?: string;
  supportedGenerationMethods?: string[];
}

function normalizeGeminiModelName(name: string): string {
  return name.replace(/^models\//, '');
}

/** Проверяет, какие модели синтеза речи видны ключу Gemini. */
export async function fetchAvailableGeminiModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return [...GEMINI_TTS_SUPPORTED_MODELS];

  const response = await fetch(`${GEMINI_API_BASE}/models`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok) {
    const details = await response.text().catch(() => response.statusText);
    throw new Error(`Gemini models error: ${response.status} — ${details.slice(0, 400)}`);
  }

  const data = await response.json() as { models?: GeminiModelInfo[] };
  const availableTTSModels = (data.models || [])
    .filter(model => {
      const modelName = model.name || '';
      const supportsGenerateContent = !model.supportedGenerationMethods || model.supportedGenerationMethods.includes('generateContent');
      return supportsGenerateContent && /tts/i.test(modelName);
    })
    .map(model => normalizeGeminiModelName(model.name || ''))
    .filter(Boolean);

  // Keep the catalog's recommended order, then append any future TTS models
  // returned by Google so users can try them without waiting for an app update.
  const available = new Set(availableTTSModels);
  return [
    ...GEMINI_TTS_SUPPORTED_MODELS.filter(model => available.has(model)),
    ...availableTTSModels.filter(model => !GEMINI_TTS_SUPPORTED_MODELS.includes(model)),
  ];
}

function buildGeminiRequestText(text: string): string {
  return `${GEMINI_TTS_PROMPT}${text}`;
}

/**
 * Gemini TTS returns raw PCM s16le, 24 kHz, mono. Wrap it in WAV for browser
 * playback/export. A missing model falls through the supported catalog; transient
 * 5xx or text-only responses are retried once before trying the next model.
 */
export async function generateGeminiTTS(text: string, options: TTSOptions): Promise<ArrayBuffer> {
  const requestedModel = options.model || GEMINI_TTS_SUPPORTED_MODELS[0];
  const models = [requestedModel, ...GEMINI_TTS_SUPPORTED_MODELS.filter(model => model !== requestedModel)];
  let lastError: Error | null = null;

  for (const model of models) {
    for (let attempt = 0; attempt < GEMINI_ATTEMPTS_PER_MODEL; attempt++) {
      let response: Response;
      try {
        response = await fetch(
          `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': options.apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: buildGeminiRequestText(text) }] }],
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: options.voice || 'Puck' },
                  },
                },
              },
            }),
          }
        );
      } catch (error) {
        lastError = new Error(`Gemini TTS network error: ${error instanceof Error ? error.message : String(error)}`);
        if (attempt + 1 < GEMINI_ATTEMPTS_PER_MODEL) continue;
        break;
      }

      if (response.status === 404) {
        const details = await response.text().catch(() => response.statusText);
        lastError = new Error(`Gemini TTS error: 404 — ${details}`);
        break;
      }

      if (!response.ok) {
        const details = await response.text().catch(() => response.statusText);
        lastError = new Error(`Gemini TTS error: ${response.status} — ${details}`);
        if (GEMINI_RETRYABLE_STATUSES.has(response.status) && attempt + 1 < GEMINI_ATTEMPTS_PER_MODEL) {
          continue;
        }
        if (!GEMINI_RETRYABLE_STATUSES.has(response.status)) throw lastError;
        break;
      }

      const data = await response.json() as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> };
        }>;
      };
      const parts = data.candidates?.[0]?.content?.parts || [];
      const base64Audio = parts.find(part => part.inlineData?.data)?.inlineData?.data;
      if (base64Audio) {
        return pcmToWav(base64ToArrayBuffer(base64Audio), {
          sampleRate: 24000,
          channels: 1,
          bitsPerSample: 16,
        });
      }

      const textResponse = parts.map(part => part.text).filter(Boolean).join(' ');
      lastError = new Error(`Gemini TTS error: 422 — ${JSON.stringify({
        error: 'No audio data from Gemini',
        text: textResponse || undefined,
        model,
      })}`);
      if (attempt + 1 < GEMINI_ATTEMPTS_PER_MODEL) continue;
      break;
    }
  }

  throw lastError || new Error('Gemini TTS: no supported model returned audio');
}

export const geminiTTS: TTSProvider = {
  id: 'gemini',
  name: 'Google Gemini TTS',
  description: '200+ голосов, отличный русский, free quota',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  defaultModel: GEMINI_TTS_SUPPORTED_MODELS[0],
  supportedModels: GEMINI_TTS_SUPPORTED_MODELS,
  // У Gemini TTS нет параметра темпа: скорость задаётся только стилевой
  // подсказкой в тексте, поэтому speed не передаём и честно помечаем это в UI.
  supportsSpeed: false,
  baseUrl: GEMINI_API_BASE,

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    return generateGeminiTTS(text, options);
  },

  async getModels(apiKey: string): Promise<string[]> {
    return fetchAvailableGeminiModels(apiKey);
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'Puck', name: 'Puck (муж, энергичный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Charon', name: 'Charon (муж, глубокий)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Kore', name: 'Kore (жен, мягкий)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Fenrir', name: 'Fenrir (муж, мощный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Aoede', name: 'Aoede (жен, лиричный)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Leda', name: 'Leda (жен, юный)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Orus', name: 'Orus (муж, спокойный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Zephyr', name: 'Zephyr (жен, воздушный)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Achernar', name: 'Achernar (жен, теплый)', language: 'ru', gender: 'female', provider: 'gemini' },
      { id: 'Algenib', name: 'Algenib (муж, гравий)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Schedar', name: 'Schedar (муж, ровный)', language: 'ru', gender: 'male', provider: 'gemini' },
      { id: 'Gacrux', name: 'Gacrux (жен, зрелый)', language: 'ru', gender: 'female', provider: 'gemini' },
    ];
  },
};
