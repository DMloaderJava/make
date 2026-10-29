/**
 * Схемы тел запросов для серверных маршрутов провайдеров.
 *
 * Зачем: раньше каждый маршрут делал `const { ... } = await req.json()` и
 * передавал значения как есть. Мусорный `speed: "быстро"` уходил в апстрим,
 * `text` без ограничения длины мог уронить воркер по памяти, а `providerId`
 * проверялся только внутри `switch` — то есть добавление провайдера требовало
 * правки маршрута.
 *
 * Теперь граница описана один раз: zod проверяет типы и лимиты, а список
 * провайдеров сверяется с реестром в самом маршруте.
 */

import { z } from 'zod';

const MAX_TEXT = 10_000;
const MAX_KEY = 4096;
const MAX_MODEL = 128;

/** Число, которое клиент мог отправить строкой (старые сборки, curl, формы). */
const flexibleNumber = z.coerce.number().finite();

export const TTSRequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  text: z.string().min(1).max(MAX_TEXT),
  apiKey: z.string().min(1).max(MAX_KEY),
  voice: z.string().max(256).optional(),
  language: z.string().max(32).optional(),
  speed: flexibleNumber.min(0.25).max(4).optional(),
  model: z.string().max(MAX_MODEL).optional(),
});

export type TTSRequestInput = z.infer<typeof TTSRequestSchema>;

/** Части контента в OpenAI-формате: текст или картинка. Глубина ограничена. */
const MessageContentSchema = z.union([
  z.string().max(200_000),
  z
    .array(
      z.object({
        type: z.string().max(32),
        text: z.string().max(200_000).optional(),
        image_url: z.object({ url: z.string().max(20_000_000) }).optional(),
      })
    )
    .max(20),
]);

export const LLMMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: MessageContentSchema,
});

export const LLMRequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(MAX_KEY),
  messages: z.array(LLMMessageSchema).min(1).max(100),
  model: z.string().max(MAX_MODEL).optional(),
  temperature: flexibleNumber.min(0).max(2).optional(),
  maxTokens: flexibleNumber.min(1).max(100_000).optional(),
  /** Пользовательский endpoint (custom/Ollama): проверяется assertProviderTarget. */
  baseUrl: z.string().max(2048).optional(),
  accountId: z.string().max(256).optional(),
});

export const SEORequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  apiKey: z.string().min(1).max(MAX_KEY),
  sceneDescription: z.string().min(1).max(20_000),
  characters: z.array(z.string().max(200)).max(50).optional(),
  duration: flexibleNumber.min(1).max(36_000).optional(),
  model: z.string().max(MAX_MODEL).optional(),
  baseUrl: z.string().max(2048).optional(),
  accountId: z.string().max(256).optional(),
});

export const VoicesRequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  apiKey: z.string().max(MAX_KEY).optional(),
});

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Тексты zod по умолчанию — английские («Too big: expected string to have
 * <=10000 characters»). Пользователь видит их в UI как причину отказа, поэтому
 * переводим частые коды; остальное уходит как есть, но это уже редкость.
 */
function localizeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'обязательное поле' : `ожидается ${issue.expected}`;
    case 'too_big':
      if (issue.origin === 'string') return `слишком длинное (максимум ${issue.maximum} символов)`;
      if (issue.origin === 'array') return `слишком много элементов (максимум ${issue.maximum})`;
      return `значение больше допустимого (максимум ${issue.maximum})`;
    case 'too_small':
      if (issue.origin === 'string') return `слишком короткое (минимум ${issue.minimum} символов)`;
      if (issue.origin === 'array') return `пусто: нужно минимум ${issue.minimum} элем.`;
      return `значение меньше допустимого (минимум ${issue.minimum})`;
    case 'invalid_format':
      return 'неверный формат значения';
    case 'invalid_value':
      return `недопустимое значение (ожидается: ${(issue as { values?: unknown[] }).values?.join(', ') ?? '—'})`;
    case 'unrecognized_keys':
      return `лишние поля: ${(issue as { keys?: string[] }).keys?.join(', ') ?? '—'}`;
    default:
      return issue.message;
  }
}

export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.slice(0, 10).map(issue => ({
    path: issue.path.join('.') || '(root)',
    message: localizeIssue(issue),
  }));
}

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'invalid_json' }
  | { ok: false; reason: 'invalid_request'; issues: ValidationIssue[] };

/** Читает JSON и валидирует его схемой, не бросая исключений наружу. */
export async function parseJsonBody<S extends z.ZodType>(
  request: { json: () => Promise<unknown> },
  schema: S
): Promise<ParsedBody<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { ok: false, reason: 'invalid_request', issues: toValidationIssues(result.error) };
  }
  return { ok: true, data: result.data as z.infer<S> };
}
