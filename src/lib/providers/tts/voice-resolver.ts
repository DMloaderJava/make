/**
 * Резолвер голоса по умолчанию.
 *
 * Раньше generateAudio.ts подставлял всем провайдерам 'Puck' (голос Gemini) —
 * Azure / Google Cloud / ElevenLabs / Polly получали невалидный voice id и
 * отвечали 400. Теперь дефолт берётся из списка голосов самого провайдера,
 * а статический фолбэк — из таблицы ниже.
 */

import { getTTSProvider } from './catalog';

export const FALLBACK_VOICE: Record<string, string> = {
  gemini: 'Puck',
  openai: 'alloy',
  elevenlabs: '21m00Tcm4TlvDq8ikWAM',
  azure: 'ru-RU-SvetlanaNeural',
  'google-cloud': 'ru-RU-Wavenet-A',
  polly: 'Maxim',
  qwen: 'Chelsie',
  cartesia: '79a125e8-cd45-4c13-8a67-188112f4dd22',
  deepgram: 'aura-2-thalia-en',
  playht: 's3://voice-cloning-zero-shot/d9ff78ba-d016-47f6-b0ef-dd630f59414e/female-cs/manifest.json',
  resemble: 'default',
  murf: 'en-US-natalie',
  fish: 'default',
  hume: 'ITO',
  speechify: 'matthew',
};

export function fallbackVoice(providerId: string): string {
  return FALLBACK_VOICE[providerId] || 'default';
}

/**
 * Возвращает голос для озвучки: явный (если задан и валиден) →
 * первый голос провайдера → статический фолбэк.
 */
export async function resolveVoice(
  providerId: string,
  apiKey: string,
  explicit?: string
): Promise<string> {
  if (explicit && explicit.trim() && explicit !== 'default') return explicit;

  try {
    const provider = getTTSProvider(providerId);
    if (provider) {
      const voices = await provider.getVoices(apiKey || '');
      if (voices.length > 0 && voices[0].id) return voices[0].id;
    }
  } catch {
    // список голосов недоступен (нет ключа/сети) — падаем в статический фолбэк
  }

  return fallbackVoice(providerId);
}
