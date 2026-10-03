import { TTSProvider, TTSOptions, Voice } from './types';

export const cartesiaTTS: TTSProvider = {
  id: 'cartesia',
  name: 'Cartesia Sonic 3',
  description: 'Free tier, 40ms latency · SSM architecture',
  freeTier: true,
  languages: ['en', 'multi'],
  baseUrl: 'https://api.cartesia.ai',

  async generate(text: string, { voice = '79a125e8-cd45-4c13-8a67-188112f4dd22', apiKey, speed = 1.0, language = 'ru' }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Cartesia-Version': '2024-06-10',
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: 'sonic-3',
        transcript: text,
        voice: { mode: 'id', id: voice },
        language,
        output_format: { container: 'mp3', encoding: 'mp3', sample_rate: 44100 },
        speed: speed,
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Cartesia error: ${res.status} — ${err.slice(0,500)}`);
    }
    return res.arrayBuffer();
  },

  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      return [
        { id: '79a125e8-cd45-4c13-8a67-188112f4dd22', name: 'Barbershop Man (муж)', language: 'en', gender: 'male', provider: 'cartesia' },
        { id: 'a0e0a6d2-8a94-4b5d-9c9a-8a94a6d2a0e0', name: 'Sonic (жен, демо-ID)', language: 'en', gender: 'female', provider: 'cartesia' },
      ];
    }
    try {
      const res = await fetch('https://api.cartesia.ai/voices', {
        headers: { 'X-API-Key': apiKey, 'Cartesia-Version': '2024-06-10' }
      });
      if (!res.ok) throw new Error('fail');
      const data = await res.json();
      return (data.data || data).slice(0, 20).map((v: any) => ({
        id: v.id,
        name: v.name || v.id,
        language: v.language || 'en',
        gender: 'neutral',
        provider: 'cartesia'
      }));
    } catch {
      return [{ id: '79a125e8-cd45-4c13-8a67-188112f4dd22', name: 'Barbershop Man', language: 'en', gender: 'male', provider: 'cartesia' }];
    }
  }
};
