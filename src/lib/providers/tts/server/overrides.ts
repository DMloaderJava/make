/**
 * Серверные переопределения TTS-провайдеров.
 *
 * Контракт: маршрут `/api/tts` больше не содержит `switch` по провайдерам.
 * Он берёт реализацию так:
 *
 *   1. запись в этой карте (только те, кому на сервере нужен код, отличный
 *      от клиентского `generate()` — сейчас это один Polly с SigV4 через SDK);
 *   2. `getServerGenerate(provider)` из каталога — то есть `serverGenerate`
 *      или обычная `generate()`, если провайдер не помечен `proxyClientSide`;
 *   3. иначе — честный 501 (`no_server_generate`), без молчаливой рекурсии
 *      «сервер → /api/tts → сервер».
 *
 * Добавление нового провайдера, которому нужен серверный код: файл в этой
 * папке + одна строка в карте. Правок в маршруте не требуется.
 */

import type { TTSOptions } from '../types';
import { generatePollyViaSdk } from './polly';

export type ServerGenerate = (text: string, options: TTSOptions) => Promise<ArrayBuffer>;

export const SERVER_GENERATE_OVERRIDES: Record<string, ServerGenerate> = {
  // Polly: подпись SigV4 и опциональный AWS SDK — только на сервере.
  polly: generatePollyViaSdk,
};

export function getServerOverride(providerId: string): ServerGenerate | null {
  return SERVER_GENERATE_OVERRIDES[providerId] ?? null;
}
