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

import { mustUseProxy } from './cors';
import { getTTSProvider } from './catalog';
import { providerMimeType, resolveAudioMime } from './mime';

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

/**
 * MIME по провайдеру (без анализа байтов). Для уже полученного буфера
 * используйте resolveAudioMime(providerId, buffer) — сигнатура важнее таблицы.
 */
export function mimeTypeForProvider(providerId: string): string {
  return providerMimeType(providerId);
}

/**
 * generateTTS — клиентский путь: он ходит в /api/tts и в браузерные API.
 * На сервере его вызов означал бы рекурсию (сервер → /api/tts → сервер),
 * поэтому падаем сразу и громко, а не после таймаута.
 */
export function assertClientContext(): void {
  // NEXT_RUNTIME намеренно НЕ используется: в клиентском бандле process.env
  // может быть заинлайнено сборщиком, и проверка ложно срабатывала бы в браузере.
  // Признак сервера — отсутствие window: `self` не подходит, потому что его
  // может выставить полифилл (jsdom, globalThis.self = globalThis), и тогда
  // серверная рекурсия прошла бы молча. Воркеров в проекте нет (проверено
  // grep'ом: new Worker/worker_threads не используются).
  if (typeof window === 'undefined') {
    throw new Error(
      'generateTTS() — клиентский путь (обращается к /api/tts). На сервере используйте getServerGenerate(provider) или serverGenerate у провайдера.'
    );
  }
}

export async function generateTTS(req: GenerateTTSRequest): Promise<GenerateTTSResult> {
  assertClientContext();

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
    // undefined, а не '': иначе дефолт `voice = '...'` в сигнатуре не сработает.
    voice: req.voice || undefined,
    language: req.language,
    speed: req.speed,
    model: req.model,
  });

  return { buffer, mimeType: resolveAudioMime(req.providerId, buffer) };
}
