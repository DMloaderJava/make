import { TTSProvider, TTSOptions, Voice } from './types';

export const DEEPGRAM_FLUX_DEFAULT_MODEL = 'flux-hannah-en';
export const DEEPGRAM_AURA_DEFAULT_MODEL = 'aura-2-thalia-en';

/** Batch REST URLs: Flux is served on /v2/speak; Aura remains on /v1/speak. */
export function getDeepgramSpeakUrl(model: string): string {
  const isFlux = model.startsWith('flux-');
  const version = isFlux ? 'v2' : 'v1';
  const query = new URLSearchParams({ model });
  // Aura's v1 endpoint needs the output encoding explicitly. Flux batch REST
  // defaults to MP3; the v2 WebSocket is deliberately not used here.
  if (!isFlux) query.set('encoding', 'mp3');
  return `https://api.deepgram.com/${version}/speak?${query.toString()}`;
}

export async function generateDeepgramTTS(text: string, options: TTSOptions): Promise<ArrayBuffer> {
  const voice = options.voice?.trim();
  // Deepgram model IDs are also the voice IDs. Prefer the selected character
  // voice so an Aura voice continues to use /v1 even when the global model is Flux.
  const voiceIsDeepgramModel = Boolean(voice && /^(?:flux-|aura-2-)/.test(voice));
  const model = voiceIsDeepgramModel
    ? voice!
    : options.model || voice || DEEPGRAM_FLUX_DEFAULT_MODEL;

  const response = await fetch(getDeepgramSpeakUrl(model), {
    method: 'POST',
    headers: {
      'Authorization': `Token ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const details = await response.text();
    const error = new Error(`Deepgram error: ${response.status} — ${details.slice(0, 500)}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  return response.arrayBuffer();
}

const fluxVoices: Voice[] = [
  { id: 'flux-hannah-en', name: 'Flux · Hannah (жен, English)', language: 'en', gender: 'female', provider: 'deepgram' },
  { id: 'flux-alexis-en', name: 'Flux · Alexis (жен, English)', language: 'en', gender: 'female', provider: 'deepgram' },
  { id: 'flux-gemma-en', name: 'Flux · Gemma (жен, English)', language: 'en', gender: 'female', provider: 'deepgram' },
  { id: 'flux-kit-en', name: 'Flux · Kit (муж, English)', language: 'en', gender: 'male', provider: 'deepgram' },
  { id: 'flux-cliff-en', name: 'Flux · Cliff (муж, English)', language: 'en', gender: 'male', provider: 'deepgram' },
  { id: 'flux-colin-en', name: 'Flux · Colin (муж, English)', language: 'en', gender: 'male', provider: 'deepgram' },
];

const auraVoices: Voice[] = [
  { id: 'aura-2-thalia-en', name: 'Aura-2 · Thalia (жен, English)', language: 'en', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-arcas-en', name: 'Aura-2 · Arcas (муж, English)', language: 'en', gender: 'male', provider: 'deepgram' },
  { id: 'aura-2-celeste-es', name: 'Aura-2 · Celeste (жен, Spanish)', language: 'es', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-nestor-es', name: 'Aura-2 · Nestor (муж, Spanish)', language: 'es', gender: 'male', provider: 'deepgram' },
  { id: 'aura-2-viktoria-de', name: 'Aura-2 · Viktoria (жен, German)', language: 'de', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-julius-de', name: 'Aura-2 · Julius (муж, German)', language: 'de', gender: 'male', provider: 'deepgram' },
  { id: 'aura-2-agathe-fr', name: 'Aura-2 · Agathe (жен, French)', language: 'fr', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-hector-fr', name: 'Aura-2 · Hector (муж, French)', language: 'fr', gender: 'male', provider: 'deepgram' },
  { id: 'aura-2-rhea-nl', name: 'Aura-2 · Rhea (жен, Dutch)', language: 'nl', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-sander-nl', name: 'Aura-2 · Sander (муж, Dutch)', language: 'nl', gender: 'male', provider: 'deepgram' },
  { id: 'aura-2-livia-it', name: 'Aura-2 · Livia (жен, Italian)', language: 'it', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-dionisio-it', name: 'Aura-2 · Dionisio (муж, Italian)', language: 'it', gender: 'male', provider: 'deepgram' },
  { id: 'aura-2-izanami-ja', name: 'Aura-2 · Izanami (жен, Japanese)', language: 'ja', gender: 'female', provider: 'deepgram' },
  { id: 'aura-2-fujin-ja', name: 'Aura-2 · Fujin (муж, Japanese)', language: 'ja', gender: 'male', provider: 'deepgram' },
];

export const deepgramTTS: TTSProvider = {
  id: 'deepgram',
  name: 'Deepgram Flux TTS / Aura-2',
  description: 'Flux batch TTS для английского (/v2/speak) · Aura-2 для 7 языков (/v1/speak)',
  freeTier: true,
  languages: ['en', 'es', 'de', 'fr', 'nl', 'it', 'ja'],
  defaultModel: DEEPGRAM_FLUX_DEFAULT_MODEL,
  baseUrl: 'https://api.deepgram.com',

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    return generateDeepgramTTS(text, options);
  },

  async getVoices(): Promise<Voice[]> {
    return [...fluxVoices, ...auraVoices];
  },
};
