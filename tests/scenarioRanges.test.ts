/**
 * v1.3.17: сценарий с y-диапазонами «Изображение N [X..Y%]».
 * Парсер → панели с bbox → сериализация → лента (spans, keyframes, seek).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScenario,
  serializeScenario,
  scenarioToPanels,
  formatRangeNum,
} from '../src/lib/pipeline/scenario';
import {
  buildPanelScrollSpans,
  buildScrollKeyframes,
  buildScrollSpans,
  buildStripScrollSpans,
  computeStripLayout,
  createStripScene,
  panelYRange,
  timeAtScroll,
} from '../src/lib/pipeline/mangaStrip';

const one = (header: string) => parseScenario(`${header}\nАня (Жен.): Привет!`);

// ---- Парсер ----

test('parseScenario: [0..20%] → yRange {0, 20}', () => {
  const { lines, errors } = one('Изображение 1 [0..20%]');
  assert.deepEqual(errors, []);
  assert.deepEqual(lines[0].yRange, { from: 0, to: 20 });
  assert.equal(lines[0].imageIndex, 0);
});

test('parseScenario: знак % опционален — [20..45] = [20..45%]', () => {
  assert.deepEqual(one('Изображение 1 [20..45]').lines[0].yRange, { from: 20, to: 45 });
  assert.deepEqual(one('Изображение 1 [20..45%]').lines[0].yRange, { from: 20, to: 45 });
});

test('parseScenario: пробелы внутри скобок игнорируются', () => {
  for (const header of ['Изображение 1 [ 0 .. 20 % ]', 'Изображение 1 [0.. 20%]', 'Изображение 1[0..20]', 'Изображение 1 [0 % .. 20 %]']) {
    const { lines, errors } = one(header);
    assert.deepEqual(errors, [], header);
    assert.deepEqual(lines[0].yRange, { from: 0, to: 20 }, header);
  }
});

test('parseScenario: без скобок — yRange null (старый формат)', () => {
  const { lines, errors } = one('Изображение 1');
  assert.deepEqual(errors, []);
  assert.equal(lines[0].yRange, null);
});

test('parseScenario: [0..100%] → yRange {0, 100}', () => {
  assert.deepEqual(one('Изображение 1 [0..100%]').lines[0].yRange, { from: 0, to: 100 });
});

test('parseScenario: дробные числа — точка и запятая', () => {
  assert.deepEqual(one('Изображение 1 [12.5..40%]').lines[0].yRange, { from: 12.5, to: 40 });
  assert.deepEqual(one('Изображение 1 [12,5..40,25%]').lines[0].yRange, { from: 12.5, to: 40.25 });
});

test('parseScenario: [50..50%] — ошибка «начало должно быть меньше конца»', () => {
  const { errors } = one('Изображение 1 [50..50%]');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /начало должно быть меньше конца/);
  assert.match(one('Изображение 1 [60..20%]').errors[0], /начало должно быть меньше конца/);
});

test('parseScenario: [-10..20%] — ошибка «вне 0..100»', () => {
  const { errors } = one('Изображение 1 [-10..20%]');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /вне 0\.\.100/);
});

test('parseScenario: [0..150%] — ошибка «вне 0..100»', () => {
  const { errors } = one('Изображение 1 [0..150%]');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /вне 0\.\.100/);
});

test('parseScenario: [abc..20%] — понятная ошибка диапазона, без каскада на реплики', () => {
  const { errors } = parseScenario('Изображение 1 [abc..20%]\nАня (Жен.): Привет!\nБорис (Муж.): Пока!');
  assert.equal(errors.length, 1, `ровно одна ошибка, а не «реплика до первого изображения»: ${errors.join(' | ')}`);
  assert.match(errors[0], /Строка 1/);
  assert.match(errors[0], /y-диапазон/);
});

test('parseScenario: диапазон действует до следующего «Изображение N», без скобок — сброс', () => {
  const { lines, errors } = parseScenario([
    'Изображение 1 [0..30%]',
    'Аня (Жен.): раз',
    'Борис (Муж.): два',
    'Изображение 1 [30..100%]',
    'Аня (Жен.): три',
    'Изображение 2',
    'Борис (Муж.): четыре',
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.deepEqual(lines.map(l => l.yRange), [
    { from: 0, to: 30 },
    { from: 0, to: 30 },
    { from: 30, to: 100 },
    null,
  ]);
  assert.deepEqual(lines.map(l => l.imageIndex), [0, 0, 0, 1]);
});

// ---- scenarioToPanels ----

const THREE_BANDS = `Изображение 1 [0..30%]

Персонаж 1 (Жен.): Первая.

Изображение 1 [30..60%]

Персонаж 2 (Муж.): Вторая.

Изображение 1 [60..100%]

Персонаж 1 (Жен.): Третья.`;

test('scenarioToPanels: три полосы одной картинки → bbox по y, fullFrame не ставится', () => {
  const { lines } = parseScenario(THREE_BANDS);
  const { panels, warnings } = scenarioToPanels(lines, 1);
  assert.deepEqual(warnings, []);
  assert.deepEqual(panels.map(p => p.bbox.y), [0, 30, 60]);
  assert.deepEqual(panels.map(p => p.bbox.height), [30, 30, 40]);
  for (const p of panels) {
    assert.equal(p.bbox.x, 0);
    assert.equal(p.bbox.width, 100, 'X пока не поддерживаем — на всю ширину');
    assert.equal(p.fullFrame, undefined, 'с диапазоном лента работает по bbox');
    assert.equal(p.imageIndex, 0);
  }
});

test('scenarioToPanels: без диапазона — bbox 0,0,100,100 и fullFrame: true', () => {
  const { lines } = one('Изображение 1');
  const { panels } = scenarioToPanels(lines, 1);
  assert.deepEqual(panels[0].bbox, { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(panels[0].fullFrame, true);
});

test('scenarioToPanels: [0..100%] — это вся картинка, как без диапазона', () => {
  const { panels } = scenarioToPanels(one('Изображение 1 [0..100%]').lines, 1);
  assert.deepEqual(panels[0].bbox, { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(panels[0].fullFrame, true);
});

// ---- serializeScenario ----

test('serializeScenario: bbox {0,30,100,30} → «Изображение 1 [30..60%]»', () => {
  const text = serializeScenario(
    [{ dialogue: 'Привет!', character: 'Аня', imageIndex: 0, order: 0, bbox: { x: 0, y: 30, width: 100, height: 30 } }],
    { Аня: 'female' }
  );
  assert.equal(text, 'Изображение 1 [30..60%]\n\nАня (Жен.): Привет!\n');
});

test('serializeScenario: fullFrame / bbox на всю картинку / без bbox → без скобок', () => {
  const full = { x: 0, y: 0, width: 100, height: 100 };
  assert.equal(
    serializeScenario([{ dialogue: 'А', character: 'Аня', imageIndex: 0, bbox: { x: 0, y: 30, width: 100, height: 30 }, fullFrame: true }]),
    'Изображение 1\n\nАня: А\n'
  );
  assert.equal(serializeScenario([{ dialogue: 'А', character: 'Аня', imageIndex: 0, bbox: full }]), 'Изображение 1\n\nАня: А\n');
  assert.equal(serializeScenario([{ dialogue: 'А', character: 'Аня', imageIndex: 0 }]), 'Изображение 1\n\nАня: А\n');
});

test('serializeScenario: смена диапазона на той же картинке — новый блок; одинаковый — тот же блок', () => {
  const bbox = (y: number, h: number) => ({ x: 0, y, width: 100, height: h });
  const text = serializeScenario([
    { dialogue: 'раз', character: 'Аня', imageIndex: 0, order: 0, bbox: bbox(0, 30) },
    { dialogue: 'два', character: 'Аня', imageIndex: 0, order: 1, bbox: bbox(0, 30) },
    { dialogue: 'три', character: 'Аня', imageIndex: 0, order: 2, bbox: bbox(30, 70) },
  ]);
  assert.equal(text, 'Изображение 1 [0..30%]\n\nАня: раз\nАня: два\n\nИзображение 1 [30..100%]\n\nАня: три\n');
});

test('formatRangeNum: 1 знак после запятой, без «.0»', () => {
  assert.equal(formatRangeNum(20), '20');
  assert.equal(formatRangeNum(20.5), '20.5');
  assert.equal(formatRangeNum(7.25), '7.3');
  assert.equal(formatRangeNum(0.1 + 0.2), '0.3');
  assert.equal(formatRangeNum(19.96), '20');
});

test('round-trip: parse → panels → serialize → parse сохраняет yRange', () => {
  const source = `${THREE_BANDS}\n\nИзображение 2\n\nПерсонаж 2 (Муж.): Четвёртая.\n\nИзображение 3 [12.5..47%]\n\nПерсонаж 1 (Жен.): Пятая.`;
  const first = parseScenario(source);
  assert.deepEqual(first.errors, []);
  const { panels } = scenarioToPanels(first.lines, 3);
  const text = serializeScenario(panels, { 'Персонаж 1': 'female', 'Персонаж 2': 'male' });
  const second = parseScenario(text);
  assert.deepEqual(second.errors, []);
  assert.deepEqual(second.lines, first.lines);
});

// ---- Лента: одна длинная webtoon-полоса ----
// 1000×6000 → в кадре 1920 по ширине → слот 11520 px (кадр 1080).

const FRAME = { frameWidth: 1920, frameHeight: 1080 };
const LONG = computeStripLayout([{ width: 1000, height: 6000 }], { ...FRAME, viewport: 1080, gap: 24 });
const band = (id: number, from: number, to: number) => ({
  id,
  imageIndex: 0,
  bbox: { x: 0, y: from, width: 100, height: to - from },
});
const BANDS = [band(0, 0, 30), band(1, 30, 60), band(2, 60, 100)];
const BAND_TIMELINE = [
  { panelId: 0, imageIndex: 0, audioStart: 0, audioEnd: 3 },
  { panelId: 1, imageIndex: 0, audioStart: 3.6, audioEnd: 6.6 },
  { panelId: 2, imageIndex: 0, audioStart: 7.2, audioEnd: 10.2 },
];

test('панель-фикстура: слот длинной полосы — 11520 px', () => {
  assert.equal(LONG.slots[0].height, 11520);
  assert.equal(LONG.totalHeight, 11520);
});

test('panelYRange: fullFrame, bbox 0..100 и битые числа — null; полоса — диапазон', () => {
  assert.equal(panelYRange(undefined), null);
  assert.equal(panelYRange({ id: 0, imageIndex: 0 }), null);
  assert.equal(panelYRange({ id: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 100 } }), null);
  assert.equal(panelYRange({ id: 0, imageIndex: 0, bbox: { x: 0, y: 30, width: 100, height: 30 }, fullFrame: true }), null);
  assert.equal(panelYRange({ id: 0, imageIndex: 0, bbox: { x: 0, y: NaN, width: 100, height: 30 } }), null);
  assert.deepEqual(panelYRange(band(0, 30, 60)), { from: 30, to: 60 });
});

test('buildPanelScrollSpans: три полосы на одной картинке → три разных диапазона', () => {
  const spans = buildPanelScrollSpans(BAND_TIMELINE, LONG, BANDS);
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map(s => [s.startPx, s.endPx]), [
    [0, 3456 - 1080],
    [3456, 6912 - 1080],
    [6912, 11520 - 1080],
  ]);
  const unique = new Set(spans.map(s => `${s.startPx}:${s.endPx}`));
  assert.equal(unique.size, 3, 'не один и тот же диапазон слота');
});

test('buildPanelScrollSpans: короткая полоса (ниже кадра) → startPx === endPx (центр полосы)', () => {
  // [50..55%] = 576 px < 1080: центр полосы 6048 → окно 6048 - 540.
  const spans = buildPanelScrollSpans(
    [{ panelId: 0, imageIndex: 0, audioStart: 0, audioEnd: 3 }],
    LONG,
    [band(0, 50, 55)]
  );
  assert.equal(spans[0].startPx, spans[0].endPx);
  assert.equal(spans[0].startPx, 6048 - 540);
});

test('buildPanelScrollSpans: панели без bbox/fullFrame — старое поведение (вся страница)', () => {
  const spans = buildPanelScrollSpans(
    BAND_TIMELINE,
    LONG,
    BANDS.map(p => ({ ...p, fullFrame: true }))
  );
  for (const s of spans) assert.deepEqual([s.startPx, s.endPx], [0, 11520 - 1080]);
});

test('timeAtScroll: верхняя треть полосы → первая панель', () => {
  assert.equal(timeAtScroll(LONG, BAND_TIMELINE, 1000, BANDS), 0);
  assert.equal(timeAtScroll(LONG, BAND_TIMELINE, 0, BANDS), 0);
});

test('timeAtScroll: средняя треть → вторая панель', () => {
  assert.equal(timeAtScroll(LONG, BAND_TIMELINE, 4000, BANDS), 3.6);
});

test('timeAtScroll: нижняя треть → третья панель', () => {
  assert.equal(timeAtScroll(LONG, BAND_TIMELINE, 9000, BANDS), 7.2);
  assert.equal(timeAtScroll(LONG, BAND_TIMELINE, 10440, BANDS), 7.2, 'конец ленты');
});

test('timeAtScroll: промежуток между полосами → ближайшая по вертикали', () => {
  const gapped = [band(0, 0, 30), band(1, 60, 100)];
  const timeline = [BAND_TIMELINE[0], { ...BAND_TIMELINE[1], panelId: 1 }];
  // центр окна на 40% (4608 px) — до первой 10%, до второй 20%.
  assert.equal(timeAtScroll(LONG, timeline, 4608 - 540, gapped), 0);
  // центр на 52% — ближе ко второй.
  assert.equal(timeAtScroll(LONG, timeline, 11520 * 0.52 - 540, gapped), 3.6);
});

// ---- Сцена ленты (то, что реально рисуют Preview и экспорт) ----

test('buildStripScrollSpans: без bbox — ровно как buildScrollSpans (старые проекты не меняются)', () => {
  const plain = BANDS.map(p => ({ id: p.id, imageIndex: p.imageIndex }));
  assert.deepEqual(buildStripScrollSpans(BAND_TIMELINE, LONG, plain), buildScrollSpans(BAND_TIMELINE, plain));
  assert.deepEqual(buildStripScrollSpans(BAND_TIMELINE, LONG), buildScrollSpans(BAND_TIMELINE));
});

test('buildStripScrollSpans: панели с bbox → свой интервал на каждую реплику', () => {
  const spans = buildStripScrollSpans(BAND_TIMELINE, LONG, BANDS);
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map(s => [s.start, s.end, s.startPx, s.endPx]), [
    [0, 3, 0, 2376],
    [3.6, 6.6, 3456, 5832],
    [7.2, 10.2, 6912, 10440],
  ]);
});

test('createStripScene: лента едет по полосам синхронно с озвучкой', () => {
  const scene = createStripScene({
    sizes: [{ width: 1000, height: 6000 }],
    images: [null],
    timeline: BAND_TIMELINE,
    panels: BANDS,
    options: { ...FRAME, viewport: 1080, gap: 24, transition: 0.8 },
  });
  // Начало каждой реплики — окно у верха её полосы.
  assert.equal(scene.scrollAt(0), 0);
  assert.equal(scene.scrollAt(3.6), 3456);
  assert.equal(scene.scrollAt(7.2), 6912);
  // Середина реплики — внутри её диапазона.
  const mid1 = scene.scrollAt(5);
  assert.ok(mid1 > 3456 && mid1 < 5832, `вторая полоса: ${mid1}`);
  // Конец — у низа последней полосы, лента не стоит на месте.
  assert.equal(scene.scrollAt(10.2), 10440);
  // Скролл ↔ время: в каждый момент звучания seek ведёт к звучащей панели.
  for (const seg of BAND_TIMELINE) {
    for (const t of [seg.audioStart + 0.1, (seg.audioStart + seg.audioEnd) / 2]) {
      assert.equal(timeAtScroll(scene.layout, BAND_TIMELINE, scene.scrollAt(t), BANDS), seg.audioStart, `t=${t}`);
    }
  }
});

test('createStripScene: fullFrame-панели — keyframes как раньше (по странице)', () => {
  const panels = BANDS.map(p => ({ id: p.id, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, fullFrame: true }));
  const scene = createStripScene({
    sizes: [{ width: 1000, height: 6000 }],
    images: [null],
    timeline: BAND_TIMELINE,
    panels,
    options: { ...FRAME, viewport: 1080, gap: 24, transition: 0.8 },
  });
  const legacy = buildScrollKeyframes(buildScrollSpans(BAND_TIMELINE, panels), LONG, { transition: 0.8 });
  assert.deepEqual(scene.keyframes, legacy);
});

test('createStripScene: смешанный проект — страница без bbox и полосы на другой', () => {
  const layout = computeStripLayout([{ width: 1000, height: 1000 }, { width: 1000, height: 6000 }], { ...FRAME, viewport: 1080, gap: 24 });
  const timeline = [
    { panelId: 0, imageIndex: 0, audioStart: 0, audioEnd: 3 },
    { panelId: 1, imageIndex: 1, audioStart: 3.6, audioEnd: 6.6 },
    { panelId: 2, imageIndex: 1, audioStart: 7.2, audioEnd: 10.2 },
  ];
  const panels = [
    { id: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, fullFrame: true },
    { id: 1, imageIndex: 1, bbox: { x: 0, y: 0, width: 100, height: 50 } },
    { id: 2, imageIndex: 1, bbox: { x: 0, y: 50, width: 100, height: 50 } },
  ];
  const spans = buildStripScrollSpans(timeline, layout, panels);
  assert.equal(spans.length, 3);
  assert.equal(spans[0].startPx, undefined, 'страница без bbox — как раньше');
  const slot1 = layout.slots[1];
  assert.equal(spans[1].startPx, slot1.y);
  assert.equal(spans[2].startPx, slot1.y + slot1.height / 2);
});
