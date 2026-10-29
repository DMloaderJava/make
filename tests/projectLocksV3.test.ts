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

/**
 * `assertTrackUnlocked` и проверка блокировок внутри NLE-операций живут в
 * `src/lib/pipeline/nleOperations.ts` с базовой линии (b7fbd57) — этот файл
 * с тех пор не менялся. Здесь проверяем не только саму функцию, но и то, что
 * реальные операции редактора действительно её вызывают: если кто-то уберёт
 * проверку из `setPanelAudioTrim`/`togglePanelMute`, тест упадёт.
 */
const lockPanels = [{
  id: 1,
  order: 0,
  imageIndex: 0,
  dialogue: 'Реплика для блокировки',
  character: 'Тест',
  emotion: 'neutral',
  bbox: { x: 0, y: 0, width: 100, height: 100 },
}] as any;

test('P1-1: assertTrackUnlocked различает дорожки', async () => {
  const { assertTrackUnlocked } = await import('../src/lib/pipeline/nleOperations');
  assert.throws(() => assertTrackUnlocked({ audioTrackLocked: true }, 'audio'), /заблокирована/i);
  assert.throws(() => assertTrackUnlocked({ videoTrackLocked: true }, 'video'), /заблокирована/i);
  assert.doesNotThrow(() => assertTrackUnlocked({ audioTrackLocked: false }, 'audio'));
  assert.doesNotThrow(() => assertTrackUnlocked(undefined, 'audio'));
  // Блокировка видео не мешает аудио-операциям и наоборот.
  assert.doesNotThrow(() => assertTrackUnlocked({ videoTrackLocked: true }, 'audio'));
});

test('P1-1: реальные NLE-операции уважают блокировку аудиодорожки', async () => {
  const { setPanelAudioTrim, togglePanelMute, splitPanelAudioClip } =
    await import('../src/lib/pipeline/nleOperations');
  const durs = { 1: 4 };
  const lockedAudio = { locks: { audioTrackLocked: true, videoTrackLocked: false } };

  assert.throws(() => setPanelAudioTrim(lockPanels, durs, 1, 0.5, 0.5, lockedAudio), /заблокирована/i);
  assert.throws(() => togglePanelMute(lockPanels, durs, 1, true, lockedAudio), /заблокирована/i);
  assert.throws(() => splitPanelAudioClip(lockPanels, durs, 1, 2, lockedAudio), /заблокирована/i);

  const unlocked = { locks: { audioTrackLocked: false, videoTrackLocked: true } };
  assert.doesNotThrow(() => togglePanelMute(lockPanels, durs, 1, true, unlocked));
});

