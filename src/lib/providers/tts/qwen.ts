import { TTSProvider, TTSOptions, Voice } from './types';

export const qwenTTS: TTSProvider = {
  id: 'qwen',
  name: 'Qwen3-TTS / DashScope',
  description: '49 голосов, 10 языков, 1M символов free',
  freeTier: true,
  languages: ['ru', 'en', 'zh', 'multi'],
  defaultModel: 'qwen3-tts-flash',
  baseUrl: 'https://dashscope.aliyuncs.com',

  async generate(text: string, { voice = 'Chelsie', apiKey, language = 'ru', model }: TTSOptions): Promise<ArrayBuffer> {
    // Qwen TTS via DashScope API
    const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
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
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Qwen TTS error: ${response.status} — ${err}`);
    }

    const data = await response.json();
    const audioUrl = data.output?.audio?.url || data.output?.audio_url;
    if (audioUrl) {
      // Download audio from url
      const audioRes = await fetch(audioUrl);
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
