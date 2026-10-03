import { TTSProvider, TTSOptions, Voice } from './types';

export const fishTTS: TTSProvider = {
  id: 'fish',
  name: 'Fish Audio',
  description: 'Free tier · 50+ языков, backed by Novita AI',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  // Не проверено вживую: эндпоинт/поля взяты из документации (см. npm run smoke:tts).
  experimental: true,
  baseUrl: 'https://api.fish.audio',

  async generate(text: string, { voice = 'default', apiKey }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        reference_id: voice !== 'default' ? voice : undefined,
        format: 'mp3'
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Fish Audio error: ${res.status} — ${err.slice(0,500)}`);
    }
    return res.arrayBuffer();
  },

  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      return [
        { id: 'default', name: 'Default (multi)', language: 'multi', gender: 'neutral', provider: 'fish' },
      ];
    }
    try {
      const res = await fetch('https://api.fish.audio/v1/models', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('fail');
      const data = await res.json();
      return (data.items || data.models || []).slice(0, 20).map((v: any) => ({
        id: v._id || v.id,
        name: v.title || v.name || v._id,
        language: v.languages?.[0] || 'multi',
        gender: 'neutral',
        provider: 'fish'
      }));
    } catch {
      return [{ id: 'default', name: 'Default', language: 'multi', gender: 'neutral', provider: 'fish' }];
    }
  }
};
