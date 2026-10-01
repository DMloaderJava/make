export interface LLMOptions {
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  baseUrl?: string;
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
  freeTier: boolean;
  supportsVision: boolean;
  baseUrl: string;
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
