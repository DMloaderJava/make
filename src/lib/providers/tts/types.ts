export interface TTSOptions {
  apiKey: string;
  voice: string;
  language?: 'ru' | 'en' | string;
  speed?: number;
  emotion?: string;
  model?: string;
}

export interface Voice {
  id: string;
  name: string;
  language: string;
  gender: 'male' | 'female' | 'neutral';
  description?: string;
  provider: string;
}

export interface TTSProvider {
  id: string;
  name: string;
  description: string;
  freeTier: boolean;
  languages: string[];
  /**
   * Реализация не проверена вживую с реальным ключом (URL/поля взяты из
   * документации). Показываем бейдж в UI и не обещаем «всё работает».
   * Снимается после успешного `npm run smoke:tts` — результат пишем в README.
   */
  experimental?: boolean;
  /**
   * false — провайдер не умеет менять темп речи: `speed` ему не передаётся,
   * UI помечает поле «Скорость» как неподдерживаемое (вместо молчаливого игнора).
   */
  supportsSpeed?: boolean;
  /** Модель по умолчанию — единый источник для настроек и UI (раньше хардкодилась в VoicesModal). */
  defaultModel?: string;
  getVoices(apiKey: string): Promise<Voice[]>;
  generate(text: string, options: TTSOptions): Promise<ArrayBuffer>;
  /**
   * Серверная реализация синтеза для /api/tts.
   * Если не задана и `proxyClientSide` не выставлен, сервер использует generate()
   * (её fetch идёт на внешний API — это безопасно).
   */
  serverGenerate?: (text: string, options: TTSOptions) => Promise<ArrayBuffer>;
  /**
   * true — generate() обращается к /api/tts. Вызывать её на сервере НЕЛЬЗЯ:
   * это рекурсия (сервер → сам себя → таймаут). Такие провайдеры обязаны иметь
   * либо явную серверную ветку в route.ts, либо serverGenerate.
   */
  proxyClientSide?: boolean;
  // For server proxy
  baseUrl?: string;
}

export interface TTSRequest {
  providerId: string;
  text: string;
  voice: string;
  apiKey: string;
  language?: string;
  speed?: number;
  model?: string;
}
