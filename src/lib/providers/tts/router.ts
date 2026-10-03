/**
 * Единая точка генерации TTS на клиенте.
 *
 * Зачем: раньше `generateAudio.ts` звал `ttsProvider.generate(...)` напрямую,
 * и провайдеры, которые режут CORS (elevenlabs, openai, polly, azure, deepgram),
 * на основной кнопке «Озвучить всё» всегда падали, хотя прокси `/api/tts` их умеет.
 *
 * Теперь: CORS-провайдеры идут через `/api/tts`, остальные — прямым fetch.
 * Возвращаем ещё и корректный MIME (gemini/qwen — не mp3).
 */

import { CORS_BLOCKED_PROVIDERS } from './cors';
import { getTTSProvider } from './catalog';
import { resolveAudioMime } from './mime';

export interface GenerateTTSRequest {
  providerId: string;
  text: string;
  apiKey: string;
  voice?: string;
  language?: string;
  speed?: number;
  model?: string;
}

export interface GenerateTTSResult {
  buffer: ArrayBuffer;
  mimeType: string;
}

/** Провайдеры, которые обязаны идти через серверный прокси. */
export function mustUseProxy(providerId: string): boolean {
  if (CORS_BLOCKED_PROVIDERS.has(providerId)) return true;
  // Эти ребята умеют auth/streaming, который стабильнее на сервере,
  // плюс их серверные ветки уже реализованы в /api/tts
  return ['playht', 'resemble', 'murf', 'fish', 'hume', 'speechify', 'polly'].includes(providerId);
}

/**
 * MIME по провайдеру. Реальный тип контейнера может отличаться от ожидаемого,
 * поэтому для уже полученных байтов используйте resolveAudioMime(providerId, buffer).
 */
export function mimeTypeForProvider(providerId: string): string {
  return resolveAudioMime(providerId, new ArrayBuffer(0));
}

export async function generateTTS(req: GenerateTTSRequest): Promise<GenerateTTSResult> {
  if (mustUseProxy(req.providerId)) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: req.providerId,
        text: req.text,
        voice: req.voice,
        apiKey: req.apiKey,
        language: req.language,
        speed: req.speed,
        model: req.model,
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`${req.providerId} proxy error: ${res.status} — ${err.slice(0, 500)}`);
    }

    const buffer = await res.arrayBuffer();
    // Сигнатура важнее заголовка: провайдеры отдают не то, что просили
    return { buffer, mimeType: resolveAudioMime(req.providerId, buffer) };
  }

  const provider = getTTSProvider(req.providerId);
  if (!provider) throw new Error(`TTS provider ${req.providerId} not found`);

  const buffer = await provider.generate(req.text, {
    apiKey: req.apiKey,
    voice: req.voice || '',
    language: req.language,
    speed: req.speed,
    model: req.model,
  });

  return { buffer, mimeType: resolveAudioMime(req.providerId, buffer) };
}
