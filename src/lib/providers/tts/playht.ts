import { TTSProvider, TTSOptions, Voice } from './types';

export const playhtTTS: TTSProvider = {
  id: 'playht',
  name: 'PlayHT',
  description: 'Free tier · 900+ голосов, клонирование',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  baseUrl: 'https://api.play.ht',

  async generate(text: string, { voice = 's3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json', apiKey }: TTSOptions): Promise<ArrayBuffer> {
    // PlayHT requires USER_ID and API_KEY separated by | or JSON
    // Expect apiKey format: "userId:apiKey" or just apiKey
    let userId = '';
    let key = apiKey;
    if (apiKey.includes(':')) {
      const parts = apiKey.split(':');
      userId = parts[0];
      key = parts.slice(1).join(':');
    } else {
      try {
        const parsed = JSON.parse(apiKey);
        userId = parsed.userId || parsed.user_id || '';
        key = parsed.apiKey || parsed.key || apiKey;
      } catch {}
    }
    const res = await fetch('https://api.play.ht/api/v2/tts', {
      method: 'POST',
      headers: {
        'AUTHORIZATION': key,
        'X-USER-ID': userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice: voice,
        output_format: 'mp3',
        voice_engine: 'Play3.0-mini'
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`PlayHT error: ${res.status} — ${err.slice(0,500)}`);
    }
    // PlayHT returns streaming URL in header or direct audio
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('audio')) {
      return res.arrayBuffer();
    }
    const data = await res.json();
    const url = data.url || data.audioUrl || data.href;
    if (url) {
      const audioRes = await fetch(url);
      return audioRes.arrayBuffer();
    }
    throw new Error('PlayHT: no audio url');
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'en-US-JennyNeural', name: 'Jenny (жен, EN)', language: 'en', gender: 'female', provider: 'playht' },
      { id: 'ru-RU-DmitryNeural', name: 'Dmitry (муж, RU)', language: 'ru', gender: 'male', provider: 'playht' },
      { id: 'en-US-GuyNeural', name: 'Guy (муж, EN)', language: 'en', gender: 'male', provider: 'playht' },
    ];
  }
};
