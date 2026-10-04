/**
 * Shared CORS logic — must stay in sync with /api/tts/route.ts implemented providers
 * /api/tts implements: elevenlabs, openai, gemini, polly, azure, google-cloud, cartesia, deepgram, qwen
 * These 5 are known to block CORS and need proxy:
 */
export const CORS_BLOCKED_PROVIDERS = new Set([
  'elevenlabs',
  'openai',
  'polly',
  'azure',
  'deepgram',
]);

/**
 * Провайдеры без рабочей клиентской реализации: их синтез выполняется на
 * сервере (/api/tts). Это политика «откуда звать», а не «кто блокирует CORS».
 */
export const CLIENT_PROXY_PROVIDERS = new Set(['playht', 'resemble', 'murf', 'fish', 'hume', 'speechify']);

export function isCorsBlocked(providerId: string): boolean {
  return CORS_BLOCKED_PROVIDERS.has(providerId);
}

/**
 * Единая политика проксирования: один источник правды и для клиентского
 * router.ts, и для серверного route.ts. Раньше список жил в router.ts, а
 * серверный guard — отдельным Set'ом с «известным плохим» провайдером.
 */
export function mustUseProxy(providerId: string): boolean {
  return CORS_BLOCKED_PROVIDERS.has(providerId) || CLIENT_PROXY_PROVIDERS.has(providerId);
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
