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
  deepgram: 'flux-hannah-en',
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
  explicit?: string,
  language?: string
): Promise<string> {
  const provider = getTTSProvider(providerId);

  // Deepgram model IDs encode the spoken language; fail clearly for a language
  // outside Aura-2/Flux rather than silently selecting an English voice.
  if (providerId === 'deepgram' && language && language !== 'multi') {
    const languageBase = language.toLowerCase().split('-')[0];
    if (!getTTSProvider('deepgram')?.languages.includes(languageBase)) {
      throw new Error(`Deepgram TTS не поддерживает язык ${language}. Доступны English, Spanish, German, French, Dutch, Italian и Japanese.`);
    }
  }

  // 'default' — сентинел «голос не выбран» и у resemble, и у fish это лишь
  // заглушка из курированного списка: в API уйдёт voice_id='default', и ошибку
  // сформулирует провайдер. Поэтому сентинел не считается выбором нигде.
  if (explicit && explicit.trim() && explicit !== 'default') return explicit;

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
      const languageBase = language && language !== 'multi' ? language.toLowerCase().split('-')[0] : '';
      const matchingVoice = languageBase
        ? voices.find(voice => voice.language.toLowerCase().split('-')[0] === languageBase)
        : undefined;
      if (matchingVoice?.id) return matchingVoice.id;
      if (voices.length > 0 && voices[0].id) return voices[0].id;
    }
  } catch {
    // список голосов недоступен (нет ключа/сети) — падаем в статический фолбэк
  }

  return fallbackVoice(providerId);
}
