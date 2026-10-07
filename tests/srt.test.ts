import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebuildSrt, estimateDuration } from '../src/lib/pipeline/buildTimeline';
import type { PanelData } from '../src/lib/pipeline/extractPanels';

const BBOX = { x: 0, y: 0, width: 100, height: 100 };
const PANELS: PanelData[] = [
  { id: 0, bbox: BBOX, dialogue: 'Привет!', character: 'Аня', emotion: 'neutral', type: 'speech', order: 0, imageIndex: 0 },
  { id: 1, bbox: BBOX, dialogue: 'Приветствую.', character: 'Борис', emotion: 'neutral', type: 'speech', order: 1, imageIndex: 1 },
];

const BASE = {
  voiceAssignments: {},
  introDuration: 5,
  outroDuration: 4,
  panelGap: 0.6,
} as const;

test('rebuildSrt: интро — сегмент 0..introDuration, панели сдвинуты на introDuration', () => {
  const r = rebuildSrt({
    panels: PANELS,
    audioDurations: new Map([[0, 2], [1, 3]]),
    intro: 'Добро пожаловать',
    outro: '',
    ...BASE,
    realDurations: { 0: 2, 1: 3 },
  });
  assert.equal(r.timeline[0].audioStart, 5, 'первая панель стартует после интро');
  assert.match(r.srt, /00:00:00,000 --> 00:00:05,000/);
  assert.match(r.srt, /Добро пожаловать/);
  assert.match(r.srt, /00:00:05,000 --> 00:00:07,000/, 'панель 1: 5.0 → 7.0');
  assert.equal(r.draft, false);
});

test('rebuildSrt: пауза между панелями — старт следующей = конец предыдущей + gap', () => {
  const r = rebuildSrt({
    panels: PANELS,
    audioDurations: new Map([[0, 2], [1, 3]]),
    intro: '',
    outro: '',
    ...BASE,
    realDurations: { 0: 2, 1: 3 },
  });
  // панель 0: 5.0 → 7.0; +0.6 паузы → панель 1: 7.6 → 10.6
  assert.equal(r.timeline[1].audioStart, 7.6);
  assert.equal(r.timeline[1].audioEnd, 10.6);
  assert.match(r.srt, /00:00:07,600 --> 00:00:10,600/);
});

test('rebuildSrt: аутро — после последней панели, длительностью outroDuration', () => {
  const r = rebuildSrt({
    panels: PANELS,
    audioDurations: new Map([[0, 2], [1, 3]]),
    intro: '',
    outro: 'Спасибо за просмотр',
    ...BASE,
    realDurations: { 0: 2, 1: 3 },
  });
  // последняя панель кончается в 10.6 → аутро 10.6 → 14.6
  assert.match(r.srt, /00:00:10,600 --> 00:00:14,600/);
  assert.match(r.srt, /Спасибо за просмотр/);
});

test('rebuildSrt: без реальных длительностей — оценка по тексту, draft=true', () => {
  const r = rebuildSrt({
    panels: PANELS,
    audioDurations: new Map(),
    intro: '',
    outro: '',
    ...BASE,
  });
  const estimated = estimateDuration(PANELS[0].dialogue);
  assert.equal(r.timeline[0].audioEnd - r.timeline[0].audioStart, estimated, 'длительность = оценка по символам');
  assert.equal(r.draft, true, 'без реальных длительностей SRT черновой');

  const real: Record<number, number> = { 0: 2 };
  const partial = rebuildSrt({
    panels: PANELS,
    audioDurations: new Map([[0, 2]]),
    intro: '',
    outro: '',
    ...BASE,
    realDurations: real,
  });
  assert.equal(partial.draft, true, 'хотя бы одна панель без озвучки — черновик');

  const full = rebuildSrt({
    panels: PANELS,
    audioDurations: new Map([[0, 2], [1, 3]]),
    intro: '',
    outro: '',
    ...BASE,
    realDurations: { 0: 2, 1: 3 },
  });
  assert.equal(full.draft, false, 'все панели озвучены — SRT финальный');
});

test('rebuildSrt: пустой проект — пустой SRT, draft=false', () => {
  const r = rebuildSrt({
    panels: [],
    audioDurations: new Map(),
    intro: '',
    outro: '',
    ...BASE,
  });
  assert.equal(r.timeline.length, 0);
  assert.equal(r.srt, '');
  assert.equal(r.draft, false);
});
