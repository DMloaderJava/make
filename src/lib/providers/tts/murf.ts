import { TTSProvider, TTSOptions, Voice } from './types';

export const murfTTS: TTSProvider = {
  id: 'murf',
  name: 'Murf AI',
  description: 'Free tier · 120+ голосов, синхронизация с видео',
  freeTier: true,
  languages: ['en', 'multi'],
  baseUrl: 'https://api.murf.ai',

  async generate(text: string, { voice = 'en-US-natalie', apiKey }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch('https://api.murf.ai/v1/speech/generate', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        voiceId: voice,
        text: text,
        format: 'MP3',
        sampleRate: 44100
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Murf error: ${res.status} — ${err.slice(0,500)}`);
    }
    const data = await res.json();
    const url = data.audioFile || data.audio_url || data.encodedAudio;
    if (url && url.startsWith('http')) {
      const audioRes = await fetch(url);
      return audioRes.arrayBuffer();
    }
    if (data.encodedAudio) {
      const binary = atob(data.encodedAudio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    throw new Error('Murf: no audio');
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'en-US-natalie', name: 'Natalie (жен, EN)', language: 'en', gender: 'female', provider: 'murf' },
      { id: 'en-US-marcus', name: 'Marcus (муж, EN)', language: 'en', gender: 'male', provider: 'murf' },
      { id: 'en-US-ken', name: 'Ken (муж, EN)', language: 'en', gender: 'male', provider: 'murf' },
      { id: 'en-US-ava', name: 'Ava (жен, EN)', language: 'en', gender: 'female', provider: 'murf' },
    ];
  }
};
