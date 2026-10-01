import { TTSProvider, TTSOptions, Voice } from './types';

export const deepgramTTS: TTSProvider = {
  id: 'deepgram',
  name: 'Deepgram Aura-2',
  description: '$200 credit · domain-tuned pronunciation',
  freeTier: true,
  languages: ['en', 'multi'],
  baseUrl: 'https://api.deepgram.com',

  async generate(text: string, { voice = 'aura-2-thalia-en', apiKey }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch(`https://api.deepgram.com/v1/speak?model=${voice}&encoding=mp3`, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Deepgram error: ${res.status} — ${err.slice(0,500)}`);
    }
    return res.arrayBuffer();
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'aura-2-thalia-en', name: 'Thalia (жен, EN)', language: 'en', gender: 'female', provider: 'deepgram' },
      { id: 'aura-2-luna-en', name: 'Luna (жен, EN)', language: 'en', gender: 'female', provider: 'deepgram' },
      { id: 'aura-2-stella-en', name: 'Stella (жен, EN)', language: 'en', gender: 'female', provider: 'deepgram' },
      { id: 'aura-2-orion-en', name: 'Orion (муж, EN)', language: 'en', gender: 'male', provider: 'deepgram' },
      { id: 'aura-2-arcas-en', name: 'Arcas (муж, EN)', language: 'en', gender: 'male', provider: 'deepgram' },
      { id: 'aura-2-asteria-en', name: 'Asteria (жен, EN)', language: 'en', gender: 'female', provider: 'deepgram' },
    ];
  }
};
