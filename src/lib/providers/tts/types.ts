export interface TTSOptions {
  apiKey: string;
  /**
   * Голос. Необязателен: у каждого провайдера есть дефолт в сигнатуре generate
   * (voice = '...'), который срабатывает только на undefined — не на ''.
   */
  voice?: string;
  language?: 'ru' | 'en' | string;
  speed?: number;
  emotion?: string;
  model?: string;
  /**
   * Внешняя отмена (клиент закрыл вкладку, экспорт отменён). Прокидывается в
   * `providerFetch`, который прерывает текущую попытку и не делает новых.
   */
  signal?: AbortSignal;
  /**
   * Общий бюджет запроса в миллисекундах. Ставит маршрут `/api/tts`, чтобы
   * три попытки по 25 с не вышли за `maxDuration`; в браузере не задаётся.
   */
  deadlineMs?: number;
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
  /** Поддерживаемые/доступные модели; если есть getModels, UI может сверить их с API. */
  supportedModels?: string[];
  getModels?(apiKey: string): Promise<string[]>;
  getVoices(apiKey: string): Promise<Voice[]>;
  generate(text: string, options: TTSOptions): Promise<ArrayBuffer>;
  /**
   * Серверная реализация синтеза для /api/tts. Нужна только если серверный
   * запрос отличается от клиентского (подпись, SDK): иначе маршрут вызывает
   * обычную generate(), и её fetch идёт на внешний API — это безопасно.
   */
  serverGenerate?: (text: string, options: TTSOptions) => Promise<ArrayBuffer>;
  /**
   * true — generate() обращается к /api/tts. Вызывать её на сервере НЕЛЬЗЯ:
   * это рекурсия (сервер → сам себя → таймаут). Такому провайдеру нужен либо
   * `serverGenerate`, либо запись в `tts/server/overrides.ts`: маршрут больше
   * не содержит собственных веток по провайдерам.
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
