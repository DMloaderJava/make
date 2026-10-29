/**
 * Единый транспорт для запросов к внешним API провайдеров.
 *
 * Зачем: до этого каждый провайдер вызывал `fetch` напрямую и сам придумывал,
 * что делать с ошибкой, — отсюда три проблемы:
 *   1. нигде не было таймаута: зависший апстрим держал воркер до платформенного
 *      лимита (`maxDuration = 60`), а пользователь видел вечную загрузку;
 *   2. не было повторов на 429/503, хотя почти все провайдеры их отдают;
 *   3. каждая реализация форматировала сообщение по-своему, и `mapTTSProviderError`
 *      угадывал статус регуляркой по тексту.
 *
 * Теперь провайдер описывает только запрос, а таймаут, ретраи с экспоненциальной
 * паузой (с учётом `Retry-After`), классификация ошибок и формат сообщения —
 * здесь, в одном месте.
 *
 * Сообщение об ошибке намеренно сохраняет исторический формат
 * ``"<Label> error: <status> — <body>"``: `mapTTSProviderError` и
 * `getHttpErrorDetails` разбирают именно его, и менять контракт одновременно
 * с транспортом — верный способ сломать подсказки пользователю.
 */

export type ProviderErrorCode = 'http' | 'timeout' | 'network' | 'aborted' | 'blocked';

export interface ProviderHttpErrorInfo {
  providerId: string;
  label?: string;
  code: ProviderErrorCode;
  /** Есть только при code === 'http'. */
  status?: number;
  /** Тело ответа (обрезано) или текст транспортной ошибки. */
  body?: string;
  /** Номер попытки, на которой сдались (1 = без повторов). */
  attempts: number;
  /** Сколько ждали по Retry-After, мс. */
  retryAfterMs?: number;
  cause?: unknown;
}

const MAX_BODY_IN_MESSAGE = 500;

function truncate(text: string, limit = MAX_BODY_IN_MESSAGE): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export class ProviderHttpError extends Error {
  readonly providerId: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly body: string;
  readonly attempts: number;
  readonly retryAfterMs?: number;

  constructor(info: ProviderHttpErrorInfo) {
    super(formatProviderError(info));
    this.name = 'ProviderHttpError';
    this.providerId = info.providerId;
    this.code = info.code;
    this.status = info.status;
    this.body = info.body ?? '';
    this.attempts = info.attempts;
    this.retryAfterMs = info.retryAfterMs;
  }
}

function formatProviderError(info: ProviderHttpErrorInfo): string {
  const label = info.label || info.providerId;
  const attemptsNote = info.attempts > 1 ? ` (попыток: ${info.attempts})` : '';
  switch (info.code) {
    case 'http':
      return `${label} error: ${info.status} — ${truncate(info.body ?? '')}`;
    case 'timeout':
      return `${label} timeout: провайдер не ответил вовремя${attemptsNote} — проверьте сеть или повторите позже`;
    case 'network':
      return `${label} network error: ${truncate(info.body ?? 'сеть недоступна')}${attemptsNote}`;
    case 'aborted':
      return `${label}: запрос отменён`;
    case 'blocked':
      return `${label} blocked: ${truncate(info.body ?? 'недопустимый адрес')}`;
  }
}

