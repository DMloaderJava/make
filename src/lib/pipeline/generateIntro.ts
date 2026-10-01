import { LLMProvider, LLMOptions } from '../providers/llm/types';
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

  const result = await llm.chat(messages, {
    ...options,
    temperature: 0.8,
    maxTokens: 500
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

  const result = await llm.chat(messages, {
    ...options,
    temperature: 0.7,
    maxTokens: 300
  });

  return safeParseText(result);
}

// Fallback generators if LLM fails
export function generateFallbackIntro(sceneDescription: string): string {
  return `Вы когда-нибудь задумывались, что скрывается за одним кадром? За одним взглядом, за одной фразой? Эта сцена — именно такой момент. Здесь всё меняется. Эмоции накалены до предела, и каждое слово имеет вес. Давайте погрузимся в эту историю и посмотрим, что происходит, когда герои сталкиваются с тем, что меняет их навсегда. Сейчас вы увидите всё своими глазами.`;
}

export function generateFallbackOutro(siteName: string): string {
  return `Спасибо, что досмотрели до конца! Если вам понравилось это озвученное видео, поддержите лайком и комментарием. Больше такого контента — в шапке профиля. Подписывайтесь на ${siteName}, чтобы не пропустить новые серии. До скорой встречи!`;
}
