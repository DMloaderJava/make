/**
 * Централизованный реестр URL.createObjectURL + URL.revokeObjectURL
 * (Этап 3, пункты 29, 30).
 *
 * Предотвращает утечки памяти и лишнее пересоздание blob URL при seek внутри
 * одного клипа: если для того же ключа или Blob уже выдан живой URL, он
 * переиспользуется, а при смене клипа или закрытии плеера все URL гарантированно
 * освобождаются через revokeObjectURL.
 */

export interface ObjectUrlEntry {
  url: string;
  key: string;
  blob: Blob;
  createdAt: number;
  refCount: number;
}

export interface ObjectUrlStats {
  created: number;
  revoked: number;
  reused: number;
  active: number;
}

export class ObjectUrlRegistry {
  private byUrl = new Map<string, ObjectUrlEntry>();
  private byKey = new Map<string, ObjectUrlEntry>();
  private createdCount = 0;
  private revokedCount = 0;
  private reusedCount = 0;
  private createFn: (blob: Blob) => string;
  private revokeFn: (url: string) => void;

  constructor(hooks?: {
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
  }) {
    this.createFn = hooks?.createObjectURL ?? ((blob: Blob) => {
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        return URL.createObjectURL(blob);
      }
      return `blob:mock-${++this.createdCount}`;
    });
    this.revokeFn = hooks?.revokeObjectURL ?? ((url: string) => {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(url);
      }
    });
  }

  /**
   * Получает или переиспользует ObjectURL для пары (key, blob).
   * Если по `key` уже есть тот же самый `blob`, возвращает существующий URL без пересоздания.
   * Если по `key` лежал старый `blob`, автоматически отзывает старый URL.
   */
  acquire(key: string, blob: Blob): { url: string; reused: boolean } {
    const existing = this.byKey.get(key);
    if (existing && existing.blob === blob) {
      existing.refCount += 1;
      this.reusedCount += 1;
      return { url: existing.url, reused: true };
    }

    if (existing) {
      this.revokeByKey(key);
    }

    const url = this.createFn(blob);
    this.createdCount += 1;
    const entry: ObjectUrlEntry = {
      url,
      key,
      blob,
      createdAt: Date.now(),
      refCount: 1,
    };
    this.byUrl.set(url, entry);
    this.byKey.set(key, entry);
    return { url, reused: false };
  }

  /**
   * Уменьшает счётчик ссылок или полностью отзывает URL (P1 п. 4: force = false по умолчанию).
   */
  release(url: string, force = false): boolean {
    const entry = this.byUrl.get(url);
    if (!entry) return false;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (!force && entry.refCount > 0) return false;

    this.byUrl.delete(url);
    if (this.byKey.get(entry.key)?.url === url) {
      this.byKey.delete(entry.key);
    }
    try {
      this.revokeFn(url);
    } catch {}
    this.revokedCount += 1;
    return true;
  }

  /**
   * Отзывает URL по логическому ключу слота ('intro', 'panel:1', и т.д.).
   */
  revokeByKey(key: string): boolean {
    const entry = this.byKey.get(key);
    if (!entry) return false;
    return this.release(entry.url, true);
  }

  /**
   * Отзывает все активные ObjectURL (например, при размонтировании редактора).
   */
  revokeAll(): number {
    const urls = [...this.byUrl.keys()];
    for (const url of urls) {
      this.release(url, true);
    }
    return urls.length;
  }

  getActiveCount(): number {
    return this.byUrl.size;
  }

  getActiveUrls(): string[] {
    return [...this.byUrl.keys()];
  }

  hasKey(key: string): boolean {
    return this.byKey.has(key);
  }

  getStats(): ObjectUrlStats {
    return {
      created: this.createdCount,
      revoked: this.revokedCount,
      reused: this.reusedCount,
      active: this.byUrl.size,
    };
  }
}

/** Глобальный реестр по умолчанию для сессии редактора. */
export const sharedObjectUrlRegistry = new ObjectUrlRegistry();
