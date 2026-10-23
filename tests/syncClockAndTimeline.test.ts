import { readEditorSource } from './helpers/editorSource';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  calculateTotalDuration,
  DEFAULT_PANEL_GAP,
  generateSRT,
  invalidateAndRebuildTimeline,
  parseSRTCues,
  rebuildSrt,
  resolvePanelEffectiveDuration,
  roundMediaDuration,
} from '../src/lib/pipeline/buildTimeline';
import {
  ProjectClock,
  resolveActiveTimelineMoment,
} from '../src/lib/pipeline/projectClock';
import {
  validateAudioNonOverlapping,
  validatePanelPercentages,
  validateSrtSync,
  validateTimelineFull,
  validateTimelineMonotonicity,
  validateTotalDuration,
} from '../src/lib/pipeline/timelineValidator';
import { migrateProjectSchema } from '../src/lib/storage/schemaMigration';
import { applyScenarioToProject, parseScenario } from '../src/lib/pipeline/scenario';
import type { PanelData, Project } from '../src/lib/storage/db';

function makePanel(id: number, overrides: Partial<PanelData> = {}): PanelData {
  return {
    id,
    order: id - 1,
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 50 },
    dialogue: `Реплика панели номер ${id}`,
    character: 'Герой',
    emotion: 'neutral',
    type: 'speech',
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'test-proj-1',
    name: 'Test Project',
    createdAt: 1000,
    updatedAt: 2000,
    images: [],
    panels: [],
    characters: [],
    voiceAssignments: {},
    timeline: [],
    srt: '',
    intro: 'Вступление',
    outro: 'Финал',
    introDuration: 2,
    outroDuration: 2,
    seoPackage: null,
    settings: {
      ttsProvider: 'google',
      llmProvider: 'openrouter',
      visionModel: 'google/gemini-2.5-flash',
      ttsSpeed: 1,
      musicVolume: 0.2,
      panelGap: DEFAULT_PANEL_GAP,
    },
    ...overrides,
  };
}

test('Stage 1 (1, 61): ProjectClock управляет единым временем проекта и разрешает активный сегмент', () => {
  const panels = [
    makePanel(1, { imageIndex: 0 }),
    makePanel(2, { imageIndex: 1 }),
  ];
  const durations = new Map<number, number>([
    [1, 3.0],
    [2, 4.0],
  ]);
  const tl = buildTimeline(panels, durations, {}, 2.0, 0.5, { mode: 'real' });
  const total = calculateTotalDuration(tl, 2.0, 1.5);
  assert.equal(total, 2.0 + 3.0 + 0.5 + 4.0 + 1.5);

  const clock = new ProjectClock({ duration: total });
  const observed: number[] = [];
  const unsub = clock.subscribe(snap => observed.push(snap.currentTime));

  clock.seek(1.0);
  const introMoment = resolveActiveTimelineMoment(tl, panels, clock.getTime(), 2.0, 1.5);
  assert.equal(introMoment.phase, 'intro');
  assert.equal(introMoment.activeClipId, 'intro');

  clock.seek(2.5);
  const panel1Moment = resolveActiveTimelineMoment(tl, panels, clock.getTime(), 2.0, 1.5);
  assert.equal(panel1Moment.phase, 'panel');
  assert.equal(panel1Moment.activePanelId, 1);
  assert.equal(panel1Moment.activeClipId, 'panel:1');

  // Межрепликовая пауза 5.0..5.5
  clock.seek(5.25);
  const gapMoment = resolveActiveTimelineMoment(tl, panels, clock.getTime(), 2.0, 1.5);
  assert.equal(gapMoment.phase, 'gap');
  // Во время паузы удерживается кадр предыдущей панели без сброса
  assert.equal(gapMoment.activePanelId, 1);

  clock.seek(10.0);
  const outroMoment = resolveActiveTimelineMoment(tl, panels, clock.getTime(), 2.0, 1.5);
  assert.equal(outroMoment.phase, 'outro');
  assert.equal(outroMoment.activeClipId, 'outro');

  // Зажим за пределами [0..duration]
  clock.seek(999);
  assert.equal(clock.getTime(), total);
  clock.seek(-10);
  assert.equal(clock.getTime(), 0);

  unsub();
  assert.ok(observed.length >= 5);
});

