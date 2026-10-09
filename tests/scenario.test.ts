import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScenario,
  serializeScenario,
  scenarioToPanels,
  applyScenarioToProject,
  SCENARIO_EXAMPLE,
  SCENARIO_GAP_SECONDS,
  genderLabel,
} from '../src/lib/pipeline/scenario';
import { buildTimeline, sameImageSpan, DEFAULT_PANEL_GAP } from '../src/lib/pipeline/buildTimeline';
import type { PanelData } from '../src/lib/pipeline/extractPanels';
import type { SyncTimeline } from '../src/lib/storage/db';

/** Пример из ТЗ формата: два персонажа, три изображения. */
const USER_FORMAT = `Изображение 1

Персонаж 1 (Жен.): Привет! Ты готов к сегодняшней вылазке?

Изображение 2

Персонаж 2 (Муж.): Как никогда. Главное — не отставать от группы.

Изображение 3

Персонаж 1 (Жен.): Договорились. Встречаемся у ворот на закате.`;

test('parseScenario: разбирает формат ТЗ (изображения, пол в скобках, реплики)', () => {
  const { lines, errors, warnings } = parseScenario(USER_FORMAT);
  assert.deepEqual(errors, [], 'ошибок быть не должно');
  assert.deepEqual(warnings, [], 'предупреждений быть не должно');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => l.imageIndex), [0, 1, 2], '«Изображение N» → индекс N-1');
  assert.deepEqual(lines.map(l => l.character), ['Персонаж 1', 'Персонаж 2', 'Персонаж 1']);
  assert.deepEqual(lines.map(l => l.gender), ['female', 'male', 'female'], 'пол из (Жен.)/(Муж.)');
  assert.equal(lines[1].text, 'Как никогда. Главное — не отставать от группы.', 'тире в тексте реплики не ломает разбор');
});

test('parseScenario: пример из модуля тоже валиден', () => {
  const { lines, errors } = parseScenario(SCENARIO_EXAMPLE);
  assert.deepEqual(errors, []);
  // v1.3.17: одна картинка на три панели с y-диапазонами + блок без диапазона.
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(l => l.imageIndex), [0, 0, 0, 1]);
  assert.deepEqual(lines.map(l => l.yRange), [{ from: 0, to: 30 }, { from: 30, to: 60 }, { from: 60, to: 100 }, null]);
});

test('parseScenario: устойчив к регистру, пробелам и тире-разделителю', () => {
  const text = 'ИЗОБРАЖЕНИЕ 1\n   ПЕРСОНАЖ 1 (жен.) :   текст с двоеточием: внутри\n\nизображение 2\n\nПерсонаж 2 (Муж) — текст с тире';
  const { lines, errors } = parseScenario(text);
  assert.deepEqual(errors, []);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].character, 'ПЕРСОНАЖ 1');
  assert.equal(lines[0].text, 'текст с двоеточием: внутри', 'разделитель — первое двоеточие');
  assert.equal(lines[1].gender, 'male', '(Муж) без точки — тоже мужской пол');
  assert.equal(lines[1].text, 'текст с тире');
});

test('parseScenario: дефис с пробелами и отсутствие пробелов в имени (вариации ТЗ)', () => {
  const text = [
    'Изображение 1',
    'Персонаж 1(Жен.): текст без пробелов перед скобкой',
    'Изображение 2',
    'Персонаж 2 (Муж.) - текст с дефисом-разделителем',
    'Изображение 3',
    'Персонаж-1 (Муж.): текст - с дефисом внутри',
  ].join('\n');
  const { lines, errors, warnings } = parseScenario(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].character, 'Персонаж 1', '«Персонаж 1(Жен.):» без пробелов разбирается');
  assert.equal(lines[0].text, 'текст без пробелов перед скобкой');
  assert.equal(lines[1].character, 'Персонаж 2');
  assert.equal(lines[1].gender, 'male', '«(Муж.) - текст» — дефис с пробелами как разделитель');
  assert.equal(lines[1].text, 'текст с дефисом-разделителем');
  assert.equal(lines[2].character, 'Персонаж-1', 'дефис в имени без пробелов — не разделитель');
  assert.equal(lines[2].text, 'текст - с дефисом внутри', 'разделитель — первое двоеточие, дефис в тексте сохранён');
});

