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
  /** Модель по умолчанию — единый источник для настроек и UI (раньше хардкодилась в VoicesModal). */
  defaultModel?: string;
  getVoices(apiKey: string): Promise<Voice[]>;
  generate(text: string, options: TTSOptions): Promise<ArrayBuffer>;
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
