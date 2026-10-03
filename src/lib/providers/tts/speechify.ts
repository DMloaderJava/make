import { TTSProvider, TTSOptions, Voice } from './types';

export const speechifyTTS: TTSProvider = {
  id: 'speechify',
  name: 'Speechify',
  description: '1000+ голосов, celebrity voices, Simba 3.2, 60+ языков',
  freeTier: false,
  defaultModel: 'simba-base',
  languages: ['ru', 'en', 'multi'],
  // Не проверено вживую: эндпоинт/поля взяты из документации (см. npm run smoke:tts).
  experimental: true,
  baseUrl: 'https://api.sws.speechify.com',

  async generate(text: string, { voice = 'matthew', apiKey, speed = 1.0, language = 'ru-RU', model }: TTSOptions): Promise<ArrayBuffer> {
    // Speechify API - simplified
    const response = await fetch('https://api.sws.speechify.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        voice_id: voice,
        audio_format: 'mp3',
        language: language,
        model: model || 'simba-base',
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Speechify error: ${response.status} — ${err}`);
    }

    const data = await response.json();
    // Speechify returns audio_data as base64
    if (data.audio_data) {
      const binary = atob(data.audio_data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    // fallback: if returns direct audio
    return response.arrayBuffer();
  },

  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      return [
        { id: 'matthew', name: 'Matthew (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
        { id: 'george', name: 'George (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
        { id: 'cliff', name: 'Cliff (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
        { id: 'guy', name: 'Guy (муж, en)', language: 'en', gender: 'male', provider: 'speechify' },
      ];
    }
    try {
      const res = await fetch('https://api.sws.speechify.com/v1/voices', {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('fail');
      const data = await res.json();
      return data.map((v: any) => ({
        id: v.id,
        name: v.name,
        language: v.language || 'en',
        gender: v.gender || 'neutral',
        provider: 'speechify'
      }));
    } catch {
      return [
        { id: 'matthew', name: 'Matthew', language: 'en', gender: 'male', provider: 'speechify' },
      ];
    }
  }
};
