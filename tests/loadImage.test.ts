import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isImageDrawable, loadImageElement } from '../src/lib/pipeline/loadImage';

/**
 * Загрузчик страниц: длинные webtoon-полосы декодируются дольше обычных
 * картинок, поэтому он обязан дожидаться настоящего load (а не таймаута,
 * после которого превью/экспорт рисовали пустой кадр).
 */

function installFakeImage(options: { behavior: 'load' | 'error' | 'never'; width?: number; height?: number }) {
  const original = (globalThis as unknown as { Image?: unknown }).Image;

  class ImageFake {
    crossOrigin?: string;
    complete = false;
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    #src = '';
    #listeners: Record<string, Array<() => void>> = {};

    addEventListener(type: string, listener: () => void) {
      (this.#listeners[type] ||= []).push(listener);
    }

    emit(type: 'load' | 'error') {
      if (type === 'load') {
        this.complete = true;
        this.naturalWidth = options.width ?? 900;
        this.naturalHeight = options.height ?? 12540;
        this.onload?.();
      } else {
        this.onerror?.();
      }
      for (const listener of this.#listeners[type] ?? []) listener();
    }

    // Как у настоящего <img>: присваивание src запускает асинхронную загрузку.
    set src(value: string) {
      this.#src = value;
      if (options.behavior === 'load') setTimeout(() => this.emit('load'), 5);
      else if (options.behavior === 'error') setTimeout(() => this.emit('error'), 5);
    }
    get src() {
      return this.#src;
    }
  }

  (globalThis as unknown as { Image: unknown }).Image = ImageFake;
  return {
    restore: () => {
      if (original === undefined) delete (globalThis as unknown as { Image?: unknown }).Image;
      else (globalThis as unknown as { Image: unknown }).Image = original;
    },
  };
}

test('loadImageElement: ждёт настоящий load длинной полосы и отдаёт размеры', async () => {
  const fake = installFakeImage({ behavior: 'load', width: 900, height: 12540 });
  try {
    const img = await loadImageElement('data:image/jpeg;base64,long-strip');
    assert.equal(img.naturalWidth, 900);
    assert.equal(img.naturalHeight, 12540);
    assert.equal(isImageDrawable(img), true, 'готовую полосу можно рисовать');
  } finally {
    fake.restore();
  }
});

test('loadImageElement: ошибка не вешает загрузку — резолвится недоступная картинка', async () => {
  const fake = installFakeImage({ behavior: 'error' });
  try {
    const img = await loadImageElement('data:image/jpeg;base64,broken');
    assert.equal(isImageDrawable(img), false, 'битую картинку рисовать нельзя, но и падать некуда');
  } finally {
    fake.restore();
  }
});

test('loadImageElement: страховочный таймаут не превращается в вечное ожидание', async () => {
  const fake = installFakeImage({ behavior: 'never' });
  try {
    const started = Date.now();
    const img = await loadImageElement('data:image/jpeg;base64,slow', { timeoutMs: 20 });
    assert.ok(Date.now() - started < 1000, 'сработал таймаут');
    assert.equal(isImageDrawable(img), false);
  } finally {
    fake.restore();
  }
});

test('isImageDrawable: не готовая картинка не считается готовой', () => {
  assert.equal(isImageDrawable(null), false);
  assert.equal(isImageDrawable(undefined), false);
  assert.equal(
    isImageDrawable({ complete: false, naturalWidth: 900, naturalHeight: 12540 } as unknown as HTMLImageElement),
    false
  );
  assert.equal(
    isImageDrawable({ complete: true, naturalWidth: 0, naturalHeight: 0 } as unknown as HTMLImageElement),
    false
  );
  assert.equal(
    isImageDrawable({ complete: true, naturalWidth: 900, naturalHeight: 12540 } as unknown as HTMLImageElement),
    true
  );
});
