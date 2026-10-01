import { TTSProvider, TTSOptions, Voice } from './types';

export const openAITTS: TTSProvider = {
  id: 'openai',
  name: 'OpenAI TTS',
  description: '$15/1M символов, простота, хорошее качество',
  freeTier: false,
  languages: ['ru', 'en', 'multi'],
  baseUrl: 'https://api.openai.com/v1',

  async generate(text: string, { voice = 'alloy', apiKey, speed = 1.0, model }: TTSOptions): Promise<ArrayBuffer> {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'tts-1-hd',
        input: text,
        voice: voice,
        speed: speed,
        response_format: 'mp3'
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI TTS error: ${response.status} — ${err}`);
    }

    return response.arrayBuffer();
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'alloy', name: 'Alloy (нейтральный)', language: 'multi', gender: 'neutral', provider: 'openai' },
      { id: 'echo', name: 'Echo (муж)', language: 'multi', gender: 'male', provider: 'openai' },
      { id: 'fable', name: 'Fable (муж, британский)', language: 'en', gender: 'male', provider: 'openai' },
      { id: 'onyx', name: 'Onyx (муж, глубокий)', language: 'multi', gender: 'male', provider: 'openai' },
      { id: 'nova', name: 'Nova (жен, энергичный)', language: 'multi', gender: 'female', provider: 'openai' },
      { id: 'shimmer', name: 'Shimmer (жен, мягкий)', language: 'multi', gender: 'female', provider: 'openai' },
    ];
  }
};