test('Stage 1 (2, 4): явные режимы расчёта таймлайна draft vs real, приоритет реальной длительности аудио', () => {
  const panel = makePanel(1, {
    dialogue: 'Очень длинная реплика для проверки черновой оценки длительности по числу символов текста',
  });

  // В режиме draft без реального аудио используется оценка по длине текста
  const draftDur = resolvePanelEffectiveDuration(panel, undefined, { mode: 'draft' });
  assert.equal(draftDur.isEstimated, true);
  assert.ok(draftDur.duration >= 2);

  // При наличии реальной длительности она всегда перекрывает текстовую оценку
  const realDur = resolvePanelEffectiveDuration(panel, { 1: 1.75 }, { mode: 'real', realDurations: { 1: 1.75 } });
  assert.equal(realDur.isEstimated, false);
  assert.equal(realDur.duration, 1.75);

  // С учётом trimIn / trimOut
  const trimmedPanel = makePanel(1, { trimIn: 0.25, trimOut: 0.5 });
  const trimmedDur = resolvePanelEffectiveDuration(trimmedPanel, { 1: 3.0 }, { mode: 'real', realDurations: { 1: 3.0 } });
  assert.equal(trimmedDur.duration, 2.25);
});

test('Stage 1 (3, 9): invalidateAndRebuildTimeline немедленно пересчитывает таймлайн, SRT и инкрементирует timelineVersion', () => {
  const panels = [makePanel(1, { dialogue: 'Первая фраза' }), makePanel(2, { dialogue: 'Вторая фраза' })];
  const baseProj = makeProject({
    panels,
    timelineVersion: 2,
    settings: {
      ttsProvider: 'google',
      llmProvider: 'openrouter',
      visionModel: 'google/gemini-2.5-flash',
      ttsSpeed: 1,
      musicVolume: 0.2,
      panelGap: 0.4,
    },
  });

  const initial = invalidateAndRebuildTimeline(baseProj, { 1: 2.5, 2: 3.5 }, { panelGap: 0.4 });
  assert.equal(initial.timelineVersion, 3);
  assert.ok(Math.abs(initial.timeline[0].audioStart - 2) < 1e-6);
  assert.ok(Math.abs(initial.timeline[0].audioEnd - 4.5) < 1e-6);
  assert.ok(Math.abs(initial.timeline[1].audioStart - 4.9) < 1e-6);
  assert.ok(Math.abs(initial.timeline[1].audioEnd - 8.4) < 1e-6);

  // Замена аудио длительности первой панели с 2.5с на 5.0с сразу сдвигает вторую панель и SRT
  const updated = invalidateAndRebuildTimeline(initial, { 1: 5.0, 2: 3.5 }, { panelGap: 0.4 });
  assert.equal(updated.timelineVersion, 4);
  assert.ok(Math.abs(updated.timeline[0].audioEnd - 7.0) < 1e-6);
  assert.ok(Math.abs(updated.timeline[1].audioStart - 7.4) < 1e-6);
  assert.ok(Math.abs(updated.timeline[1].audioEnd - 10.9) < 1e-6);

  const cues = parseSRTCues(updated.srt);
  assert.equal(cues.length, 4); // интро + 2 панели + аутро
  assert.ok(Math.abs(cues[1].start - 2.0) < 1e-3);
  assert.ok(Math.abs(cues[1].end - 7.0) < 1e-3);
  assert.ok(Math.abs(cues[2].start - 7.4) < 1e-3);
  assert.ok(Math.abs(cues[2].end - 10.9) < 1e-3);
});

test('Stage 1 (5) & Stage 8 (74): идемпотентная миграция схемы проекта migrateProjectSchema', () => {
  const legacyRaw = makeProject({
    id: 'legacy-proj-1',
    panels: [
      {
        id: 1,
        order: 0,
        imageIndex: 0,
        bbox: { x: 0, y: 0, width: 100, height: 100 },
        dialogue: 'Привет!',
        character: 'Алиса',
        emotion: 'happy',
        type: 'speech',
      },
    ],
    timeline: [],
    srt: '',
    intro: '',
    outro: '',
    introDuration: 0,
    outroDuration: 0,
  });

  const firstRun = migrateProjectSchema(legacyRaw);
  assert.equal(firstRun.migrated, true);
  assert.equal(firstRun.toSchemaVersion, 2);
  assert.equal(firstRun.toTimelineVersion, 2);
  assert.equal(firstRun.project.timeline.length, 1);
  assert.ok(firstRun.project.srt.includes('Привет!'));
  assert.ok(typeof firstRun.project.revision === 'number');

  // Повторный вызов на уже мигрированном проекте идемпотентен
  const secondRun = migrateProjectSchema(firstRun.project);
  assert.equal(secondRun.migrated, false);
  assert.deepEqual(secondRun.project.timeline, firstRun.project.timeline);
  assert.equal(secondRun.project.srt, firstRun.project.srt);
});

