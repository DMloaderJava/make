/**
 * Клиентский запрос к собственному прокси `/api/tts`.
 *
 * Отдельный модуль (а не часть `router.ts`), чтобы не возникало цикла
 * catalog → polly → router → catalog: здесь только транспорт и маппинг ошибок,
 * зависимостей от каталога провайдеров нет.
 *
 * Зачем таймаут: без него закрытый/зависший сервер оставлял UI в «генерация…»
 * навсегда — браузерный `fetch` сам по себе не сдаётся.
 */

import { mapTTSProviderError } from './errors';

/**
 * Сколько клиент ждёт ответа /api/tts. Чуть больше серверного бюджета (50 с):
 * сервер успевает вернуть свою 504/500 раньше, чем браузер сдастся сам.
 */
const CLIENT_PROXY_TIMEOUT_MS = 55_000;

/** Тело запроса к прокси. Одно на все провайдеры — маршрут общий. */
export interface TTSProxyPayload {
  providerId: string;
  text: string;
  apiKey: string;
  voice?: string;
  language?: string;
  speed?: number;
  model?: string;
}

/**
 * Запрос к /api/tts (браузер → собственный сервер) с таймаутом и единым
 * разбором ошибки. Раньше этот блок был скопирован в router.ts и в polly.ts,
 * и в polly ошибка прокси превращалась в «нужны AWS-ключи».
 */
export async function requestTTSProxy(payload: TTSProxyPayload): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_PROXY_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Прокси TTS не ответил за ${CLIENT_PROXY_TIMEOUT_MS / 1000} с — проверьте соединение и повторите.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const responseBody = await res.text().catch(() => res.statusText);
    throw new Error(mapTTSProviderError({
      providerId: payload.providerId,
      status: res.status,
      responseBody,
      model: payload.model,
    }));
  }

  return res.arrayBuffer();
}
