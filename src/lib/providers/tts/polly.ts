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

  async generate(text: string, { voice = 'Maxim', apiKey, language = 'ru-RU' }: TTSOptions): Promise<ArrayBuffer> {
    // apiKey here is expected to be JSON stringified AWS credentials or just key that our proxy understands
    // For MVP, we try direct Polly REST API with Bearer-like? Actually Polly needs AWS SigV4.
    // We'll route through our own proxy that expects apiKey as AWS credentials JSON: {accessKeyId, secretAccessKey, region}
    // If apiKey is simple string, we fallback to mock error with instruction
    try {
      const creds = JSON.parse(apiKey);
      if (!creds.accessKeyId) throw new Error('invalid');
      // Call our proxy
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: 'polly',
          text,
          voice,
          apiKey, // will be parsed server-side
          language
        })
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Polly proxy error: ${res.status} ${err}`);
      }
      return res.arrayBuffer();
    } catch (e) {
      // If apiKey is not JSON, try to use it as if it's already proxied or throw helpful error
      throw new Error('Polly требует AWS credentials в формате JSON: {"accessKeyId":"...","secretAccessKey":"...","region":"eu-central-1"}. Вставь в поле ключа.');
    }
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
