import { LLMProvider, LLMOptions } from '../providers/llm/types';
import { generateLLM } from '../providers/llm/router';
import { INTRO_SYSTEM_PROMPT, INTRO_USER_PROMPT, OUTRO_SYSTEM_PROMPT, OUTRO_USER_PROMPT } from '../prompts/intro-prompt';

function safeParseText(text: string): string {
  // Remove markdown code blocks if any
  const match = text.match(/```(?:.*)?\s*([\s\S]*?)\s*```/);
  if (match) return match[1].trim();
  return text.trim();
}

export async function generateIntro(
  sceneDescription: string,
  characters: string[],
  llm: LLMProvider,
  options: LLMOptions
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: INTRO_SYSTEM_PROMPT },
    { role: 'user' as const, content: INTRO_USER_PROMPT(sceneDescription, characters) }
  ];

  const result = await generateLLM({
    provider: llm,
    options: { ...options, temperature: 0.8, maxTokens: 500 },
    invoke: (candidate, candidateOptions) => candidate.chat(messages, candidateOptions),
  });

  return safeParseText(result);
}

export async function generateOutro(
  siteName: string,
  ctaType: 'profile' | 'description',
  llm: LLMProvider,
  options: LLMOptions
): Promise<string> {
  const messages = [
    { role: 'system' as const, content: OUTRO_SYSTEM_PROMPT },
    { role: 'user' as const, content: OUTRO_USER_PROMPT(siteName, ctaType) }
  ];

  const result = await generateLLM({
    provider: llm,
    options: { ...options, temperature: 0.7, maxTokens: 300 },
    invoke: (candidate, candidateOptions) => candidate.chat(messages, candidateOptions),
  });

  return safeParseText(result);
}

// Fallback generators if LLM fails
/** Имя канала по умолчанию (когда в настройках ничего не задано). */
export const DEFAULT_CHANNEL_NAME = 'Manga Voice Studio';

function pluralPanels(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'панель';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'панели';
  return 'панелей';
}

/**
 * Текст-заглушка интро: имя канала + число панелей.
 * Описание сцены здесь не используется (в отличие от LLM-пути generateIntro).
 * @param panels панели проекта (нужно только их количество)
 * @param channelName имя канала (project.settings.channelName → настройки → дефолт)
 */
export function generateFallbackIntro(panels: Array<{ dialogue: string }>, channelName?: string): string {
  const name = channelName?.trim() || DEFAULT_CHANNEL_NAME;
  const n = panels.length;
  return `${name}. В этом видео — ${n} ${pluralPanels(n)} озвученной манги. У каждого кадра — своя реплика, голос и настроение. Начнём.`;
}

/**
 * Текст-заглушка аутро: прощание + CTA на имя канала.
 * @param panels панели проекта (резерв для будущих шаблонов)
 * @param channelName имя канала (project.settings.channelName → настройки → дефолт)
 */
export function generateFallbackOutro(panels: Array<{ dialogue: string }>, channelName?: string): string {
  const name = channelName?.trim() || DEFAULT_CHANNEL_NAME;
  const n = panels.length;
  return `Спасибо, что досмотрели до конца! Если вам понравилось это озвученное видео — ${n} ${pluralPanels(n)} диалога, — поддержите лайком и комментарием. Подписывайтесь на ${name}, чтобы не пропустить новые серии. До скорой встречи!`;
}