test('Stage 1 (6, 7, 8): валидаторы монотонности, отсутствия наложений, общей длительности и SRT', () => {
  const panels = [
    makePanel(1, { bbox: { x: 0, y: 0, width: 100, height: 30 } }),
    makePanel(2, { bbox: { x: 0, y: 30, width: 100, height: 40 } }),
  ];
  const rebuilt = rebuildSrt({
    panels,
    audioDurations: { 1: 2.0, 2: 3.0 },
    voiceAssignments: {},
    intro: 'Интро',
    outro: 'Аутро',
    introDuration: 1.5,
    outroDuration: 1.0,
    panelGap: 0.5,
    realDurations: { 1: 2.0, 2: 3.0 },
  });
  const claimedDuration = calculateTotalDuration(rebuilt.timeline, 1.5, 1.0);

  const validCheck = validateTimelineFull({
    panels,
    timeline: rebuilt.timeline,
    intro: 'Интро',
    outro: 'Аутро',
    introDuration: 1.5,
    outroDuration: 1.0,
    panelGap: 0.5,
    claimedDuration,
    srt: rebuilt.srt,
    realDurations: { 1: 2.0, 2: 3.0 },
  });
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.issues.length, 0);

  // Нарушение монотонности (наложение клипов)
  const overlappingTimeline = [
    { ...rebuilt.timeline[0], audioStart: 1.5, audioEnd: 4.5 },
    { ...rebuilt.timeline[1], audioStart: 3.5, audioEnd: 6.5 },
  ];
  const monoFail = validateTimelineMonotonicity(overlappingTimeline, 0.5, 1.5);
  assert.equal(monoFail.valid, false);
  assert.ok(monoFail.issues.some(i => i.code === 'MONOTONICITY_VIOLATION'));

  // Наложение реального аудио на следующий сегмент
  const audioOverlap = validateAudioNonOverlapping(rebuilt.timeline, { 1: 3.2, 2: 3.0 });
  assert.equal(audioOverlap.valid, false);
  assert.ok(audioOverlap.issues.some(i => i.code === 'BLOB_EXCEEDS_WINDOW'));

  // Расхождение заявленной длительности
  const durFail = validateTotalDuration(rebuilt.timeline, 1.5, 1.0, claimedDuration + 2.5, 0.5);
  assert.equal(durFail.valid, false);
  assert.ok(durFail.issues.some(i => i.code === 'DURATION_MISMATCH'));

  // Рассинхрон SRT и невалидный процентный диапазон
  const badSrt = generateSRT(overlappingTimeline, 'Интро', 'Аутро', 1.5, 1.0);
  const srtFail = validateSrtSync(rebuilt.timeline, badSrt, 'Интро', 'Аутро', 1.5, 1.0);
  assert.equal(srtFail.valid, false);

  const badPanels = [makePanel(1, { bbox: { x: 0, y: 80, width: 100, height: 35 } })];
  const pctFail = validatePanelPercentages(badPanels);
  assert.equal(pctFail.valid, false);
});

