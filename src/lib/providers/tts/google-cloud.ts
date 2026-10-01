import { TTSProvider, TTSOptions, Voice } from './types';

export const googleCloudTTS: TTSProvider = {
  id: 'google-cloud',
  name: 'Google Cloud TTS',
  description: '4M Standard / 1M WaveNet / мес · 380+ голосов',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  baseUrl: 'https://texttospeech.googleapis.com',

  async generate(text: string, { voice = 'ru-RU-Wavenet-A', apiKey, speed = 1.0, language = 'ru-RU' }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: language, name: voice },
        audioConfig: { audioEncoding: 'MP3', speakingRate: speed }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google Cloud TTS error: ${res.status} — ${err.slice(0,500)}`);
    }
    const data = await res.json();
    if (!data.audioContent) throw new Error('No audioContent');
    const binary = atob(data.audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'ru-RU-Wavenet-A', name: 'Wavenet-A (жен, RU)', language: 'ru', gender: 'female', provider: 'google-cloud' },
      { id: 'ru-RU-Wavenet-B', name: 'Wavenet-B (муж, RU)', language: 'ru', gender: 'male', provider: 'google-cloud' },
      { id: 'ru-RU-Wavenet-C', name: 'Wavenet-C (жен, RU)', language: 'ru', gender: 'female', provider: 'google-cloud' },
      { id: 'ru-RU-Wavenet-D', name: 'Wavenet-D (муж, RU)', language: 'ru', gender: 'male', provider: 'google-cloud' },
      { id: 'en-US-Wavenet-A', name: 'Wavenet-A (жен, EN)', language: 'en', gender: 'female', provider: 'google-cloud' },
      { id: 'en-US-Wavenet-D', name: 'Wavenet-D (муж, EN)', language: 'en', gender: 'male', provider: 'google-cloud' },
    ];
  }
};
