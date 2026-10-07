/**
 * Перевод реплик сценария на язык озвучки (правило 2 формата сценария:
 * «каждая реплика переводится на нужный язык»).
 *
 * Одна батч-вызов к LLM: все реплики уходят одним JSON-массивом и возвращаются
 * одним JSON-массивом той же длины — экономит токены и не сдвигает порядок.
 */

import { LLMProvider, LLMOptions } from '../providers/llm/types';
import { generateLLM } from '../providers/llm/router';

/** Коды языков озвучки → название для промпта. */
const LANGUAGE_NAMES: Record<string, string> = {
  ru: 'русский',
  en: 'английский',
  ja: 'японский',
  ko: 'корейский',
  zh: 'китайский',
  de: 'немецкий',
  fr: 'французский',
  es: 'испанский',
  it: 'итальянский',
  pt: 'португальский',
  nl: 'нидерландский',
  pl: 'польский',
  uk: 'украинский',
  tr: 'турецкий',
  vi: 'вьетнамский',
  id: 'индонезийский',
  hi: 'хинди',
  ar: 'арабский',
};

export function targetLanguageName(code: string): string {
  const base = (code || '').toLowerCase().split('-')[0];
  return LANGUAGE_NAMES[base] || code || 'целевой';
}

/**
 * Можно ли вообще переводить на этот язык: 'multi' (мультиязычный) — нельзя,
 * переводить некуда; пустой код — язык не выбран.
 */
export function isTranslatableLanguage(code: string | undefined): boolean {
  const value = (code || '').toLowerCase();
  return value !== '' && value !== 'multi';
}

function parseJsonArray(text: string): string[] | null {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  candidates.push(text);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed.map(item => (typeof item === 'string' ? item : JSON.stringify(item)));
    } catch {}
  }
  return null;
}

/**
 * Переводит массив реплик на целевой язык. Возвращает массив той же длины;
 * при несовпадении количества строк или невалидном JSON бросает ошибку —
 * редактор покажет её и предложит применить сценарий без перевода.
 */
export async function translateScenarioLines(
  texts: string[],
  targetLanguage: string,
  llm: LLMProvider,
  options: LLMOptions
): Promise<string[]> {
  if (!isTranslatableLanguage(targetLanguage)) {
    throw new Error(`Перевод недоступен для языка «${targetLanguage || 'не выбран'}»: выберите конкретный язык озвучки в «Голоса».`);
  }
  if (texts.length === 0) return [];

  const languageName = targetLanguageName(targetLanguage);
  const messages = [
    {
      role: 'system' as const,
      content: `Ты — профессиональный переводчик реплик манги/комиксов для озвучки.
Переведи каждую реплику на ${languageName} язык.
Требования:
- сохраняй смысл, интонацию и эмоции реплики;
- перевод должен звучать естественно в устной речи;
- категорически запрещено добавлять имена персонажей, нумерацию, пояснения или любой текст вне реплик;
- ответ — СТРОГО валидный JSON-массив строк в том же порядке и том же количестве, что во входном массиве, без markdown.
Пример формата ответа: ["Переведённая реплика 1", "Переведённая реплика 2"]`,
    },
    {
      role: 'user' as const,
      content: `Входной массив реплик:\n${JSON.stringify(texts)}`,
    },
  ];

  const totalChars = texts.join('').length;
  const result = await generateLLM({
    provider: llm,
    task: 'chat',
    options: {
      ...options,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? Math.min(16000, 500 + totalChars * 4),
    },
    invoke: (candidate, candidateOptions) => candidate.chat(messages, candidateOptions),
  });

  const parsed = parseJsonArray(result);
  if (!parsed) {
    throw new Error('Перевод: LLM не вернула JSON-массив. Повторите попытку.');
  }
  if (parsed.length !== texts.length) {
    throw new Error(`Перевод: LLM вернула ${parsed.length} строк вместо ${texts.length}. Повторите попытку.`);
  }
  return parsed.map((translated, i) => translated.trim() || texts[i]);
}
