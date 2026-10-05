import { TTSProvider, TTSOptions } from './types';
import { geminiTTS } from './gemini';
import { elevenLabsTTS } from './elevenlabs';
import { speechifyTTS } from './speechify';
import { openAITTS } from './openai';
import { pollyTTS } from './polly';
import { qwenTTS } from './qwen';
import { azureTTS } from './azure';
import { googleCloudTTS } from './google-cloud';
import { cartesiaTTS } from './cartesia';
import { humeTTS } from './hume';
import { deepgramTTS } from './deepgram';
import { playhtTTS } from './playht';
import { resembleTTS } from './resemble';
import { murfTTS } from './murf';
import { fishTTS } from './fish';

export const TTS_PROVIDERS: TTSProvider[] = [
  geminiTTS,
  elevenLabsTTS,
  azureTTS,
  googleCloudTTS,
  speechifyTTS,
  openAITTS,
  pollyTTS,
  qwenTTS,
  cartesiaTTS,
  humeTTS,
  deepgramTTS,
  playhtTTS,
  resembleTTS,
  murfTTS,
  fishTTS,
].filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i); // dedup safety

export function getTTSProvider(id: string): TTSProvider | undefined {
  return TTS_PROVIDERS.find(p => p.id === id);
}

/** Модели из API провайдера или его каталога, если динамическая проверка не реализована. */
export async function getModels(providerId: string, apiKey: string): Promise<string[]> {
  const provider = getTTSProvider(providerId);
  if (!provider) return [];
  if (provider.getModels) return provider.getModels(apiKey);
  if (provider.supportedModels) return provider.supportedModels;
  return provider.defaultModel ? [provider.defaultModel] : [];
}

/**
 * Чем синтезировать звук на сервере. Возвращает null, если это небезопасно:
 * клиентская generate() ходит через прокси, а серверной реализации нет —
 * иначе получилась бы рекурсия /api/tts → /api/tts.
 */
export function getServerGenerate(provider: TTSProvider): ((text: string, options: TTSOptions) => Promise<ArrayBuffer>) | null {
  if (provider.serverGenerate) return provider.serverGenerate;
  if (provider.proxyClientSide) return null;
  return provider.generate;
}
