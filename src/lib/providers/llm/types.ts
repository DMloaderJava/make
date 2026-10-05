/** Описание JSON-схемы ответа (прокидывается в response_format, если провайдер умеет). */
export interface ResponseFormatSchema {
  name?: string;
  schema: unknown;
  strict?: boolean;
}

export interface LLMOptions {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
  /** Cloudflare Workers AI использует ID аккаунта отдельно от API token. */
  accountId?: string;
  /** Ранее поле игнорировалось — openai-compatible.ts не клал его в тело запроса. */
  responseFormat?: ResponseFormatSchema;
}

export interface MessageContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContent[];
}

export interface LLMProvider {
  id: string;
  name: string;
  description: string;
  /** Бесплатный тариф доступен без карты и без ограничения по времени. */
  freeTier: boolean;
  /** Условие бесплатного тарифа или пробного периода (для UI). */
  freeTierNote?: string;
  /** Провайдер даёт только ограниченный пробный период/кредит. */
  trialOnly?: boolean;
  /** Ссылка на официальные лимиты или цены. */
  limitsUrl?: string;
  /** Лимиты для отображения в UI. */
  rateLimits?: { rpm?: number; rpd?: number };
  /** Префикс ключа, если он известен. */
  apiKeyPrefix?: string;
  /** Помимо ключа API требуется ID аккаунта. */
  requiresAccountId?: boolean;
  /** Provider-level flag: at least one catalog model can accept image input. */
  supportsVision: boolean;
  /** Explicit model IDs with image-input capability; empty/omitted means no catalog vision model. */
  visionModels?: string[];
  baseUrl: string;
  /** Только модели из указанного в каталоге бесплатного тарифа/кредита. */
  models: string[];
  defaultModel: string;
  chat(messages: Message[], options: LLMOptions): Promise<string>;
  vision?: (imageBase64: string, prompt: string, options: LLMOptions) => Promise<string>;
}

export interface VisionResult {
  imageWidth: number;
  imageHeight: number;
  panels: Array<{
    id: number;
    bbox: { x: number; y: number; width: number; height: number };
    dialogue: string;
    character: string;
    emotion: string;
    type: 'speech' | 'thought' | 'narration' | 'sfx';
    order: number;
  }>;
  sceneDescription: string;
  characters: Array<{ name: string; appearance: string }>;
}
