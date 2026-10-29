import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHUNK_RELOAD_COOLDOWN_MS,
  isChunkLoadError,
  planChunkReload,
} from '../src/lib/ui/chunkReload';

/**
 * Ошибка «Failed to load chunk» — устаревшая вкладка после пересборки.
 * Проверяем поведение решения о перезагрузке (инъекция часов и хранилища),
 * а не текст в JSX.
 */

const turbopackError = new Error(
  'Failed to load chunk /_next/static/chunks/3_i-48e2ce3p2.js from module 64893'
);

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    raw: data,
  };
}

test('сбой чанка распознаётся по сообщению Turbopack и webpack, по имени и по dynamic import', () => {
  assert.equal(isChunkLoadError(turbopackError), true);
  assert.equal(isChunkLoadError(new Error('Loading chunk 123 failed.')), true);
  assert.equal(isChunkLoadError(new Error('Failed to fetch dynamically imported module: /_next/x.js')), true);
  assert.equal(isChunkLoadError({ name: 'ChunkLoadError', message: 'что угодно' }), true);

  // Ложных срабатываний быть не должно: обычные ошибки приложения не лечатся
  // перезагрузкой страницы.
  assert.equal(isChunkLoadError(new TypeError('Cannot read properties of undefined')), false);
  assert.equal(isChunkLoadError(new Error('OpenAI TTS timeout: провайдер не ответил вовремя')), false);
  assert.equal(isChunkLoadError(new Error('Import failed: Incorrect API key provided')), false);
  assert.equal(isChunkLoadError(null), false);
  assert.equal(isChunkLoadError(undefined), false);
  assert.equal(isChunkLoadError(''), false);
});

test('первая ошибка чанка вызывает перезагрузку, повторная в пределах 15 с — нет', () => {
  const storage = memoryStorage();
  let now = 1_000_000;

  const first = planChunkReload(turbopackError, { storage, now: () => now });
  assert.deepEqual(first, { reload: true, reason: 'reload' });
  assert.equal(storage.raw.get('mvs:chunk-reload-at'), String(now));

  // Вкладка перезагрузилась, но новый HTML тоже старый (или файл реально потерян):
  // второй авто-reload превратил бы это в бесконечный цикл.
  now += 2_000;
  assert.deepEqual(planChunkReload(turbopackError, { storage, now: () => now }), {
    reload: false,
    reason: 'cooldown',
  });

  // Окно ожидания истекло — снова можно попробовать (пользователь вернулся позже).
  now += CHUNK_RELOAD_COOLDOWN_MS;
  assert.deepEqual(planChunkReload(turbopackError, { storage, now: () => now }), {
    reload: true,
    reason: 'reload',
  });
});

test('обычная ошибка не трогает хранилище и не перезагружает страницу', () => {
  const storage = memoryStorage();
  const decision = planChunkReload(new Error('boom'), { storage, now: () => 5_000 });
  assert.deepEqual(decision, { reload: false, reason: 'not-chunk-error' });
  assert.equal(storage.raw.size, 0, 'для не-chunk ошибок метка не пишется');
});

test('недоступное или сломанное хранилище не мешает восстановлению', () => {
  assert.deepEqual(planChunkReload(turbopackError, { storage: null }), { reload: true, reason: 'reload' });

  const broken = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  assert.deepEqual(planChunkReload(turbopackError, { storage: broken }), { reload: true, reason: 'reload' });
});
