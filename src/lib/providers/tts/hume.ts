import { TTSProvider, TTSOptions, Voice } from './types';
import { ttsFetch } from './transport';

export const humeTTS: TTSProvider = {
  id: 'hume',
  name: 'Hume AI Octave 2',
  description: 'Free tier · эмоционально-осознанная, контекстная',
  freeTier: true,
  languages: ['en', 'multi'],
  // Не проверено вживую: эндпоинт/поля взяты из документации (см. npm run smoke:tts).
  experimental: true,
  baseUrl: 'https://api.hume.ai',

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    const { voice = 'ITO', apiKey } = options;
    // Hume TTS Octave - simplified, real endpoint may vary
    const res = await ttsFetch('hume', 'Hume', 'https://api.hume.ai/v0/tts', {
      method: 'POST',
      headers: {
        'X-Hume-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        utterances: [{ text, voice: { name: voice } }],
        format: { type: 'mp3' }
      })
    }, options);
    const data = await res.json();
    const audio = data.generations?.[0]?.audio || data.audio;
    if (audio) {
      const binary = atob(audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    return res.arrayBuffer();
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'ITO', name: 'ITO (муж, энергичный)', language: 'en', gender: 'male', provider: 'hume' },
      { id: 'KORA', name: 'KORA (жен, мягкий)', language: 'en', gender: 'female', provider: 'hume' },
      { id: 'DACHER', name: 'DACHER (муж, глубокий)', language: 'en', gender: 'male', provider: 'hume' },
      { id: 'AVA', name: 'AVA (жен, теплый)', language: 'en', gender: 'female', provider: 'hume' },
    ];
  }
};
