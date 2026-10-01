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

export function isCorsBlocked(providerId: string): boolean {
  return CORS_BLOCKED_PROVIDERS.has(providerId);
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
