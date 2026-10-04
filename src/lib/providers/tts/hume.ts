import { TTSProvider, TTSOptions, Voice } from './types';

export const humeTTS: TTSProvider = {
  id: 'hume',
  name: 'Hume AI Octave 2',
  description: 'Free tier · эмоционально-осознанная, контекстная',
  freeTier: true,
  languages: ['en', 'multi'],
  // Не проверено вживую: эндпоинт/поля взяты из документации (см. npm run smoke:tts).
  experimental: true,
  baseUrl: 'https://api.hume.ai',

  async generate(text: string, { voice = 'ITO', apiKey }: TTSOptions): Promise<ArrayBuffer> {
    // Hume TTS Octave - simplified, real endpoint may vary
    const res = await fetch('https://api.hume.ai/v0/tts', {
      method: 'POST',
      headers: {
        'X-Hume-Api-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        utterances: [{ text, voice: { name: voice } }],
        format: { type: 'mp3' }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Hume error: ${res.status} — ${err.slice(0,500)}`);
    }
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
