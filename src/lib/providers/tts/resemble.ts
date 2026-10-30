import { TTSProvider, TTSOptions, Voice } from './types';
import { ttsFetch } from './transport';

export const resembleTTS: TTSProvider = {
  id: 'resemble',
  name: 'Resemble AI',
  description: 'Free tier · клонирование, emotion control',
  freeTier: true,
  languages: ['en', 'multi'],
  // Не проверено вживую: эндпоинт/поля взяты из документации (см. npm run smoke:tts).
  experimental: true,
  baseUrl: 'https://app.resemble.ai',

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    const { voice = 'default', apiKey } = options;
    const res = await ttsFetch('resemble', 'Resemble', 'https://app.resemble.ai/api/v2/clips', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          title: 'tts',
          body: text,
          voice: voice,
          format: 'mp3'
        }
      })
    }, options);
    const data = await res.json();
    const audioSrc = data.audio_src || data.clip?.audio_src || data.item?.audio_src;
    if (audioSrc) {
      const audioRes = await ttsFetch('resemble', 'Resemble file', audioSrc, { method: 'GET' }, options, { retries: 1 });
      return audioRes.arrayBuffer();
    }
    throw new Error('Resemble: no audio_src');
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'default', name: 'Default Voice', language: 'en', gender: 'neutral', provider: 'resemble' },
    ];
  }
};
