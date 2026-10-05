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

interface TTSProviderErrorInput {
  providerId: string;
  status: number;
  responseBody: string;
  model?: string;
}

const providerNames: Record<string, string> = {
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepgram: 'Deepgram',
  cartesia: 'Cartesia',
  polly: 'Polly',
};

function parseJsonString(value: string): unknown {
  const candidates = [value.trim()];
  // Прокси иногда оборачивает исходный JSON в строку вида
  // `ElevenLabs error: {"detail": ...}`. Попробуем разобрать вложенный объект.
  const objectStart = value.indexOf('{');
  const arrayStart = value.indexOf('[');
  const start = [objectStart, arrayStart].filter(index => index >= 0).sort((a, b) => a - b)[0];
  if (start !== undefined && start > 0) candidates.push(value.slice(start).trim());

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return undefined;
}

function collectErrorText(value: unknown, depth = 0): string[] {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') {
    const nested = parseJsonString(value);
    return nested === undefined ? [value] : [value, ...collectErrorText(nested, depth + 1)];
  }
  if (Array.isArray(value)) return value.flatMap(item => collectErrorText(item, depth + 1));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(item => collectErrorText(item, depth + 1));
  }
  return [String(value)];
}

function findErrorMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value == null) return undefined;
  if (typeof value === 'string') {
    const nested = parseJsonString(value);
    return nested === undefined ? value.trim() || undefined : findErrorMessage(nested, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = findErrorMessage(item, depth + 1);
      if (message) return message;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'detail', 'error_description', 'error', 'status', 'code']) {
      if (!(key in record)) continue;
      const message = findErrorMessage(record[key], depth + 1);
      if (message) return message;
    }
  }
  return undefined;
}

/** Превращает распространённые ответы TTS API в подсказки для пользователя. */
export function mapTTSProviderError({ providerId, status, responseBody, model }: TTSProviderErrorInput): string {
  const label = providerNames[providerId] || providerId;
  const payload = parseJsonString(responseBody);
  const searchable = [responseBody, ...collectErrorText(payload)].join(' ').toLowerCase();
  let actionableMessage: string | undefined;

  if (providerId === 'elevenlabs' && ((status === 401 && searchable.includes('missing_permissions')) || status === 403)) {
    actionableMessage = 'Ключ ElevenLabs не имеет права text_to_speech. Откройте кабинет → API Keys → Edit → Scopes и включите Text to Speech.';
  } else if (providerId === 'openai' && status === 401) {
    actionableMessage = 'Неверный API-ключ OpenAI.';
  } else if (providerId === 'openai' && status === 429) {
    actionableMessage = 'Превышен лимит запросов OpenAI. Подождите или проверьте квоту.';
  } else if (providerId === 'gemini' && status === 404) {
    const modelName = responseBody.match(/(?:models\/)?(gemini-[a-z0-9._-]+)/i)?.[1] || model || 'запрошенная модель';
    actionableMessage = `Модель ${modelName} не найдена. Проверьте доступные TTS-модели: gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts, gemini-3.1-flash-tts-preview.`;
  } else if (providerId === 'gemini' && status === 422 && /no audio|audio data|text instead|text output/i.test(searchable)) {
    actionableMessage = 'Gemini TTS вернул успешный ответ без аудиоданных. Проверьте выбранную модель или попробуйте ещё раз.';
  } else if (providerId === 'gemini' && status === 500 && /no audio|audio data|text instead|text output/i.test(searchable)) {
    // Обратная совместимость с уже запущенными прокси старых версий.
    actionableMessage = 'Gemini вернул текст вместо аудио. Попробуйте ещё раз — это transient-ошибка.';
  } else if (providerId === 'deepgram' && (status === 401 || status === 403)) {
    actionableMessage = 'Ключ Deepgram недействителен или не имеет доступа к TTS. Проверьте ключ и права в консоли Deepgram.';
  } else if (providerId === 'deepgram' && status === 402) {
    actionableMessage = 'У Deepgram закончились доступные кредиты. Проверьте баланс или смените провайдера.';
  } else if (providerId === 'deepgram' && (status === 400 || status === 422)) {
    actionableMessage = 'Deepgram отклонил запрос. Проверьте модель и голос: Flux поддерживает английский, Aura-2 — English, Spanish, German, French, Dutch, Italian и Japanese.';
  } else if (providerId === 'deepgram' && status === 429) {
    actionableMessage = 'Превышен лимит запросов Deepgram. Подождите перед повторной генерацией.';
  } else if (providerId === 'deepgram' && status >= 500) {
    actionableMessage = 'Deepgram временно недоступен. Попробуйте повторить запрос позже.';
  } else if (providerId === 'cartesia' && status === 400) {
    actionableMessage = 'Cartesia отверг запрос. Проверьте версию API: 2026-03-01.';
  } else if (providerId === 'polly' && /aws sdk not installed|cannot find module.*client-polly|can't resolve.*client-polly/i.test(searchable)) {
    actionableMessage = 'Установите @aws-sdk/client-polly: npm install @aws-sdk/client-polly --no-save --no-audit --no-fund.';
  }

  if (actionableMessage) return `${label} ${status} — ${actionableMessage}`;

  const detail = findErrorMessage(payload) || responseBody.trim() || 'неизвестная ошибка';
  return `${label} proxy error: ${status} — ${detail.slice(0, 500)}`;
}

function getHttpErrorDetails(error: unknown): { status: number; responseBody: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:error|failed):\s*(\d{3})\s*[—-]\s*([\s\S]*)$/i);
  if (!match) return null;
  return { status: Number(match[1]), responseBody: match[2] };
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
      const responseBody = await res.text().catch(() => res.statusText);
      throw new Error(mapTTSProviderError({
        providerId: req.providerId,
        status: res.status,
        responseBody,
        model: req.model,
      }));
    }

    const buffer = await res.arrayBuffer();
    // Сигнатура важнее заголовка: провайдеры отдают не то, что просили
    return { buffer, mimeType: resolveAudioMime(req.providerId, buffer) };
  }

  const provider = getTTSProvider(req.providerId);
  if (!provider) throw new Error(`TTS provider ${req.providerId} not found`);

  let buffer: ArrayBuffer;
  try {
    buffer = await provider.generate(req.text, {
      apiKey: req.apiKey,
      // undefined, а не '': иначе дефолт `voice = '...'` в сигнатуре не сработает.
      voice: req.voice || undefined,
      language: req.language,
      speed: req.speed,
      model: req.model,
    });
  } catch (error) {
    const httpError = getHttpErrorDetails(error);
    if (httpError) {
      throw new Error(mapTTSProviderError({
        providerId: req.providerId,
        status: httpError.status,
        responseBody: httpError.responseBody,
        model: req.model,
      }));
    }
    const message = error instanceof Error ? error.message : String(error);
    if (req.providerId === 'gemini' && /no audio data|no audio/i.test(message)) {
      throw new Error(mapTTSProviderError({
        providerId: req.providerId,
        status: 500,
        responseBody: message,
        model: req.model,
      }));
    }
    throw error;
  }

  return { buffer, mimeType: resolveAudioMime(req.providerId, buffer) };
}