export interface FetchPolicy {
  /** Имя провайдера для сообщений; по умолчанию `providerId`. */
  label?: string;
  /** Таймаут одной попытки, мс. По умолчанию 30 с. */
  timeoutMs?: number;
  /** Количество повторов (не попыток). По умолчанию 2 → всего 3 попытки. */
  retries?: number;
  /** База экспоненциальной паузы, мс. По умолчанию 400. */
  retryBaseMs?: number;
  /** Потолок паузы, мс (включая Retry-After). По умолчанию 8 с. */
  retryMaxDelayMs?: number;
  /** Статусы, которые имеет смысл повторять. */
  retryStatuses?: readonly number[];
  /**
   * Общий бюджет запроса в миллисекундах, включая паузы между попытками.
   * Нужен, потому что 3 попытки по 30 с не влезают в `maxDuration` маршрута:
   * без бюджета платформа убивает воркер раньше, чем мы вернём понятную ошибку.
   */
  deadlineMs?: number;
  /**
   * false — вернуть не-2xx Response вызывающему вместо исключения.
   * Нужно там, где ответ анализируют (деградация `response_format` в LLM).
   * Таймаут и повторы при этом работают как обычно.
   */
  throwOnHttpError?: boolean;
  /** Внешняя отмена (например, AbortController экспорта). */
  signal?: AbortSignal;
  /** Подмена sleep в тестах. */
  sleep?: (ms: number) => Promise<void>;
  /** Подмена генератора джиттера в тестах (0..1). */
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;
const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 425, 429, 500, 502, 503, 504];

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Разбирает `Retry-After` (секунды или HTTP-дата). Возвращает мс или null. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Пауза перед повтором: `Retry-After` важнее экспоненты, джиттер — чтобы не бить синхронно. */
export function computeRetryDelay(
  attempt: number,
  retryAfterMs: number | null,
  policy: Pick<FetchPolicy, 'retryBaseMs' | 'retryMaxDelayMs' | 'random'> = {}
): number {
  const base = policy.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const max = policy.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const random = policy.random ?? Math.random;
  const jittered = base * 2 ** (attempt - 1) * (0.5 + random() * 0.5);
  const chosen = retryAfterMs !== null ? retryAfterMs : jittered;
  return Math.min(max, Math.max(0, Math.round(chosen)));
}

