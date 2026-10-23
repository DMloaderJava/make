/**
 * Политика проксирования TTS — проекция единого реестра.
 *
 * Реестр (`../registry.ts`) хранит для каждого TTS-провайдера `cors`:
 * - `direct` — браузер может звать API напрямую (CORS разрешён);
 * - `proxy`  — нужен серверный `/api/tts`.
 *
 * Раньше здесь было два руками поддерживаемых списка (`CORS_BLOCKED_PROVIDERS`
 * и `CLIENT_PROXY_PROVIDERS`), которые надо было синхронизировать с каталогом
 * и с `route.ts`. Теперь источник один, а наборы ниже — совместимые проекции
 * для UI (`VoicesModal`).
 */

import { getProxiedTTSProviderIds, getRegistryByKind } from '../registry';

/**
 * Провайдеры, которые блокируют CORS (браузер не может звать напрямую).
 * Экспериментальные сюда не входят: у них другая причина проксирования
 * (нет рабочей клиентской реализации), хотя политика та же — `proxy`.
 */
export const CORS_BLOCKED_PROVIDERS = new Set(
  getRegistryByKind('tts')
    .filter(entry => entry.cors === 'proxy' && !entry.experimental)
    .map(entry => entry.id)
);

/**
 * Провайдеры без рабочей клиентской реализации: синтез выполняется на сервере
 * (/api/tts). Это политика «откуда звать», а не «кто блокирует CORS».
 */
export const CLIENT_PROXY_PROVIDERS = new Set(
  getRegistryByKind('tts')
    .filter(entry => entry.cors === 'proxy' && entry.experimental)
    .map(entry => entry.id)
);

export function isCorsBlocked(providerId: string): boolean {
  return CORS_BLOCKED_PROVIDERS.has(providerId);
}

/**
 * Единая политика проксирования: один источник правды и для клиентского
 * router.ts, и для серверного route.ts.
 */
export function mustUseProxy(providerId: string): boolean {
  return getProxiedTTSProviderIds().includes(providerId);
}

export function getAudioMimeType(providerId: string, blobType?: string): string {
  if (blobType && blobType.startsWith('audio/')) {
    // Fixup: server may return generic, but we know correct
    if (providerId === 'gemini' || providerId === 'qwen') {
      if (blobType === 'audio/mpeg') return 'audio/wav';
    }
    return blobType;
  }
  if (providerId === 'gemini') return 'audio/wav';
  if (providerId === 'qwen') return 'audio/wav';
  return 'audio/mpeg';
}
