import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateProjectSchema } from '../src/lib/storage/schemaMigration';
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../src/lib/storage/db';

/**
 * P1-1: блокировки дорожек переживают перезагрузку (схема проекта v2 → v3).
 *
 * До миграции `videoTrackLocked`/`audioTrackLocked` были локальным состоянием
 * компонента Timeline: после перезагрузки обе дорожки молча разблокировались.
 */

const baseV2Project = {
  id: 'lock-project',
  name: 'Проект с блокировками',
  schemaVersion: 2,
  timelineVersion: 2,
  revision: 3,
  images: [],
  panels: [],
  characters: [],
  voiceAssignments: {},
  timeline: [],
  intro: '',
  outro: '',
  introDuration: 8,
  outroDuration: 5,
  srt: '',
  updatedAt: 1,
  createdAt: 1,
} as any;

test('P1-1: актуальная версия схемы — 3', () => {
  assert.equal(CURRENT_PROJECT_SCHEMA_VERSION, 3);
});

test('P1-1: проект v2 получает блокировки по умолчанию (обе разблокированы)', () => {
  const result = migrateProjectSchema({ ...baseV2Project });
  assert.equal(result.project.schemaVersion, 3);
  assert.deepEqual(result.project.locks, { videoTrackLocked: false, audioTrackLocked: false });
  assert.ok(result.steps.includes('schema:2->3'), `шаги миграции: ${result.steps.join(', ')}`);
});

test('P1-1: установленные блокировки сохраняются при миграции', () => {
  const result = migrateProjectSchema({
    ...baseV2Project,
    locks: { videoTrackLocked: true, audioTrackLocked: true },
  });
  assert.equal(result.project.locks?.videoTrackLocked, true);
  assert.equal(result.project.locks?.audioTrackLocked, true);
});

test('P1-1: частичное состояние блокировок доопределяется до полного', () => {
  const result = migrateProjectSchema({
    ...baseV2Project,
    locks: { audioTrackLocked: true },
  });
  assert.deepEqual(result.project.locks, { videoTrackLocked: false, audioTrackLocked: true });
});

test('P1-1: повторная миграция актуального проекта идемпотентна', () => {
  const first = migrateProjectSchema({ ...baseV2Project, locks: { videoTrackLocked: true } });
  const migrated = { ...first.project, resourceManifest: {}, eventLog: [], revision: 0 } as any;
  const second = migrateProjectSchema(migrated);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.project.locks, { videoTrackLocked: true, audioTrackLocked: false });
});

test('P1-1: NLE-операция уважает блокировку дорожки', async () => {
  const { splitPanelAudioClip, assertTrackUnlocked } = await import('../src/lib/pipeline/nleOperations');
  assert.throws(
    () => assertTrackUnlocked({ audioTrackLocked: true }, 'audio'),
    /заблокирована/i
  );
  assert.doesNotThrow(() => assertTrackUnlocked({ audioTrackLocked: false }, 'audio'));
  assert.equal(typeof splitPanelAudioClip, 'function');
});
