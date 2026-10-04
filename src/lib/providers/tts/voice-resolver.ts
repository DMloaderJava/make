/**
 * Резолвер голоса по умолчанию.
 *
 * Раньше generateAudio.ts подставлял всем провайдерам 'Puck' (голос Gemini) —
 * Azure / Google Cloud / ElevenLabs / Polly получали невалидный voice id и
 * отвечали 400. Теперь дефолт берётся из списка голосов самого провайдера,
 * а статический фолбэк — из таблицы ниже.
 */

import { getTTSProvider } from './catalog';

/**
 * Статические дефолты для проверенных провайдеров. Экспериментальные
 * (experimental: true) сюда не должны попадать как рабочий путь: их id не
 * подтверждены живым ключом, поэтому resolveVoice для них честно падает с
 * «укажите голос вручную» (см. ниже). Значения для них оставлены только для
 * UI-подсказок.
 */
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
 * Возвращает голос для озвучки: явный (если задан и валиден) → первый голос
 * провайдера → статический фолбэк.
 *
 * Для провайдеров с `experimental: true` шаги «первый голос» и «фолбэк» пропущены
 * сознательно: нужен явный голос от пользователя (см. ниже).
 */
export async function resolveVoice(
  providerId: string,
  apiKey: string,
  explicit?: string
): Promise<string> {
  const provider = getTTSProvider(providerId);

  // 'default' — исторический сентинел «голос не выбран». Но у resemble это же
  // значение — реальный id из его списка, поэтому для экспериментальных
  // провайдеров явный 'default' считаем выбором пользователя, а не пустотой.
  const explicitIsReal = explicit && explicit.trim() && (explicit !== 'default' || provider?.experimental);
  if (explicitIsReal) return explicit;

  // Экспериментальные провайдеры: голос НИКОГДА не резолвится автоматически.
  // Их списки голосов без ключа — заглушки-примеры (speechify 'matthew'), а id
  // из FALLBACK_VOICE не подтверждены живым API: молча отправить такое значение
  // хуже, чем честно попросить выбрать голос один раз в диалоге «Голоса».
  if (provider?.experimental) {
    throw new Error(
      `${provider.name}: провайдер помечен как экспериментальный — выберите голос ` +
      `вручную (диалог «Голоса»), автоматический дефолт для него не подставляется.`
    );
  }

  try {
    if (provider) {
      const voices = await provider.getVoices(apiKey || '');
      if (voices.length > 0 && voices[0].id) return voices[0].id;
    }
  } catch {
    // список голосов недоступен (нет ключа/сети) — падаем в статический фолбэк
  }

  return fallbackVoice(providerId);
}
