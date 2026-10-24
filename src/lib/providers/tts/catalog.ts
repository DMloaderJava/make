/**
 * Каталог TTS-провайдеров.
 *
 * Реализации протоколов живут в отдельных файлах (`gemini.ts`, `azure.ts`, …),
 * а метаданные карточки (имя, описание, языки, free tier, experimental, CORS)
 * берутся из единого реестра (`../registry.ts`). Так добавление провайдера —
 * это одна запись в реестре + файл реализации, без правки `links.ts`,
 * `cors.ts` и прокси-маршрута.
 *
 * Если реестр объявляет провайдера, а реализации нет — модуль падает сразу:
 * лучше упасть при импорте в тесте/CI, чем отдать пользователю пустой каталог.
 */

import { getImplementedProviders } from '../registry';
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

/** Реализации протоколов по id. Ключ — тот же, что `id` в реестре. */
const TTS_IMPLEMENTATIONS: Record<string, TTSProvider> = {
  [geminiTTS.id]: geminiTTS,
  [elevenLabsTTS.id]: elevenLabsTTS,
  [speechifyTTS.id]: speechifyTTS,
  [openAITTS.id]: openAITTS,
  [pollyTTS.id]: pollyTTS,
  [qwenTTS.id]: qwenTTS,
  [azureTTS.id]: azureTTS,
  [googleCloudTTS.id]: googleCloudTTS,
  [cartesiaTTS.id]: cartesiaTTS,
  [humeTTS.id]: humeTTS,
  [deepgramTTS.id]: deepgramTTS,
  [playhtTTS.id]: playhtTTS,
  [resembleTTS.id]: resembleTTS,
  [murfTTS.id]: murfTTS,
  [fishTTS.id]: fishTTS,
};

export const TTS_PROVIDERS: TTSProvider[] = getImplementedProviders('tts').map(entry => {
  const implementation = TTS_IMPLEMENTATIONS[entry.id];
  if (!implementation) {
    throw new Error(
      `Реестр содержит TTS-провайдера "${entry.id}" без реализации. ` +
        'Добавьте файл провайдера и запись в TTS_IMPLEMENTATIONS (src/lib/providers/tts/catalog.ts).'
    );
  }
  return {
    ...implementation,
    name: entry.name,
    description: entry.description,
    freeTier: entry.freeTier,
    languages: entry.languages ?? implementation.languages,
    experimental: entry.experimental ?? implementation.experimental,
    proxyClientSide: entry.proxyClientSide ?? implementation.proxyClientSide,
    supportsSpeed: entry.supportsSpeed ?? implementation.supportsSpeed,
    defaultModel: entry.defaultModel ?? implementation.defaultModel,
    baseUrl: entry.baseUrl ?? implementation.baseUrl,
  };
});

/** Провайдеры, объявленные в реестре, но не имеющие реализации (диагностика/тесты). */
export function getRegistryOnlyTTSIds(): string[] {
  return getImplementedProviders('tts')
    .map(entry => entry.id)
    .filter(id => !TTS_IMPLEMENTATIONS[id]);
}

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
