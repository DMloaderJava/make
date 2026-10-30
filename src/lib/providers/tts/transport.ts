/**
 * Тонкая обёртка над `providerFetch` для TTS-провайдеров.
 *
 * Зачем отдельный модуль: у всех провайдеров одинаковые требования к транспорту
 * (таймаут на попытку, общий бюджет маршрута, отмена), и раньше каждый файл
 * повторял их по-своему — а чаще не повторял вовсе. Здесь одно место, где
 * заданы значения по умолчанию.
 *
 * Провайдер по-прежнему владеет телом и заголовками запроса: транспорт ничего
 * не знает про протоколы, только про сеть.
 */

import { providerFetch, type FetchPolicy } from '../http';
import type { TTSOptions } from './types';

/**
 * Таймаут одной попытки. Меньше платформенного `maxDuration = 60`, чтобы
 * успеть сделать повтор и вернуть осмысленную ошибку, а не быть убитым.
 */
const TTS_ATTEMPT_TIMEOUT_MS = 25_000;

/** Бюджет всего запроса (включая паузы между попытками) — с запасом под maxDuration. */
export const TTS_REQUEST_BUDGET_MS = 50_000;

export function ttsFetch(
  providerId: string,
  label: string,
  url: string,
  init: RequestInit,
  options: TTSOptions,
  policy: FetchPolicy = {}
): Promise<Response> {
  return providerFetch(providerId, url, init, {
    label,
    timeoutMs: TTS_ATTEMPT_TIMEOUT_MS,
    deadlineMs: options.deadlineMs ?? TTS_REQUEST_BUDGET_MS,
    signal: options.signal,
    ...policy,
  });
}
