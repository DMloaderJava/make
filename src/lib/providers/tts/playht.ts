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
        'Authorization': `Bearer ${key}`,
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

  async getVoices(apiKey: string): Promise<Voice[]> {
    // Раньше здесь возвращались Azure-голоса (en-US-JennyNeural), которые PlayHT
    // не принимает. Пробуем получить реальный список, иначе — известные голоса PlayHT.
    if (apiKey) {
      let userId = '';
      let key = apiKey;
      if (apiKey.includes(':')) {
        const parts = apiKey.split(':');
        userId = parts[0];
        key = parts.slice(1).join(':');
      }
      try {
        const res = await fetch('https://api.play.ht/api/v2/voices', {
          headers: { Authorization: `Bearer ${key}`, 'X-USER-ID': userId },
        });
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : data.voices || [];
          if (list.length > 0) {
            return list.slice(0, 50).map((v: any) => ({
              id: v.id,
              name: `${v.name || v.id} (${v.language || 'multi'})`,
              language: v.language || 'multi',
              gender: (v.gender as any) || 'neutral',
              provider: 'playht',
            }));
          }
        }
      } catch {
        // нет сети/ключа — отдаём известные голоса ниже
      }
    }
    return [
      { id: 's3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json', name: 'Female (multi)', language: 'multi', gender: 'female', provider: 'playht' },
      { id: 's3://voice-cloning-zero-shot/baf1ef41-36b6-428c-9bdf-50ba54682bd8/male-cs/manifest.json', name: 'Male (multi)', language: 'multi', gender: 'male', provider: 'playht' },
    ];
  }
};
