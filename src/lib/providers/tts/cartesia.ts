import { TTSProvider, TTSOptions, Voice } from './types';

/**
 * Тело запроса к Cartesia «Text to Speech (Bytes)» для версии API 2026-03-01.
 *
 * Формат mp3 и скорость заданы по текущей схеме API (docs.cartesia.ai):
 *  - `output_format.encoding` принимает только PCM (pcm_f32le/pcm_s16le/pcm_mulaw/
 *    pcm_alaw); для контейнера mp3 обязателен `bit_rate`, а `encoding: 'mp3'`
 *    не существует — сервер мог отвечать 400;
 *  - top-level `speed` — строка-перечисление ('slow' | 'normal' | 'fast'), а не
 *    число, поэтому ползунок темпа (множитель 0.5–2.0) переводится в ступень.
 *
 * Общий для клиентского пути и серверной ветки /api/tts: раньше тела дублировались
 * и расходились.
 */
/** Дефолтный голос Cartesia — единое место (раньше дублировался в теле и в UI-списке). */
export const CARTESIA_DEFAULT_VOICE = '79a125e8-cd45-4c13-8a67-188112f4dd22';

const CARTESIA_URL = 'https://api.cartesia.ai/tts/bytes';
export const CARTESIA_VERSION = '2026-03-01';
export const CARTESIA_DEFAULT_MODEL = 'sonic-3.5';

export function buildCartesiaBody(text: string, options: {
  voice?: string;
  language?: string;
  speed?: number;
  model?: string;
}): Record<string, unknown> {
  const speed = options.speed ?? 1;
  const body: Record<string, unknown> = {
    model_id: options.model || CARTESIA_DEFAULT_MODEL,
    transcript: text,
    voice: { mode: 'id', id: options.voice || CARTESIA_DEFAULT_VOICE },
    language: options.language || 'en',
    output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
  };
  // 'normal' — дефолт API. Если темп не меняли, поле не отправляем: меньше полей —
  // меньше шансов разойтись со схемой конкретной версии API (см. комментарий выше).
  if (speed < 0.95) body.speed = 'slow';
  else if (speed > 1.05) body.speed = 'fast';
  return body;
}

/**
 * Единственный путь запроса к Cartesia: используется и клиентской generate(),
 * и серверной веткой /api/tts (раньше это были две копии с разными телами).
 *
 * Страховка от расхождения схемы: если API отверг тело и в тексте ошибки есть
 * `speed` — пробуем ещё раз уже без этого поля (в части версий это enum, в
 * части — число). Остальные 400 не повторяем: это не наша схема, а входные
 * данные (ключ/голос).
 */
export async function generateCartesia(text: string, options: TTSOptions): Promise<ArrayBuffer> {
  const headers = {
    'Cartesia-Version': CARTESIA_VERSION,
    'X-API-Key': options.apiKey,
    'Content-Type': 'application/json',
  };
  const body = buildCartesiaBody(text, options);

  let res = await fetch(CARTESIA_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 400 && /speed/i.test(errText) && 'speed' in body) {
      const retry = { ...body };
      delete retry.speed;
      res = await fetch(CARTESIA_URL, { method: 'POST', headers, body: JSON.stringify(retry) });
      if (res.ok) return res.arrayBuffer();
      const retryText = await res.text();
      const error = new Error(`Cartesia error: ${res.status} — ${retryText.slice(0, 500)}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    const error = new Error(`Cartesia error: ${res.status} — ${errText.slice(0, 500)}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return res.arrayBuffer();
}

export const cartesiaTTS: TTSProvider = {
  id: 'cartesia',
  name: 'Cartesia Sonic 3.5',
  description: 'Free tier, 40ms latency · SSM architecture',
  freeTier: true,
  languages: ['ru', 'en', 'multi'],
  defaultModel: CARTESIA_DEFAULT_MODEL,
  baseUrl: 'https://api.cartesia.ai',

  async generate(text: string, options: TTSOptions): Promise<ArrayBuffer> {
    return generateCartesia(text, options);
  },

  async getVoices(apiKey: string): Promise<Voice[]> {
    if (!apiKey) {
      return [
        { id: CARTESIA_DEFAULT_VOICE, name: 'Barbershop Man (муж)', language: 'en', gender: 'male', provider: 'cartesia' },
        { id: 'a0e0a6d2-8a94-4b5d-9c9a-8a94a6d2a0e0', name: 'Sonic (жен, демо-ID)', language: 'en', gender: 'female', provider: 'cartesia' },
      ];
    }
    try {
      const res = await fetch('https://api.cartesia.ai/voices', {
        headers: { 'X-API-Key': apiKey, 'Cartesia-Version': CARTESIA_VERSION }
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
      return [{ id: CARTESIA_DEFAULT_VOICE, name: 'Barbershop Man', language: 'en', gender: 'male', provider: 'cartesia' }];
    }
  }
};