test('Stage 1 (10): интеграционный тест полного цикла (создание -> сценарий -> импорт аудио -> замена аудио -> совпадение превью/таймлайна/SRT)', () => {
  const scenarioText = [
    'Изображение 1 [0..40%]',
    'Алиса (Ж): Первый фрагмент диалога.',
    'Изображение 1 [40..100%]',
    'Боб (М): Второй фрагмент диалога.',
  ].join('\n');

  const parsed = parseScenario(scenarioText);
  assert.equal(parsed.errors.length, 0);

  const baseProject = makeProject({
    id: 'e2e-sync-proj',
    intro: 'Добро пожаловать',
    outro: 'Подписывайтесь',
    introDuration: 2.0,
    outroDuration: 1.5,
  });

  // 1. Применение сценария (черновой режим без аудио)
  const scenarioApplied = applyScenarioToProject(baseProject, parsed.lines, {
    imagesCount: 1,
    panelGap: 0.6,
    voiceAssignments: {},
  });
  assert.equal(scenarioApplied.panels.length, 2);
  assert.equal(scenarioApplied.timeline.length, 2);

  // 2. Импорт реальных аудиофайлов (длительности 3.2с и 4.8с)
  const p1Id = scenarioApplied.panels[0].id;
  const p2Id = scenarioApplied.panels[1].id;
  const afterImport = rebuildSrt({
    panels: scenarioApplied.panels,
    audioDurations: { [p1Id]: 3.2, [p2Id]: 4.8 },
    voiceAssignments: {},
    intro: baseProject.intro,
    outro: baseProject.outro,
    introDuration: 2.0,
    outroDuration: 1.5,
    panelGap: 0.6,
    realDurations: { [p1Id]: 3.2, [p2Id]: 4.8 },
  });
  assert.equal(afterImport.draft, false);
  assert.ok(Math.abs(afterImport.timeline[0].audioStart - 2.0) < 1e-6);
  assert.ok(Math.abs(afterImport.timeline[0].audioEnd - 5.2) < 1e-6);
  assert.ok(Math.abs(afterImport.timeline[1].audioStart - 5.8) < 1e-6);
  assert.ok(Math.abs(afterImport.timeline[1].audioEnd - 10.6) < 1e-6);

  // 3. Замена первого аудио на более длинное (6.0с)
  const afterReplace = rebuildSrt({
    panels: scenarioApplied.panels,
    audioDurations: { [p1Id]: 6.0, [p2Id]: 4.8 },
    voiceAssignments: {},
    intro: baseProject.intro,
    outro: baseProject.outro,
    introDuration: 2.0,
    outroDuration: 1.5,
    panelGap: 0.6,
    realDurations: { [p1Id]: 6.0, [p2Id]: 4.8 },
  });
  const finalTotal = calculateTotalDuration(afterReplace.timeline, 2.0, 1.5);
  assert.ok(Math.abs(finalTotal - (2.0 + 6.0 + 0.6 + 4.8 + 1.5)) < 1e-6);

  const fullValidation = validateTimelineFull({
    panels: scenarioApplied.panels,
    timeline: afterReplace.timeline,
    intro: baseProject.intro,
    outro: baseProject.outro,
    introDuration: 2.0,
    outroDuration: 1.5,
    panelGap: 0.6,
    claimedDuration: finalTotal,
    srt: afterReplace.srt,
    realDurations: { [p1Id]: 6.0, [p2Id]: 4.8 },
  });
  assert.equal(fullValidation.valid, true, JSON.stringify(fullValidation.issues));
});

test('Итерация 2 — Задача 1: ProjectClock — единственный источник времени и камеры, setCurrentTime вызывается только в clock.subscribe', () => {
  const src = readEditorSource();
  const lines = src.split('\n');
  const setCurrentTimeLines = lines
    .map((line, idx) => ({ line: line.trim(), num: idx + 1 }))
    .filter(item => item.line.includes('setCurrentTime('));

  assert.equal(
    setCurrentTimeLines.length,
    1,
    `Ожидался ровно 1 вызов setCurrentTime( внутри clock.subscribe, найдено: ${JSON.stringify(setCurrentTimeLines)}`
  );
  assert.equal(setCurrentTimeLines[0].line, 'setCurrentTime(snap.currentTime);');
  assert.equal(src.includes('playbackAudioRef'), false, 'Старый ручной цикл playbackAudioRef должен быть удалён');

  // Проверяем, что seek(3.7) мгновенно виден всем подписчикам ProjectClock (Timeline и Preview)
  const clock = new ProjectClock({ duration: 12, currentTime: 0 });
  let previewTime = 0;
  let timelineTime = 0;
  clock.subscribe(snap => {
    previewTime = snap.currentTime;
    timelineTime = snap.currentTime;
  });

  clock.seek(3.7, 'seek');
  assert.equal(clock.getTime(), 3.7);
  assert.equal(previewTime, 3.7);
  assert.equal(timelineTime, 3.7);
});

test('Итерация 2 — Задача 2: timelineVersion монотонно растёт на +1 при каждой пересборке (5 подряд: 2 -> 3 -> 4 -> 5 -> 6 -> 7)', () => {
  const panels = [makePanel(1, { dialogue: 'Реплика 1' }), makePanel(2, { dialogue: 'Реплика 2' })];
  let proj = makeProject({ panels, timelineVersion: 2 });

  const versions: number[] = [proj.timelineVersion!];
  for (let step = 1; step <= 5; step++) {
    proj = invalidateAndRebuildTimeline(proj, { 1: 2.0 + step * 0.5, 2: 3.0 }, { panelGap: 0.3 + step * 0.05 });
    versions.push(proj.timelineVersion!);
  }
  assert.deepEqual(versions, [2, 3, 4, 5, 6, 7]);

  // applyScenarioToProject также инкрементирует timelineVersion
  const parsed = parseScenario('Изображение 1\nАлиса (Ж): Новая реплика');
  const scenarioPatch = applyScenarioToProject(proj, parsed.lines, {
    imagesCount: 1,
    panelGap: 0.6,
    voiceAssignments: {},
  });
  assert.equal(scenarioPatch.timelineVersion, 8);
});

