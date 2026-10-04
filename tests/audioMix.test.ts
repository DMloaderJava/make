import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatOverlaps, packStarts, stackBlobsBackToBack, userFacingOverlaps } from '../src/lib/pipeline/audioMix';

test('packStarts: без наложений ничего не меняет', () => {
  const result = packStarts([
    { start: 0, duration: 2, label: 'p1' },
    { start: 2, duration: 3, label: 'p2' },
    { start: 5, duration: 1, label: 'p3' },
  ]);

  assert.deepEqual(result.overlaps, []);
  assert.deepEqual(result.placements.map(p => p.start), [0, 2, 5]);
  assert.deepEqual(result.placements.map(p => p.playDuration), [2, 3, 1]);
  assert.equal(result.totalDuration, 6);
  assert.equal(result.placements.some(p => p.shifted), false);
});

test('packStarts: короткое наложение → обрезается ХВОСТ предыдущего, а не сдвиг', () => {
  // p2 должна была начаться в 2s, но p1 длится 3s (наложение 1s)
  const result = packStarts([
    { start: 0, duration: 3, label: 'p1' },
    { start: 2, duration: 2, label: 'p2' },
    { start: 4, duration: 1, label: 'p3' },
  ]);

  assert.deepEqual(result.placements.map(p => p.start), [0, 2, 4], 'старты не уезжают');
  assert.deepEqual(result.placements.map(p => p.playDuration), [2, 2, 1], 'p1 обрезана до 2s');
  assert.equal(result.placements[0].trimmed, true);
  assert.equal(result.placements[1].shifted, false);
  assert.equal(result.totalDuration, 5, 'ролик не удлинился');
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].kind, 'trim');
});

test('packStarts: вырожденное полное перекрытие → сдвиг вправо', () => {
  const result = packStarts([
    { start: 1, duration: 2, label: 'a' },
    { start: 1, duration: 2, label: 'b' },
  ]);

  assert.deepEqual(result.placements.map(p => p.start), [1, 3]);
  assert.equal(result.placements[1].shifted, true);
  assert.equal(result.overlaps[0].kind, 'shift');
  assert.ok(result.overlaps[0].lateBy > 0);
  assert.equal(result.totalDuration, 5);
});

test('packStarts: предыдущий слишком короткий для обрезки → сдвиг, а не отрицательная длительность', () => {
  const result = packStarts(
    [
      { start: 0, duration: 0.02, label: 'tiny' },
      { start: 0.01, duration: 1, label: 'next' },
    ],
    { minDuration: 0.05 }
  );

  assert.equal(result.placements[0].playDuration, 0.02, 'короткий фрагмент не тронут');
  assert.ok(result.placements[1].start >= 0.02);
  assert.equal(result.placements[1].playDuration, 1);
  assert.equal(result.overlaps[0].kind, 'shift');
});

test('packStarts: порядок не важен — сортировка по старту', () => {
  const result = packStarts([
    { start: 5, duration: 1, label: 'третья' },
    { start: 0, duration: 1, label: 'первая' },
    { start: 2.5, duration: 1, label: 'вторая' },
  ]);
  assert.deepEqual(result.placements.map(p => p.label), ['первая', 'вторая', 'третья']);
  assert.equal(result.overlaps.length, 0);
});

test('packStarts: пустой список', () => {
  const result = packStarts([]);
  assert.deepEqual(result.placements, []);
  assert.equal(result.totalDuration, 0);
  assert.deepEqual(result.overlaps, []);
});

test('packStarts: обрезка реплики панели — warning, интро/аутро — info', () => {
  const result = packStarts([
    { start: 0, duration: 12, label: 'Интро', role: 'intro' as const },
    { start: 8, duration: 5, label: 'panel-1', role: 'panel' as const },
  ]);

  assert.equal(result.overlaps.length, 1);
  assert.equal(result.overlaps[0].kind, 'trim');
  assert.equal(result.overlaps[0].severity, 'info', 'служебное интро обрезается без паники');
  assert.ok(Math.abs(result.overlaps[0].trimmedBy - 4) < 1e-6, 'обрезано 4 секунды');

  const panelCase = packStarts([
    { start: 0, duration: 9, label: 'panel-1', role: 'panel' as const },
    { start: 6, duration: 3, label: 'panel-2', role: 'panel' as const },
  ]);
  assert.equal(panelCase.overlaps[0].severity, 'warning', 'потеря конца реплики — предупреждение');
});

test('formatOverlaps/userFacingOverlaps: текст для UI только про панели', () => {
  const overlaps = packStarts([
    { start: 0, duration: 12, label: 'Интро', role: 'intro' as const },
    { start: 8, duration: 4, label: 'Панель 1 · Кадзума', role: 'panel' as const },
  ]).overlaps;

  const all = formatOverlaps(overlaps);
  assert.equal(all.length, 1);
  assert.match(all[0], /Интро/);

  const warnings = userFacingOverlaps(overlaps);
  assert.deepEqual(warnings, [], 'обрезка интро пользователю не показывается');

  const panelOverlap = packStarts([
    { start: 0, duration: 9, label: 'Панель 1 · Кадзума', role: 'panel' as const },
    { start: 6, duration: 3, label: 'Панель 2', role: 'panel' as const },
  ]).overlaps;
  const text = userFacingOverlaps(panelOverlap);
  assert.equal(text.length, 1);
  assert.match(text[0], /Панель 1/);
  assert.match(text[0], /3\.0 с/);
});

test('stackBlobsBackToBack: устаревшая раскладка идёт встык по фактическим длительностям', () => {
  // Регрессия: раньше videoEncoder для этого случая брал timeline[i-1].audioStart —
  // для outro (индекс за пределами таймлайна) это старт последней ПАНЕЛИ, то есть
  // наложение, а не «после неё». Здесь старт считается по длительностям.
  const blobs = [new Blob(['a']), new Blob(['b']), new Blob(['c'])];
  const placements = stackBlobsBackToBack(blobs, [1.5, 2, 0.5]);

  assert.deepEqual(placements.map(p => p.start), [0, 1.5, 3.5]);
  assert.ok(placements.every((p, i) => p.blob === blobs[i]), 'блобы идут в исходном порядке');

  // Битые длительности не должны отравить старт последующих фрагментов.
  const degenerate = stackBlobsBackToBack(blobs, [Number.NaN, -5, Number.POSITIVE_INFINITY]);
  assert.deepEqual(degenerate.map(p => p.start), [0, 0, 0]);
  assert.ok(degenerate.every(p => Number.isFinite(p.start)));

  assert.deepEqual(stackBlobsBackToBack([], []), []);
});
