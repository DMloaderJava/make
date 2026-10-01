import { TTSProvider, TTSOptions, Voice } from './types';

export const resembleTTS: TTSProvider = {
  id: 'resemble',
  name: 'Resemble AI',
  description: 'Free tier · клонирование, emotion control',
  freeTier: true,
  languages: ['en', 'multi'],
  baseUrl: 'https://app.resemble.ai',

  async generate(text: string, { voice = 'default', apiKey }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch('https://app.resemble.ai/api/v2/clips', {
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
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resemble error: ${res.status} — ${err.slice(0,500)}`);
    }
    const data = await res.json();
    const audioSrc = data.audio_src || data.clip?.audio_src || data.item?.audio_src;
    if (audioSrc) {
      const audioRes = await fetch(audioSrc);
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