test('Итерация 2 — Задача 4: resolvePanelEffectiveDuration без мёртвой ветки (приоритет durationOverride > realDurations > audioDurations > estimateDuration)', () => {
  const panel = makePanel(1, { dialogue: 'Короткий текст' });

  // 1. audioDurations = {1: 4.0}, realDurations = {} -> isEstimated: true, duration: 4.0
  const fallbackFromMap = resolvePanelEffectiveDuration(panel, { 1: 4.0 }, { mode: 'draft', realDurations: {} });
  assert.equal(fallbackFromMap.isEstimated, true);
  assert.equal(fallbackFromMap.duration, 4.0);

  // 2. realDurations = {1: 4.0} -> isEstimated: false, duration: 4.0
  const fromReal = resolvePanelEffectiveDuration(panel, { 1: 4.0 }, { mode: 'real', realDurations: { 1: 4.0 } });
  assert.equal(fromReal.isEstimated, false);
  assert.equal(fromReal.duration, 4.0);

  // 3. mode: 'real' без реальной длительности бросает ошибку
  assert.throws(
    () => resolvePanelEffectiveDuration(panel, { 1: 4.0 }, { mode: 'real', realDurations: {} }),
    /отсутствует реальная длительность аудио/
  );
});

test('Итерация 2 — Задача 12 и P1 (2, 11): introDuration/outroDuration = длительность аудио, resolveActiveTimelineMoment при outroDuration=0 и многострочный parseSRTCues с CRLF', () => {
  const panels = [makePanel(1, { dialogue: 'Первая строка\nВторая строка' })];
  const baseProj = makeProject({ panels, introDuration: 8, outroDuration: 5, timelineVersion: 2 });

  // Импорт интро-аудио 3.42 с и аутро-аудио 2.18 с устанавливает introDuration = 3.42, outroDuration = 2.18
  const rebuilt = invalidateAndRebuildTimeline(
    baseProj,
    { 1: 2.5 },
    {
      introAudioDuration: roundMediaDuration(3.423),
      outroAudioDuration: roundMediaDuration(2.181),
    }
  );
  assert.equal(rebuilt.introDuration, 3.42);
  assert.equal(rebuilt.outroDuration, 2.18);
  assert.ok(Math.abs(rebuilt.timeline[0].audioStart - 3.42) < 1e-6);
  assert.equal(rebuilt.timelineVersion, 3);

  // Итерация 2.1 (Б3, P1 п. 12): resolveActiveTimelineMoment при t >= lastEnd и outroDuration === 0
  // явно возвращает phase: 'panel', activeSegment: null, displaySegment: lastSeg
  const momentAtEnd = resolveActiveTimelineMoment(rebuilt.timeline, panels, rebuilt.timeline[0].audioEnd, 3.42, 0);
  assert.equal(momentAtEnd.phase, 'panel');
  assert.equal(momentAtEnd.activeSegment, null);
  assert.equal(momentAtEnd.displaySegment?.panelId, 1);
  assert.equal(momentAtEnd.activePanelId, 1);

  const momentAfterEnd = resolveActiveTimelineMoment(rebuilt.timeline, panels, rebuilt.timeline[0].audioEnd + 0.5, 3.42, 0);
  assert.equal(momentAfterEnd.phase, 'panel');
  assert.equal(momentAfterEnd.activeSegment, null);
  assert.equal(momentAfterEnd.displaySegment?.panelId, 1);

  // P1 п. 9 и п. 11: parseSRTCues поддерживает UTF-8 BOM (\uFEFF), многострочный текст и \r\n
  const crlfSrt = '\uFEFF10\r\n00:00:00,000 --> 00:00:02,500\r\nСтрока 1\r\nСтрока 2\r\n\r\n20\r\n00:00:03,000 --> 00:00:05,000\r\nФинал\r\n';
  const parsedCues = parseSRTCues(crlfSrt);
  assert.equal(parsedCues.length, 2);
  assert.equal(parsedCues[0].index, 10);
  assert.equal(parsedCues[0].text, 'Строка 1\nСтрока 2');
  assert.equal(parsedCues[1].index, 20);
  assert.equal(parsedCues[1].text, 'Финал');
});

