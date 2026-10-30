import { TTSProvider, TTSOptions, Voice } from './types';
import { ttsFetch } from './transport';

export const qwenTTS: TTSProvider = {
  id: 'qwen',
  name: 'Qwen3-TTS / DashScope',
  description: '49 голосов, 10 языков, 1M символов free',
  freeTier: true,
  languages: ['ru', 'en', 'zh', 'multi'],
  defaultModel: 'qwen3-tts-flash',
  baseUrl: 'https://dashscope.aliyuncs.com',

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    const { voice = 'Chelsie', apiKey, language = 'ru', model } = options;
    // Qwen TTS via DashScope API
    const response = await ttsFetch('qwen', 'Qwen TTS', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'qwen3-tts-flash',
        input: {
          text: text,
          voice: voice,
          language_type: language
        },
        parameters: {
          format: 'mp3'
        }
      })
    }, options);

    const data = await response.json();
    const audioUrl = data.output?.audio?.url || data.output?.audio_url;
    if (audioUrl) {
      // Ссылка на файл живёт минуты: повторяем один раз, но не ждём долго.
      const audioRes = await ttsFetch('qwen', 'Qwen TTS file', audioUrl, { method: 'GET' }, options, {
        retries: 1,
        timeoutMs: 20_000,
      });
      return audioRes.arrayBuffer();
    }
    // If returns base64
    if (data.output?.audio?.data) {
      const binary = atob(data.output.audio.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    throw new Error('Qwen TTS: no audio in response');
  },

  async getVoices(): Promise<Voice[]> {
    return [
      { id: 'Chelsie', name: 'Chelsie (жен, en)', language: 'en', gender: 'female', provider: 'qwen' },
      { id: 'Cherry', name: 'Cherry (жен, zh)', language: 'zh', gender: 'female', provider: 'qwen' },
      { id: 'Ethan', name: 'Ethan (муж, en)', language: 'en', gender: 'male', provider: 'qwen' },
      { id: 'Serena', name: 'Serena (жен, en)', language: 'en', gender: 'female', provider: 'qwen' },
      { id: 'Dylan', name: 'Dylan (муж, en)', language: 'en', gender: 'male', provider: 'qwen' },
      { id: 'Jada', name: 'Jada (жен, en)', language: 'en', gender: 'female', provider: 'qwen' },
    ];
  }
};