interface SingleAttemptResult {
  response: Response;
  timeoutMs: number;
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<SingleAttemptResult> {
  // Сигнал мог быть отменён до запроса (пользователь закрыл экспорт): не начинаем
  // попытку вовсе, иначе получим сетевую ошибку вместо «отменено».
  if (signal?.aborted) {
    throw new ProviderHttpError({ providerId: '__transport__', code: 'aborted', attempts: 1 });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, timeoutMs };
  } catch (error) {
    // Отличаем таймаут от отмены вызывающим и от сетевого сбоя: от этого зависит
    // и код ошибки, и нужен ли повтор.
    if (signal?.aborted) {
      throw new ProviderHttpError({ providerId: '__transport__', code: 'aborted', attempts: 1, cause: error });
    }
    if (timedOut) {
      throw new ProviderHttpError({ providerId: '__transport__', code: 'timeout', attempts: 1, cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderHttpError({ providerId: '__transport__', code: 'network', body: message, attempts: 1, cause: error });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readErrorBody(response: Response): Promise<string> {
  // В error.body храним тело целиком: вызывающий может его разобрать (JSON со
  // списком голосов, причиной отказа схемы). Обрезка — только в сообщении.
  try {
    return await response.text();
  } catch {
    return response.statusText || '';
  }
}

/**
 * Запрос к API провайдера: таймаут на попытку, повторы на 429/5xx и таймауты,
 * единый формат ошибки. Возвращает `Response` — тело читает вызывающий.
 */
export async function providerFetch(
  providerId: string,
  url: string,
  init: RequestInit = {},
  policy: FetchPolicy = {}
): Promise<Response> {
  const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attemptsTotal = Math.max(1, (policy.retries ?? DEFAULT_RETRIES) + 1);
  const retryStatuses = new Set(policy.retryStatuses ?? DEFAULT_RETRY_STATUSES);
  const sleep = policy.sleep ?? realSleep;
  const throwOnHttpError = policy.throwOnHttpError !== false;
  const startedAt = Date.now();
  const remainingMs = () =>
    policy.deadlineMs === undefined ? Number.POSITIVE_INFINITY : policy.deadlineMs - (Date.now() - startedAt);

  const wrap = (source: ProviderHttpError, attempt: number) =>
    new ProviderHttpError({
      providerId,
      label: policy.label,
      code: source.code,
      status: source.status,
      body: source.body,
      attempts: attempt,
      retryAfterMs: source.retryAfterMs,
      cause: source,
    });

  const budgetError = (attempts: number) =>
    new ProviderHttpError({
      providerId,
      label: policy.label,
      code: 'timeout',
      body: `истёк бюджет запроса (${policy.deadlineMs} мс)`,
      attempts,
    });

  for (let attempt = 1; ; attempt++) {
    const budget = remainingMs();
    if (budget <= 0) throw budgetError(attempt - 1);

    let response: Response;
    try {
      ({ response } = await fetchOnce(url, init, Math.min(timeoutMs, budget), policy.signal));
    } catch (error) {
      const transport = error as ProviderHttpError;
      // Отмену вызывающим не повторяем: пользователь уже отказался от запроса.
      const retryable =
        (transport.code === 'timeout' || transport.code === 'network') && attempt < attemptsTotal;
      if (!retryable) throw wrap(transport, attempt);

      const delay = computeRetryDelay(attempt, null, policy);
      if (remainingMs() <= delay) throw wrap(transport, attempt);
      await sleep(delay);
      continue;
    }

    if (response.ok) return response;

    // Клон нужен для режима throwOnHttpError=false: тело читаем для ошибки,
    // а вызывающему отдаём исходный ответ (статус, заголовки, байты).
    const passthrough = throwOnHttpError ? null : response.clone();
    const body = await readErrorBody(response);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const error = new ProviderHttpError({
      providerId,
      label: policy.label,
      code: 'http',
      status: response.status,
      body,
      attempts: attempt,
      retryAfterMs: retryAfterMs ?? undefined,
    });

    // throwOnHttpError влияет только на то, что вернём/бросим после последней
    // попытки. Повтор на 429/5xx нужен в обоих режимах: иначе LLM-деградация
    // response_format молча теряла бы все повторы.
    if (retryStatuses.has(response.status) && attempt < attemptsTotal) {
      const delay = computeRetryDelay(attempt, retryAfterMs, policy);
      if (remainingMs() > delay) {
        await sleep(delay);
        continue;
      }
    }

    if (passthrough) return passthrough;
    throw error;
  }
}

/** HTTP-статус, которым маршрут отвечает на сбой транспорта. */
export function providerFailureStatus(error: unknown): number {
  if (error instanceof ProviderHttpError) {
    switch (error.code) {
      case 'http':
        return error.status ?? 502;
      case 'timeout':
        return 504;
      case 'aborted':
        return 499;
      case 'blocked':
        return 400;
      case 'network':
        return 502;
    }
  }
  return 500;
}

/** Машинный код сбоя для JSON-ответа маршрута (UI не парсит текст ошибки). */
export function providerFailureCode(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    switch (error.code) {
      case 'timeout':
        return 'provider_timeout';
      case 'network':
        return 'provider_network';
      case 'aborted':
        return 'aborted';
      case 'blocked':
        return 'blocked_target';
      case 'http':
        return 'provider_http_error';
    }
  }
  return 'internal_error';
}

/** Метаданные-эндпоинты облаков: единственный адрес, у которого нет легального применения. */
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function isLinkLocal(hostname: string): boolean {
  return /^169\.254\./.test(hostname);
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (hostname === '::1' || hostname.startsWith('[::1]')) return true;
  return false;
}

export interface TargetGuardOptions {
  /**
   * Разрешать loopback и приватные сети. По умолчанию true: приложение
   * self-hosted и официально поддерживает локальные LLM (Ollama/LM Studio)
   * через /api/llm. Для публичного инстанса включайте MVS_BLOCK_PRIVATE_PROVIDERS=1.
   */
  allowPrivate?: boolean;
}

/**
 * Проверяет адрес, который пришёл от пользователя (baseUrl custom-провайдера).
 *
 * Всегда запрещены: не-http(s) схемы, креденшелы в URL и metadata-эндпоинты
 * облаков (169.254.169.254 и родственники) — это чистый SSRF без легального
 * сценария. Приватные диапазоны по умолчанию разрешены ради локальных LLM.
 */
export function assertProviderTarget(raw: string, options: TargetGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderHttpError({
      providerId: 'custom',
      code: 'blocked',
      body: `некорректный URL провайдера: ${truncate(raw, 200)}`,
      attempts: 1,
    });
  }

  const blocked = (reason: string) =>
    new ProviderHttpError({ providerId: 'custom', code: 'blocked', body: `${reason}: ${url.origin}`, attempts: 1 });

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw blocked(`разрешены только http/https, получено ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw blocked('креденшелы в URL не поддерживаются — передавайте API-ключ в поле ключа');
  }

  const hostname = url.hostname.toLowerCase();
  if (METADATA_HOSTS.has(hostname) || isLinkLocal(hostname)) {
    throw blocked('адрес облачных метаданных запрещён');
  }

  const allowPrivate = options.allowPrivate
    ?? process.env.MVS_BLOCK_PRIVATE_PROVIDERS !== '1';
  if (!allowPrivate && isPrivateHost(hostname)) {
    throw blocked('приватные адреса запрещены (MVS_BLOCK_PRIVATE_PROVIDERS=1)');
  }

  return url;
}
