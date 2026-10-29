/**
 * Ошибки провайдеров: превращение ответов API в actionable-сообщения и в
 * HTTP-статусы маршрута.
 *
 * Вынесено отдельным модулем, чтобы не было цикла импортов:
 * `catalog` → `polly` → `proxy-client` → `errors` (лист без зависимостей от
 * каталога). Пока маппинг жил в `router.ts` (а тот импортирует каталог),
 * `polly` замыкал цикл catalog → polly → router → catalog.
 */

import { ProviderHttpError } from '../http';

export interface TTSProviderErrorInput {
  providerId: string;
  status: number;
  responseBody: string;
  model?: string;
}

/**
 * Человекочитаемые имена для сообщений. Список полный (все 15 провайдеров):
 * раньше отсутствующие имена давали «azure proxy error» со строчной буквы.
 */
const providerNames: Record<string, string> = {
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  gemini: 'Gemini',
  deepgram: 'Deepgram',
  cartesia: 'Cartesia',
  polly: 'Polly',
  azure: 'Azure TTS',
  'google-cloud': 'Google Cloud TTS',
  qwen: 'Qwen TTS',
  playht: 'PlayHT',
  resemble: 'Resemble',
  murf: 'Murf',
  fish: 'Fish Audio',
  hume: 'Hume',
  speechify: 'Speechify',
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

export function getHttpErrorDetails(error: unknown): { status: number; responseBody: string } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:error|failed):\s*(\d{3})\s*[—-]\s*([\s\S]*)$/i);
  if (!match) return null;
  return { status: Number(match[1]), responseBody: match[2] };
}

/**
 * Единое описание сбоя провайдера: и для ответа /api/tts, и для клиентской
 * ошибки. Возвращает actionable-сообщение (подсказки mapTTSProviderError) и
 * HTTP-статус, который маршрут отдаст наружу.
 *
 * Таймаут → 504, сетевой сбой → 502: это ошибки шлюза, а не клиента, и клиент
 * по ним вправе сделать повтор. Отмена → 499 (как в nginx), чтобы UI показал
 * «экспорт отменён», а не «провайдер сломался».
 */
export function describeProviderFailure(
  providerId: string,
  error: unknown,
  options: { model?: string } = {}
): { message: string; status: number } {
  if (error instanceof ProviderHttpError) {
    if (error.code === 'http') {
      return {
        message: mapTTSProviderError({
          providerId,
          status: error.status ?? 502,
          responseBody: error.body,
          model: options.model,
        }),
        status: error.status ?? 502,
      };
    }
    if (error.code === 'timeout') return { message: error.message, status: 504 };
    if (error.code === 'aborted') return { message: error.message, status: 499 };
    if (error.code === 'blocked') return { message: error.message, status: 400 };
    return { message: error.message, status: 502 };
  }

  // Провайдеры, которые сами формируют сообщение в историческом формате
  // «<Label> error: <status> — <body>» (Cartesia, Gemini, Deepgram, …).
  const details = getHttpErrorDetails(error);
  if (details) {
    return {
      message: mapTTSProviderError({
        providerId,
        status: details.status,
        responseBody: details.responseBody,
        model: options.model,
      }),
      status: details.status,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (providerId === 'gemini' && /no audio data|no audio/i.test(message)) {
    return {
      message: mapTTSProviderError({ providerId, status: 500, responseBody: message, model: options.model }),
      status: 500,
    };
  }
  return { message: message || 'Internal error', status: 500 };
}
