import { TTSProvider, TTSOptions, Voice } from './types';

// Amazon Polly via AWS API - for browser we proxy, but here direct implementation expects AWS credentials
// Simplified: uses AWS Polly via our /api/tts proxy that can handle AWS SigV4, or direct if using presigned
export const pollyTTS: TTSProvider = {
  id: 'polly',
  name: 'Amazon Polly',
  description: 'Нейронные голоса, AWS, 5M символов free 12 мес',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  baseUrl: 'https://polly.eu-central-1.amazonaws.com',
  // Клиент ходит в /api/tts (там AWS SDK и SigV4), поэтому серверу запрещено
  // звать эту generate() — ветка polly в route.ts идёт через SDK напрямую.
  proxyClientSide: true,

  async generate(text: string, { voice = 'Maxim', apiKey, language = 'ru-RU' }: TTSOptions): Promise<ArrayBuffer> {
    // aws-ключи хранятся как JSON-строка; проверяем её отдельно,
    // иначе любая ошибка прокси (500 и т.п.) превращалась в «нужны AWS-credentials».
    let creds: { accessKeyId?: string };
    try {
      creds = JSON.parse(apiKey);
    } catch {
      throw new Error('Polly требует AWS credentials в формате JSON: {"accessKeyId":"...","secretAccessKey":"...","region":"eu-central-1"}. Вставь в поле ключа.');
    }
    if (!creds?.accessKeyId) {
      throw new Error('Polly: в JSON-ключе нет accessKeyId.');
    }

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'polly', text, voice, apiKey, language }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Polly proxy error: ${res.status} — ${err.slice(0, 300)}`);
    }

    return res.arrayBuffer();
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'Maxim', name: 'Maxim (муж, русский)', language: 'ru', gender: 'male', provider: 'polly' },
      { id: 'Tatyana', name: 'Tatyana (жен, русский)', language: 'ru', gender: 'female', provider: 'polly' },
      { id: 'Matthew', name: 'Matthew (муж, en)', language: 'en', gender: 'male', provider: 'polly' },
      { id: 'Joanna', name: 'Joanna (жен, en)', language: 'en', gender: 'female', provider: 'polly' },
      { id: 'Léa', name: 'Léa (жен, fr)', language: 'fr', gender: 'female', provider: 'polly' },
    ];
  }
};
