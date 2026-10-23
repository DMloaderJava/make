import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStorageQuotaBeforeImport } from '../src/lib/storage/resourceIntegrity';

/**
 * P1-3: квота OPFS. Импорт не должен начинаться, если места заведомо не
 * хватит, и должен предупреждать, когда хранилище почти заполнено.
 */

const MB = 1024 * 1024;

test('P1-3: квота не определена — импорт не блокируется', async () => {
  const result = await checkStorageQuotaBeforeImport(10 * MB, { estimate: async () => null });
  assert.equal(result.ok, true);
  assert.equal(result.estimateAvailable, false);
});

test('P1-3: нехватка места блокирует импорт и объясняет причину', async () => {
  const result = await checkStorageQuotaBeforeImport(50 * MB, {
    estimate: async () => ({ usage: 95 * MB, quota: 100 * MB }),
    safetyMarginBytes: MB,
  });
  assert.equal(result.ok, false);
  assert.equal(result.estimateAvailable, true);
  assert.match(String(result.blockedReason), /Недостаточно места/);
  assert.equal(result.freeBytes, 5 * MB);
});

test('P1-3: импорт с запасом проходит без предупреждения', async () => {
  const result = await checkStorageQuotaBeforeImport(10 * MB, {
    estimate: async () => ({ usage: 10 * MB, quota: 1000 * MB }),
    safetyMarginBytes: MB,
  });
  assert.equal(result.ok, true);
  assert.equal(result.warning, undefined);
});

test('P1-3: почти заполненное хранилище даёт предупреждение, но не блокирует', async () => {
  const result = await checkStorageQuotaBeforeImport(10 * MB, {
    estimate: async () => ({ usage: 900 * MB, quota: 1000 * MB }),
    safetyMarginBytes: MB,
    warningRatio: 0.9,
  });
  assert.equal(result.ok, true);
  assert.match(String(result.warning), /заполнено на \d+%/);
});

test('P1-3: ошибка оценки квоты не блокирует импорт', async () => {
  const result = await checkStorageQuotaBeforeImport(10 * MB, {
    estimate: async () => {
      throw new Error('storage api недоступен');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.estimateAvailable, false);
});
