import { TTSProvider, TTSOptions, Voice } from './types';

/**
 * Тело запроса к Cartesia «Text to Speech (Bytes)» для версии API 2024-06-10.
 *
 * Исправлено по документации этой версии (docs.cartesia.ai/2024-06-10/api-reference/tts/bytes):
 *  - `output_format.encoding` принимает только PCM (pcm_f32le/pcm_s16le/pcm_mulaw/
 *    pcm_alaw); для контейнера mp3 обязателен `bit_rate`, а `encoding: 'mp3'`
 *    не существует — сервер мог отвечать 400;
 *  - top-level `speed` — строка-перечисление ('slow' | 'normal' | 'fast'), а не
 *    число, поэтому ползунок темпа (множитель 0.5–2.0) переводится в ступень.
 *
 * Общий для клиентского пути и серверной ветки /api/tts: раньше тела дублировались
 * и расходились.
 */
export function buildCartesiaBody(text: string, options: {
  voice?: string;
  language?: string;
  speed?: number;
  model?: string;
}): Record<string, unknown> {
  const speed = options.speed ?? 1;
  return {
    model_id: options.model || 'sonic-3',
    transcript: text,
    voice: { mode: 'id', id: options.voice || '79a125e8-cd45-4c13-8a67-188112f4dd22' },
    language: options.language || 'en',
    output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    speed: speed < 0.95 ? 'slow' : speed > 1.05 ? 'fast' : 'normal',
  };
}

export const cartesiaTTS: TTSProvider = {
  id: 'cartesia',
  name: 'Cartesia Sonic 3',
  description: 'Free tier, 40ms latency · SSM architecture',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  defaultModel: 'sonic-3',
  baseUrl: 'https://api.cartesia.ai',

  async generate(text: string, { voice, apiKey, speed, language, model }: TTSOptions): Promise<ArrayBuffer> {
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: {
        'Cartesia-Version': '2024-06-10',
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildCartesiaBody(text, { voice, language, speed, model }))
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Cartesia error: ${res.status} — ${err.slice(0,500)}`);
    }
    return res.arrayBuffer();
  },

  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      return [
        { id: '79a125e8-cd45-4c13-8a67-188112f4dd22', name: 'Barbershop Man (муж)', language: 'en', gender: 'male', provider: 'cartesia' },
        { id: 'a0e0a6d2-8a94-4b5d-9c9a-8a94a6d2a0e0', name: 'Sonic (жен, демо-ID)', language: 'en', gender: 'female', provider: 'cartesia' },
      ];
    }
    try {
      const res = await fetch('https://api.cartesia.ai/voices', {
        headers: { 'X-API-Key': apiKey, 'Cartesia-Version': '2024-06-10' }
      });
      if (!res.ok) throw new Error('fail');
      const data = await res.json();
      return (data.data || data).slice(0, 20).map((v: any) => ({
        id: v.id,
        name: v.name || v.id,
        language: v.language || 'en',
        gender: 'neutral',
        provider: 'cartesia'
      }));
    } catch {
      return [{ id: '79a125e8-cd45-4c13-8a67-188112f4dd22', name: 'Barbershop Man', language: 'en', gender: 'male', provider: 'cartesia' }];
    }
  }
};