test('parseScenario: двоеточие в имени не ломает разбор, если есть скобка пола', () => {
  const { lines, errors } = parseScenario('Изображение 1\nПерсонаж:1 (Муж.): текст');
  assert.deepEqual(errors, []);
  assert.equal(lines[0].character, 'Персонаж:1', 'разделитель — после «(Муж.)», а не первое двоеточие');
  assert.equal(lines[0].gender, 'male');
  assert.equal(lines[0].text, 'текст');
});

test('parseScenario: тире без пробелов — не разделитель (имена с тире целы)', () => {
  const { lines, errors } = parseScenario('Изображение 1\nПерсонаж—тест (Муж.): текст');
  assert.deepEqual(errors, []);
  assert.equal(lines[0].character, 'Персонаж—тест', '«—» без пробелов не режет имя');
  assert.equal(lines[0].text, 'текст');
});

test('parseScenario: тире-разделитель требует пробелы с обеих сторон', () => {
  const { errors } = parseScenario('Изображение 1\nИмя (Жен.)—текст');
  assert.ok(errors.some(e => e.includes('не реплика')), '«(Жен.)—текст» без пробелов — ошибка с подсказкой');
});

test('parseScenario: реплика до первого изображения — ошибка', () => {
  const { errors } = parseScenario('Персонаж (Жен.): текст\n\nИзображение 1\nПерсонаж (Жен.): другой');
  assert.ok(errors.some(e => e.includes('Строка 1')), 'ошибка на строке 1');
  assert.ok(errors.some(e => e.includes('первого')), 'указываем, что «Изображение N» должно быть раньше');
});

test('parseScenario: строка без разделителя — ошибка, пустой текст реплики — ошибка', () => {
  const { lines, errors } = parseScenario('Изображение 1\nПросто текст без двоеточия\nПерсонаж (Жен.):');
  assert.equal(lines.length, 0);
  assert.ok(errors.some(e => e.includes('не реплика')));
  assert.ok(errors.some(e => e.includes('текст реплики пуст')));
});

test('parseScenario: неизвестный пол — предупреждение, а не ошибка', () => {
  const { lines, errors, warnings } = parseScenario('Изображение 1\nПерсонаж (Другое): текст');
  assert.deepEqual(errors, []);
  assert.equal(lines[0].gender, null);
  assert.ok(warnings.some(w => w.includes('неизвестный пол')));
});

test('parseScenario: пол не указан — предупреждение', () => {
  const { lines, warnings } = parseScenario('Изображение 1\nПерсонаж: текст');
  assert.equal(lines[0].gender, null);
  assert.ok(warnings.some(w => w.includes('пол не указан')));
});

