/**
 * Ошибка загрузки чанка (`Failed to load chunk … from module …`) — почти всегда
 * признак того, что **вкладка открыта на устаревшей сборке**: после `next build`
 * или деплоя имена файлов меняются (контентный хеш в имени), и старый HTML
 * ссылается на уже несуществующий `/_next/static/chunks/*.js`.
 *
 * В этом случае кнопка «Повторить» (React `reset()`) бесполезна: она
 * перерисовывает тот же документ, а модуль всё равно не загрузится. Помогает
 * только полная перезагрузка страницы — она получит новый HTML с новыми
 * именами чанков.
 *
 * Чтобы не устроить бесконечный цикл (например, файл действительно потерян на
 * сервере), перезагружаемся не чаще раза в `CHUNK_RELOAD_COOLDOWN_MS`; при
 * повторной ошибке показываем экран с кнопкой.
 */

const RELOAD_TIMESTAMP_KEY = 'mvs:chunk-reload-at';

/** Окно анти-цикла: две перезагрузки подряд — уже не «устаревшая вкладка». */
export const CHUNK_RELOAD_COOLDOWN_MS = 15_000;

/**
 * Похоже ли исключение на сбой загрузки чанка.
 *
 * Покрыты формулировки, которые реально встречаются:
 * - Turbopack (Next 16): `Failed to load chunk /_next/static/chunks/x.js from module 64893`;
 * - webpack: `Loading chunk 123 failed` / `ChunkLoadError`;
 * - нативные dynamic import: `Failed to fetch dynamically imported module`,
 *   `Importing a module script failed`, `error loading dynamically imported module`.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (error == null) return false;
  const name = typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : '';
  if (name === 'ChunkLoadError') return true;

  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String((error as { message?: unknown }).message ?? '');
  if (!message) return false;

  return /failed to load chunk|loading chunk [\w-]+ failed|chunkloaderror|failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i
    .test(message);
}

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ChunkReloadDecision {
  /** Нужно ли вызывать `location.reload()`. */
  reload: boolean;
  reason: 'not-chunk-error' | 'cooldown' | 'reload';
}

export interface ChunkReloadDeps {
  now?: () => number;
  /** `null` — хранилище недоступно (Safari private mode, SSR). */
  storage?: MinimalStorage | null;
  cooldownMs?: number;
}

function defaultStorage(): MinimalStorage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * Решение о перезагрузке. Вынесено из компонента, чтобы проверять поведение
 * (таймер/хранилище инъектируются), а не текст в JSX.
 */
export function planChunkReload(error: unknown, deps: ChunkReloadDeps = {}): ChunkReloadDecision {
  if (!isChunkLoadError(error)) return { reload: false, reason: 'not-chunk-error' };

  const now = deps.now ?? Date.now;
  const cooldownMs = deps.cooldownMs ?? CHUNK_RELOAD_COOLDOWN_MS;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;

  if (!storage) return { reload: true, reason: 'reload' };

  let last = 0;
  try {
    last = Number(storage.getItem(RELOAD_TIMESTAMP_KEY) || 0) || 0;
  } catch {
    return { reload: true, reason: 'reload' };
  }

  const elapsed = now() - last;
  if (last > 0 && elapsed >= 0 && elapsed < cooldownMs) {
    return { reload: false, reason: 'cooldown' };
  }

  try {
    storage.setItem(RELOAD_TIMESTAMP_KEY, String(now()));
  } catch {
    // Хранилище только для анти-цикла: не смогли записать — всё равно перезагружаем.
  }
  return { reload: true, reason: 'reload' };
}