test('serializeScenario: ровно формат ТЗ — изображения и реплики, без лишнего', () => {
  const panels: Array<{ dialogue: string; character: string; imageIndex: number; order?: number }> = [
    { dialogue: 'Привет!', character: 'Аня', imageIndex: 0, order: 0 },
    { dialogue: 'Приветствую.', character: 'Борис', imageIndex: 1, order: 1 },
  ];
  const text = serializeScenario(panels, { Аня: 'female', Борис: 'male' });
  assert.equal(text, 'Изображение 1\n\nАня (Жен.): Привет!\n\nИзображение 2\n\nБорис (Муж.): Приветствую.\n');
  // Никакого лишнего текста: каждая непустая строка — либо «Изображение N», либо реплика
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    assert.match(line, /^Изображение \d+$|^.+\s*\(Жен\.|^.+\s*\(Муж\./);
  }
});

test('serialize → parse: round-trip сохраняет реплики, персонажей, пол и изображения', () => {
  const first = parseScenario(USER_FORMAT);
  const text = serializeScenario(
    first.lines.map((l, i) => ({ dialogue: l.text, character: l.character, imageIndex: l.imageIndex, order: i })),
    Object.fromEntries(first.lines.map(l => [l.character, l.gender!]))
  );
  const second = parseScenario(text);
  assert.deepEqual(second.lines, first.lines);
});

test('scenarioToPanels: одна реплика — одна панель на всё изображение', () => {
  const { lines } = parseScenario(USER_FORMAT);
  const { panels, warnings } = scenarioToPanels(lines, 5);
  assert.deepEqual(warnings, []);
  assert.equal(panels.length, 3);
  for (const p of panels) {
    assert.deepEqual(p.bbox, { x: 0, y: 0, width: 100, height: 100 });
    assert.equal(p.type, 'speech');
  }
  assert.deepEqual(panels.map(p => p.imageIndex), [0, 1, 2]);
  // Режим сценария: вся панель = всё изображение → Preview/экспорт рисуют
  // contain (letterbox) без зума, bbox-обводку не рисуют.
  for (const p of panels) {
    assert.equal(p.fullFrame, true, 'панели сценария помечаются fullFrame');
  }
});

test('scenarioToPanels: несуществующего изображения нет — клампим в последнее и предупреждаем', () => {
  const { lines } = parseScenario(USER_FORMAT);
  const { panels, warnings } = scenarioToPanels(lines, 2);
  assert.deepEqual(panels.map(p => p.imageIndex), [0, 1, 1]);
  assert.ok(warnings.some(w => w.includes('Изображение 3') && w.includes('к изображению 2')));
});

test('buildTimeline: пауза между репликами 0,6 с (правило 3 сценария)', () => {
  const panels: PanelData[] = [
    { id: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, dialogue: 'Первая.', character: 'Аня', emotion: 'neutral', type: 'speech', order: 0, imageIndex: 0 },
    { id: 1, bbox: { x: 0, y: 0, width: 100, height: 100 }, dialogue: 'Вторая.', character: 'Борис', emotion: 'neutral', type: 'speech', order: 1, imageIndex: 1 },
  ];
  const durations = new Map([[0, 1], [1, 2]]);

  const timeline = buildTimeline(panels, durations, {}, 0, SCENARIO_GAP_SECONDS);
  assert.equal(timeline[0].audioStart, 0);
  assert.equal(timeline[0].audioEnd, 1);
  assert.equal(timeline[1].audioStart, 1.6, 'вторая реплика стартует через 0,6 с после окончания первой');
  assert.equal(timeline[1].audioEnd, 3.6);
});

test('buildTimeline: дефолтная пауза 0,3 с сохранена для обычных проектов', () => {
  const panels: PanelData[] = [
    { id: 0, bbox: { x: 0, y: 0, width: 100, height: 100 }, dialogue: 'Первая.', character: 'Аня', emotion: 'neutral', type: 'speech', order: 0, imageIndex: 0 },
    { id: 1, bbox: { x: 0, y: 0, width: 100, height: 100 }, dialogue: 'Вторая.', character: 'Борис', emotion: 'neutral', type: 'speech', order: 1, imageIndex: 1 },
  ];
  const durations = new Map([[0, 1]]);
  assert.equal(DEFAULT_PANEL_GAP, 0.3);
  const timeline = buildTimeline(panels, durations, {}, 0);
  assert.equal(timeline[1].audioStart, 1.3, 'без сценария пауза осталась 0,3 с');
});

test('genderLabel: Жен. / Муж.', () => {
  assert.equal(genderLabel('female'), 'Жен.');
  assert.equal(genderLabel('male'), 'Муж.');
});

function seg(
  panelId: number,
  imageIndex: number,
  audioStart: number,
  audioEnd: number
): SyncTimeline {
  return {
    panelId,
    imageIndex,
    audioStart,
    audioEnd,
    panelBbox: { x: 0, y: 0, width: 100, height: 100 },
    voiceId: '',
    text: '',
    character: '',
  };
}

test('sameImageSpan: две соседние панели одного изображения → разряд всей группы', () => {
  // imageIndex 0: панели 0 (0–1) и 1 (1.6–3.6); imageIndex 1: панель 2 (4.2–5).
  const timeline = [
    seg(0, 0, 0, 1),
    seg(1, 0, 1.6, 3.6),
    seg(2, 1, 4.2, 5),
  ];
  // Для панели 0 и 1 — один и тот же разряд: от старта первой до конца последней.
  const spanA = sameImageSpan(timeline, 0);
  const spanB = sameImageSpan(timeline, 1);
  assert.ok(spanA && spanB);
  assert.equal(spanA.start, 0);
  assert.equal(spanA.end, 3.6);
  assert.equal(spanA.startIndex, 0);
  assert.equal(spanB.start, 0);
  assert.equal(spanB.end, 3.6);
  assert.equal(spanB.startIndex, 0);
});

test('sameImageSpan: одиночная панель → разряд совпадает с её сегментом', () => {
  const timeline = [seg(0, 0, 0, 1), seg(1, 1, 1.6, 3.6)];
  const span = sameImageSpan(timeline, 1);
  assert.ok(span);
  assert.equal(span.start, 1.6);
  assert.equal(span.end, 3.6);
  assert.equal(span.startIndex, 1);
});

test('sameImageSpan: повторное изображение НЕ в группе (разрыв) → свой разряд', () => {
  // imageIndex 0 → 1 → 0: первая и третья панели на одном изображении, но
  // разделены другим — каждая даёт собственный разряд (не объединяются).
  const timeline = [seg(0, 0, 0, 1), seg(1, 1, 1.6, 3.6), seg(2, 0, 4.2, 5)];
  const spanFirst = sameImageSpan(timeline, 0);
  const spanThird = sameImageSpan(timeline, 2);
  assert.ok(spanFirst && spanThird);
  assert.equal(spanFirst.start, 0);
  assert.equal(spanFirst.end, 1);
  assert.equal(spanThird.start, 4.2);
  assert.equal(spanThird.end, 5);
  assert.equal(spanThird.startIndex, 2);
});

test('sameImageSpan: неизвестного panelId → null', () => {
  const timeline = [seg(0, 0, 0, 1)];
  assert.equal(sameImageSpan(timeline, 42), null);
});

// ---- v1.3.16: сценарий не трогает интро/аутро ----

const PROJECT_WITH_INTRO_OUTRO = {
  panels: [] as PanelData[],
  characters: [
    { name: 'Аня', appearance: 'волосы', voiceId: 'v1', emotion: 'neutral', gender: 'female' as const },
  ],
  intro: 'Подводка к ролику',
  outro: 'Финальная фраза',
  introDuration: 6,
  outroDuration: 4,
};

test('applyScenarioToProject: интро/аутро СОХРАНЯЮТСЯ (не очищаются)', () => {
  const { lines } = parseScenario(USER_FORMAT);
  const patch = applyScenarioToProject(PROJECT_WITH_INTRO_OUTRO, lines, {
    imagesCount: 5,
    panelGap: SCENARIO_GAP_SECONDS,
    voiceAssignments: {},
  });
  assert.equal(patch.intro, 'Подводка к ролику', 'интро не очищается');
  assert.equal(patch.outro, 'Финальная фраза', 'аутро не очищается');
  assert.equal(patch.introDuration, 6);
  assert.equal(patch.outroDuration, 4);
  assert.equal(patch.panels.length, 3);
  assert.ok(patch.panels.every(p => p.fullFrame === true));
});

test('applyScenarioToProject: таймлайн и SRT строятся из интро проекта', () => {
  const { lines } = parseScenario(USER_FORMAT);
  const patch = applyScenarioToProject(PROJECT_WITH_INTRO_OUTRO, lines, {
    imagesCount: 5,
    panelGap: SCENARIO_GAP_SECONDS,
    voiceAssignments: {},
  });
  // Первая панель стартует после интро (6 с), а не с нуля.
  assert.equal(patch.timeline[0].audioStart, 6);
  // В SRT есть сегмент интро 0 → 6 и текст аутро.
  assert.match(patch.srt, /00:00:00,000 --> 00:00:06,000/);
  assert.match(patch.srt, /Подводка к ролику/);
  assert.match(patch.srt, /Финальная фраза/);
});

test('applyScenarioToProject: персонажи — существующие сохраняются, новые добавляются с полом', () => {
  const { lines } = parseScenario(USER_FORMAT);
  const patch = applyScenarioToProject(PROJECT_WITH_INTRO_OUTRO, lines, {
    imagesCount: 5,
    panelGap: SCENARIO_GAP_SECONDS,
    voiceAssignments: { Аня: 'voice-1' },
  });
  const byName = new Map(patch.characters.map(c => [c.name, c]));
  assert.equal(byName.get('Аня')?.gender, 'female', 'существующий персонаж сохранён с полом');
  assert.equal(byName.get('Персонаж 1')?.gender, 'female', 'новый персонаж из (Жен.)');
  assert.equal(byName.get('Персонаж 2')?.gender, 'male', 'новый персонаж из (Муж.)');
  // voiceId существующего персонажа не теряется.
  assert.equal(byName.get('Аня')?.voiceId, 'v1');
});
