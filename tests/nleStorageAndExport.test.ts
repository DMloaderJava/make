import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fixtures/browserEnv';
import {
  applyRippleEdit,
  assertTrackUnlocked,
  collectSnapTargets,
  isClipEffectivelyMuted,
  reorderPanelClips,
  setPanelAudioGainAndFades,
  setPanelAudioTrim,
  setPanelDurationOverride,
  snapTimeToTargets,
  splitPanelAudioClip,
  togglePanelMute,
  togglePanelSolo,
} from '../src/lib/pipeline/nleOperations';
import { HistoryManager } from '../src/lib/pipeline/historyManager';
import {
  appendProjectEvent,
  getProject,
  saveProject,
  StaleProjectRevisionError,
  type PanelData,
  type Project,
  type SyncTimeline,
} from '../src/lib/storage/db';
import {
  beginImportJournal,
  checkStorageQuotaBeforeImport,
  completeImportJournal,
  computeBlobSha256,
  createResourceManifestEntry,
  recordImportJournalStep,
  recoverInterruptedImport,
  verifyProjectManifest,
} from '../src/lib/storage/resourceIntegrity';
import {
  decodeZipArchive,
  encodeZipArchive,
  exportProjectToZip,
  importProjectFromZip,
} from '../src/lib/storage/projectArchive';
import {
  applyEnvelopeAndTrimToChannelData,
  assertValidPackedPlacements,
  buildTimelineAudioPlacements,
  clearBufferCache,
  mixAudioPlacements,
} from '../src/lib/pipeline/audioMix';
import {
  buildDiagnosticReportJson,
  formatClipTooltip,
  formatGapTooltip,
  formatRangeTooltip,
  inspectProjectHealth,
} from '../src/lib/pipeline/projectHealth';
import { pcmToWav } from '../src/lib/providers/tts/wav';
import { invalidateAndRebuildTimeline, parseSRTCues } from '../src/lib/pipeline/buildTimeline';
import { parseScenario, applyScenarioToProject } from '../src/lib/pipeline/scenario';
import { ProjectClock } from '../src/lib/pipeline/projectClock';
import { computePanelCameraDrawRect, sampleCameraFrame } from '../src/lib/pipeline/cameraSampler';
import { renderExportFrameToCanvas } from '../src/lib/pipeline/assembleVideo';
import { buildStripScrollSpans, cameraYForSpan, createStripScene } from '../src/lib/pipeline/mangaStrip';
import {
  computeDragDropReorderTarget,
  computeTrimHandleUpdate,
  createTimelinePointerController,
} from '../src/lib/pipeline/timelineDrag';
import fs from 'node:fs';
import path from 'node:path';

function makePanel(id: number, overrides: Partial<PanelData> = {}): PanelData {
  return {
    id,
    order: id - 1,
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 60 },
    dialogue: `Первая часть реплики номер ${id} и вторая часть реплики`,
    character: 'Герой',
    emotion: 'neutral',
    type: 'speech',
    ...overrides,
  };
}

function makeSeg(overrides: Partial<SyncTimeline> & { panelId: number; imageIndex: number; audioStart: number; audioEnd: number }): SyncTimeline {
  return {
    panelBbox: { x: 0, y: 0, width: 100, height: 60 },
    voiceId: 'default',
    text: `Реплика ${overrides.panelId}`,
    character: 'Герой',
    ...overrides,
  };
}

function makeTestWavBlob(durationSec = 1.0, sampleRate = 8000): Blob {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const pcm = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) pcm[i] = 4000;
  const pcmAb = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
  const wav = pcmToWav(pcmAb, { sampleRate, channels: 1, bitsPerSample: 16 });
  return new Blob([wav], { type: 'audio/wav' });
}

test('Stage 6 (51–60): NLE редактирование (reorder, trim, split, durationOverride, ripple edit, track lock, mute/solo, gain/fade, snap, HistoryManager Undo/Redo)', () => {
  const panels = [
    makePanel(1, { order: 0, bbox: { x: 0, y: 0, width: 100, height: 40 } }),
    makePanel(2, { order: 1, bbox: { x: 0, y: 40, width: 100, height: 60 } }),
  ];
  const durs = { 1: 4.0, 2: 3.0 };

  // 1. Изменение порядка клипов (п. 51)
  const reordered = reorderPanelClips(panels, durs, 2, 0, { panelGap: 0.5 });
  assert.equal(reordered.panels[0].id, 2);
  assert.equal(reordered.panels[1].id, 1);
  assert.equal(reordered.timeline[0].panelId, 2);
  assert.equal(reordered.timeline[0].audioStart, 0);
  assert.equal(reordered.timeline[0].audioEnd, 3.0);
  assert.equal(reordered.timeline[1].audioStart, 3.5);
  assert.equal(reordered.timeline[1].audioEnd, 7.5);

  // 2. Trim in / trim out и Ripple Edit (п. 52, 55)
  const trimmed = setPanelAudioTrim(panels, durs, 1, 0.5, 1.0, { panelGap: 0.5 });
  assert.equal(trimmed.panels[0].trimIn, 0.5);
  assert.equal(trimmed.panels[0].trimOut, 1.0);
  assert.equal(trimmed.timeline[0].audioEnd - trimmed.timeline[0].audioStart, 2.5);
  assert.equal(trimmed.timeline[1].audioStart, 3.0); // сдвинулся без наложений

  // 3. Split аудиоклипа на два связанных сегмента (п. 53)
  const splitRes = splitPanelAudioClip(panels, durs, 1, 1.5, { panelGap: 0.4 });
  assert.equal(splitRes.panels.length, 3);
  assert.ok(splitRes.createdPanelId !== undefined);
  const segA = splitRes.panels[0];
  const segB = splitRes.panels[1];
  assert.equal(segB.sourceAudioPanelId, 1);
  assert.equal(segA.bbox.y, 0);
  assert.ok(segB.bbox.y > 0);
  assert.ok(Math.abs((splitRes.timeline[0].audioEnd - splitRes.timeline[0].audioStart) - 1.5) < 1e-6);
  assert.ok(Math.abs((splitRes.timeline[1].audioEnd - splitRes.timeline[1].audioStart) - 2.5) < 1e-6);

  // 4. Независимая длительность показа изображения durationOverride (п. 54)
  const overridden = setPanelDurationOverride(panels, durs, 1, 6.0, { panelGap: 0.5 });
  assert.equal(overridden.panels[0].durationOverride, 6.0);
  assert.equal(overridden.timeline[0].audioEnd - overridden.timeline[0].audioStart, 6.0);
  assert.equal(overridden.timeline[1].audioStart, 6.5);

  // 5. Блокировка дорожки (п. 56)
  assert.throws(
    () => assertTrackUnlocked({ audioTrackLocked: true }, 'audio'),
    /Аудиодорожка заблокирована/
  );
  assert.throws(
    () => assertTrackUnlocked({ videoTrackLocked: true }, 'video'),
    /Видеодорожка заблокирована/
  );

  // 6. Mute / Solo и Gain / FadeIn / FadeOut (п. 57, 58)
  const mutedRes = togglePanelMute(panels, durs, 1, true);
  assert.equal(mutedRes.panels[0].muted, true);
  assert.equal(isClipEffectivelyMuted(mutedRes.panels[0], mutedRes.panels), true);

  const soloRes = togglePanelSolo(panels, durs, 2, true);
  assert.equal(isClipEffectivelyMuted(soloRes.panels[0], soloRes.panels), true);
  assert.equal(isClipEffectivelyMuted(soloRes.panels[1], soloRes.panels), false);

  const gainedRes = setPanelAudioGainAndFades(panels, durs, 1, {
    gain: 1.4,
    fadeIn: 0.2,
    fadeOut: 0.3,
  });
  assert.equal(gainedRes.panels[0].gain, 1.4);
  assert.equal(gainedRes.panels[0].fadeIn, 0.2);
  assert.equal(gainedRes.panels[0].fadeOut, 0.3);

  // 7. Snapping к границам сегментов и смене страниц (п. 59)
  const targets = collectSnapTargets(reordered.timeline, 0, 7.5);
  const snapped = snapTimeToTargets(3.04, targets, 0.1);
  assert.equal(snapped.snapped, true);
  assert.equal(snapped.time, 3.0);

  // 8. Детерминированный стек истории Undo / Redo (п. 60)
  const history = new HistoryManager(20);
  const initialRipple = applyRippleEdit(panels, durs, { panelGap: 0.5 });
  history.record({
    label: 'Initial',
    timestamp: 1,
    panels: initialRipple.panels,
    audioDurations: initialRipple.audioDurations,
    timeline: initialRipple.timeline,
    srt: initialRipple.srt,
  });

  const currentAfterTrim = {
    label: 'After trim',
    timestamp: 2,
    panels: trimmed.panels,
    audioDurations: trimmed.audioDurations,
    timeline: trimmed.timeline,
    srt: trimmed.srt,
  };
  const undone = history.undo(currentAfterTrim);
  assert.ok(undone);
  assert.equal(undone.timeline[0].audioEnd - undone.timeline[0].audioStart, 4.0);

  const redone = history.redo(undone);
  assert.ok(redone);
  assert.equal(redone.timeline[0].audioEnd - redone.timeline[0].audioStart, 2.5);
});

test('Stage 8 (71–80): атомарное сохранение, оптимистическая блокировка revision, SHA-256 манифест, проверка квоты, ImportJournal и round-trip экспорта/импорта ZIP-архива', async () => {
  const wavBlob = makeTestWavBlob(1.2);
  const sha = await computeBlobSha256(wavBlob);
  assert.equal(sha.length, 64);

  // 1. Оптимистическая блокировка по revision (п. 71, 80)
  const baseProject: Project = {
    id: 'proj-storage-1',
    name: 'Storage Test Project',
    createdAt: 1000,
    updatedAt: 1000,
    images: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='],
    panels: [makePanel(1, { audioSource: 'import', audioFileName: '001.wav', audioSha256: sha })],
    characters: [{ name: 'Герой', gender: 'male', appearance: '', voiceId: 'default', emotion: 'neutral' }],
    voiceAssignments: {},
    timeline: [
      makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 1.2 }),
    ],
    srt: '1\n00:00:00,000 --> 00:00:01,200\nГерой: Тест\n',
    intro: '',
    outro: '',
    introDuration: 0,
    outroDuration: 0,
    seoPackage: null,
    audioDurations: { 1: 1.2 },
    settings: {
      ttsProvider: 'google',
      llmProvider: 'openrouter',
      visionModel: 'google/gemini-2.5-flash',
      ttsSpeed: 1,
      musicVolume: 0.2,
      panelGap: 0.3,
    },
  };

  const savedV1 = await saveProject(baseProject);
  assert.equal(savedV1.revision, 1);

  const savedV2 = await saveProject(savedV1, { expectedRevision: 1 });
  assert.equal(savedV2.revision, 2);

  // Попытка сохранить устаревшую вкладку с expectedRevision=1 бросает StaleProjectRevisionError
  await assert.rejects(
    () => saveProject(savedV1, { expectedRevision: 1 }),
    StaleProjectRevisionError
  );

  const fetched = await getProject('proj-storage-1');
  assert.ok(fetched);
  assert.equal(fetched.revision, 2);

  // 2. Проверка квоты перед импортом (п. 78)
  const quotaOk = await checkStorageQuotaBeforeImport(1024 * 1024, {
    estimate: async () => ({ usage: 10 * 1024 * 1024, quota: 500 * 1024 * 1024 }),
  });
  assert.equal(quotaOk.ok, true);

  const quotaBlocked = await checkStorageQuotaBeforeImport(50 * 1024 * 1024, {
    estimate: async () => ({ usage: 480 * 1024 * 1024, quota: 500 * 1024 * 1024 }),
  });
  assert.equal(quotaBlocked.ok, false);
  assert.ok(quotaBlocked.blockedReason?.includes('Недостаточно места'));

  // 3. Восстановление незавершённого импорта из ImportJournal (п. 79)
  beginImportJournal('proj-storage-1', ['001.wav', '002.wav']);
  recordImportJournalStep('proj-storage-1', {
    fileName: '001.wav',
    panelId: 1,
    sha256: sha,
  });
  const recovery = recoverInterruptedImport('proj-storage-1');
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.completedCount, 1);
  assert.deepEqual(recovery.remainingFiles, ['002.wav']);

  // 4. Полный round-trip экспорта и импорта проекта в .zip с проверкой контрольных сумм SHA-256 (п. 72, 73, 76, 77, 80)
  const { blob: zipBlob, manifest } = await exportProjectToZip(savedV2, {
    images: savedV2.images,
    audio: new Map([[1, wavBlob]]),
  });
  assert.ok(zipBlob.size > 100);
  assert.ok(manifest.entries['audio:1']);

  const restored = await importProjectFromZip(zipBlob);
  assert.equal(restored.project.id, savedV2.id);
  assert.equal(restored.verifiedCount, 2); // 1 картинка + 1 аудио
  assert.equal(restored.images.size, 1);
  assert.equal(restored.audio.size, 1);
  assert.equal(restored.project.panels.length, 1);
  assert.equal(restored.project.timeline.length, 1);

  // Верификация ресурсов по манифесту
  const manifestEntry = await createResourceManifestEntry({
    id: 'audio:1',
    path: 'audio/1.mp3',
    fileName: '001.wav',
    blob: wavBlob,
    originalMime: 'audio/wav',
    normalizedMime: 'audio/wav',
    role: 'panel-audio',
    panelId: 1,
  });
  const verifyRes = await verifyProjectManifest(
    { 'audio:1': manifestEntry },
    async () => restored.audio.get(1) ?? null
  );
  assert.equal(verifyRes.valid, true);

  // Повреждение байтов внутри ZIP-архива обнаруживается по CRC32 / SHA-256
  const rawEntries = decodeZipArchive(new Uint8Array(await zipBlob.arrayBuffer()));
  const tamperedAudio = new Uint8Array(rawEntries.get('audio/1.mp3')!);
  tamperedAudio[tamperedAudio.length - 1] ^= 0xff;
  rawEntries.set('audio/1.mp3', tamperedAudio);
  const tamperedZipBytes = encodeZipArchive(
    [...rawEntries.entries()].map(([path, data]) => ({ path, data }))
  );
  await assert.rejects(
    () => importProjectFromZip(tamperedZipBytes),
    /SHA-256/
  );
});

test('Stage 9 (81–90) & Stage 10 (91–100): микширование trim/gain/fade/mute/solo, inspectProjectHealth, предупреждения <0.2s и >60s, диагностический JSON, тултипы и журнал событий', () => {
  // 1. Применение trimIn/trimOut, gain, fadeIn/fadeOut к сэмплам аудио (п. 83)
  const sampleRate = 1000;
  const rawSamples = new Float32Array(2000).fill(0.5); // 2.0 с
  const processed = applyEnvelopeAndTrimToChannelData(rawSamples, sampleRate, {
    trimIn: 0.5,
    trimOut: 0.5,
    gain: 1.5,
    fadeIn: 0.1,
    fadeOut: 0.1,
  });
  // После обрезки по 0.5с с краёв остаётся ровно 1.0с (1000 сэмплов)
  assert.equal(processed.length, 1000);
  // В начале fadeIn первый сэмпл равен 0, в середине — 0.5 * 1.5 = 0.75
  assert.equal(processed[0], 0);
  assert.ok(Math.abs(processed[500] - 0.75) < 1e-3);

  // 2. Сборка аудио-размещений с учётом импортированного аудио без TTS, mute/solo и trim (п. 82, 83)
  const blob1 = makeTestWavBlob(2.0);
  const blob2 = makeTestWavBlob(3.0);
  const panels: PanelData[] = [
    makePanel(1, { audioSource: 'import', audioFileName: 'imp1.wav', trimIn: 0.2, gain: 1.2, solo: true }),
    makePanel(2, { audioSource: 'tts', solo: false }),
  ];
  const timeline: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 1.8 }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 2.1, audioEnd: 5.1 }),
  ];
  const placements = buildTimelineAudioPlacements({
    timeline,
    panels,
    panelBlobs: new Map([
      [1, blob1],
      [2, blob2],
    ]),
  });
  // Из-за solo на первой панели оба размещения присутствуют в массиве, но вторая панель помечена muted: true (Задача 5)
  assert.equal(placements.length, 2);
  assert.equal(placements[0].panelId, 1);
  assert.equal(placements[0].muted, false);
  assert.equal(placements[0].trimIn, 0.2);
  assert.equal(placements[0].gain, 1.2);
  assert.equal(placements[1].panelId, 2);
  assert.equal(placements[1].muted, true);

  // 3. Проверка здоровья проекта inspectProjectHealth + предупреждения о клипах < 0.2s и > 60s (п. 84–86, 89, 91–93)
  const shortAndLongTimeline: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 0.1 }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 0.4, audioEnd: 65.4 }),
  ];
  const health = inspectProjectHealth({
    panels,
    timeline: shortAndLongTimeline,
    availableImageIndices: [0],
    voicedPanelIds: [1, 2],
    realDurations: { 1: 0.1, 2: 65.0 },
    panelGap: 0.3,
  });
  assert.ok(health.issues.some(i => i.code === 'CLIP_TOO_SHORT'));
  assert.ok(health.issues.some(i => i.code === 'CLIP_TOO_LONG'));
  assert.equal(health.exactDuration, 65.4);

  // 4. Генерация диагностического JSON-отчёта и журнал событий (п. 88, 94, 99)
  const events = appendProjectEvent([], {
    type: 'health-check',
    summary: 'Выполнена комплексная проверка проекта',
  });
  assert.equal(events.length, 1);

  const diagJson = buildDiagnosticReportJson(
    {
      id: 'diag-1',
      name: 'Diag Project',
      schemaVersion: 2,
      timelineVersion: 2,
      revision: 3,
      panels,
      timeline: shortAndLongTimeline,
      audioDurations: { 1: 0.1, 2: 65.0 },
      resourceManifest: {},
      eventLog: events,
    },
    health
  );
  const parsedDiag = JSON.parse(diagJson);
  assert.equal(parsedDiag.projectId, 'diag-1');
  assert.equal(parsedDiag.exactDuration, 65.4);
  assert.equal(parsedDiag.eventLog.length, 1);

  // 5. Тултипы для диапазонов [X..Y%], клипов и пауз (п. 94)
  assert.ok(formatRangeTooltip(0, 30, 1).includes('[0..30%]'));
  assert.ok(formatClipTooltip({ panelId: 1, imageNumber: 1, audioStart: 0, audioEnd: 2.5, source: 'import', fileName: '001.wav' }).includes('Импорт'));
  assert.ok(formatGapTooltip(0.6, 1).includes('0.60'));
});

test('Итерация 2 — Задача 3: оптимистическая блокировка в saveProject (первое сохранение с устаревшим expectedRevision и конкурентный Promise.all)', async () => {
  const makeBaseProj = (id: string, revision: number): Project => ({
    id,
    name: `Proj ${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    images: [],
    panels: [],
    intro: '',
    outro: '',
    introDuration: 0,
    outroDuration: 0,
    characters: [],
    voiceAssignments: {},
    settings: {
      ttsProvider: 'google',
      llmProvider: 'openrouter',
      visionModel: 'google/gemini-2.5-flash',
      ttsSpeed: 1,
      musicVolume: 0.2,
      panelGap: 0.6,
    },
    timeline: [],
    seoPackage: null,
    srt: '',
    revision,
  });

  // 1. Сохранение проекта с revision: 5 и expectedRevision: 1 в пустую БД бросает StaleProjectRevisionError
  await assert.rejects(
    () => saveProject(makeBaseProj('stale-empty-db', 5), { expectedRevision: 1 }),
    (err: unknown) => err instanceof StaleProjectRevisionError
  );

  // 2. Два параллельных saveProject с одинаковым expectedRevision: 1 -> один проходит, второй отклоняется, итоговая ревизия = 2
  const initialProj = makeBaseProj('concurrent-lock-db', 0);
  await saveProject(initialProj); // сохраняет revision = 1
  const loaded = await getProject('concurrent-lock-db');
  assert.equal(loaded?.revision, 1);

  const p1: Project = { ...loaded!, name: 'Concurrent Variant A' };
  const p2: Project = { ...loaded!, name: 'Concurrent Variant B' };

  const results = await Promise.allSettled([
    saveProject(p1, { expectedRevision: 1 }),
    saveProject(p2, { expectedRevision: 1 }),
  ]);

  const fulfilled = results.filter(r => r.status === 'fulfilled');
  const rejected = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(fulfilled.length, 1, 'Ровно одно конкурентное сохранение должно завершиться успешно');
  assert.equal(rejected.length, 1, 'Второе конкурентное сохранение должно быть отклонено');
  assert.ok(rejected[0].reason instanceof StaleProjectRevisionError);

  const finalLoaded = await getProject('concurrent-lock-db');
  assert.equal(finalLoaded?.revision, 2);
});

test('Итерация 2 — Задача 5 и Задача 12: buildTimelineAudioPlacements включает outroAudio с muted: hasSolo и подрезает maxPlayDuration при ручном уменьшении длительности', async () => {
  const introBlob = makeTestWavBlob(3.0);
  const panelBlob = makeTestWavBlob(2.5);
  const outroBlob = makeTestWavBlob(4.0);

  const panels: PanelData[] = [
    makePanel(1, { solo: true }),
    makePanel(2, { solo: false }),
  ];
  const timeline: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 2.0, audioEnd: 4.5 }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 5.0, audioEnd: 7.5 }),
  ];

  const placements = buildTimelineAudioPlacements({
    timeline,
    panels,
    panelBlobs: new Map([
      [1, panelBlob],
      [2, panelBlob],
    ]),
    introAudio: introBlob,
    introDuration: 2.0, // вручную уменьшено с 3.0 до 2.0 с
    outroAudio: outroBlob,
    outroDuration: 2.5, // вручную уменьшено с 4.0 до 2.5 с
  });

  // Все 4 размещения (intro, panel 1, panel 2, outro) присутствуют
  assert.equal(placements.length, 4);
  const introPl = placements.find(p => p.start === 0)!;
  const p1Pl = placements.find(p => p.panelId === 1)!;
  const p2Pl = placements.find(p => p.panelId === 2)!;
  const outroPl = placements.find(p => p.start === 7.5)!;

  assert.ok(introPl);
  assert.ok(outroPl);
  assert.equal(introPl.muted, true, 'При solo на панели интро должно быть muted: true');
  assert.equal(p1Pl.muted, false, 'Панель с solo должна быть muted: false');
  assert.equal(p2Pl.muted, true, 'Панель без solo должна быть muted: true');
  assert.equal(outroPl.muted, true, 'При solo на панели аутро должно быть muted: true');

  // Проверяем maxPlayDuration при ручном уменьшении introDuration / outroDuration
  assert.equal(introPl.maxPlayDuration, 2.0);
  assert.equal(outroPl.maxPlayDuration, 2.5);

  // Проверяем физическую подрезку сэмплов по maxPlayDuration (3.0 с -> 2.0 с)
  const raw3s = new Float32Array(3000).fill(0.5);
  const trimmedIntroSamples = applyEnvelopeAndTrimToChannelData(raw3s, 1000, {
    maxPlayDuration: introPl.maxPlayDuration,
  });
  assert.equal(trimmedIntroSamples.length, 2000);

  // Проверяем, что applyEnvelopeAndTrimToChannelData обнуляет сэмплы для muted: true (напр. outro при solo на панели)
  const mutedOutroSamples = applyEnvelopeAndTrimToChannelData(raw3s, 1000, {
    muted: outroPl.muted,
    maxPlayDuration: outroPl.maxPlayDuration,
  });
  assert.equal(mutedOutroSamples.length, 2500);
  assert.ok(mutedOutroSamples.every(v => v === 0));
});

test('Итерация 2 — Задача 6: единообразное обновление состояния во всех 7 NLE-обработчиках EditorPage через applyNleResult', () => {
  const editorSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/app/editor/[id]/page.tsx'), 'utf-8');
  // Проверяем, что каждый из 7 именованных NLE-обработчиков EditorPage вызывает applyNleResult(res)
  const expectedNleHandlers = [
    'handleSplitActiveClip',
    'handleReorderClip',
    'handleTogglePanelMute',
    'handleTogglePanelSolo',
    'handleSetPanelAudioTrim',
    'handleSetPanelDurationOverride',
    'handleSetPanelAudioGainAndFades',
  ];
  for (const handlerName of expectedNleHandlers) {
    const startIdx = editorSrc.indexOf(`const ${handlerName} =`);
    assert.ok(startIdx !== -1, `Обработчик ${handlerName} должен быть объявлен в EditorPage`);
    const bodySlice = editorSrc.slice(startIdx, startIdx + 1200);
    assert.ok(
      bodySlice.includes('applyNleResult(res)'),
      `Обработчик ${handlerName} должен вызывать applyNleResult(res)`
    );
  }
  const applyMatches = editorSrc.match(/applyNleResult\(/g) ?? [];
  assert.equal(
    applyMatches.length,
    7, // 7 вызовов в NLE-обработчиках
    `Ожидалось 7 вызовов applyNleResult в NLE-обработчиках EditorPage, найдено ${applyMatches.length}`
  );
  // Также проверяем, что handleApplyScenario прокидывает timelineVersion: patch.timelineVersion
  assert.ok(
    editorSrc.includes('timelineVersion: patch.timelineVersion'),
    'handleApplyScenario в EditorPage должен передавать timelineVersion: patch.timelineVersion в updateProject'
  );

  // Проверяем идентичный контракт для всех 7 NLE-операций: panels, audioDurations, timeline, srt, timelineVersion
  const basePanels = [
    makePanel(1, { order: 0, dialogue: 'Первая реплика один два три четыре пять' }),
    makePanel(2, { order: 1, dialogue: 'Вторая реплика шесть семь восемь девять' }),
  ];
  const baseDurs = { 1: 4.0, 2: 3.0 };
  const nleOpts = {
    panelGap: 0.5,
    introDuration: 1.0,
    outroDuration: 1.0,
    intro: 'Интро',
    outro: 'Аутро',
  };

  const r1 = setPanelAudioTrim(basePanels, baseDurs, 1, 0.5, 0.5, { ...nleOpts, currentTimelineVersion: 2 });
  assert.equal(r1.timelineVersion, 3);
  assert.equal(r1.audioDurations[1], 4.0);
  assert.equal(r1.timeline[0].audioEnd - r1.timeline[0].audioStart, 3.0);
  assert.equal(parseSRTCues(r1.srt).length, 4); // intro + 2 panels + outro

  const r2 = setPanelDurationOverride(r1.panels, r1.audioDurations, 2, 5.0, { ...nleOpts, currentTimelineVersion: r1.timelineVersion });
  assert.equal(r2.timelineVersion, 4);
  assert.equal(r2.timeline[1].audioEnd - r2.timeline[1].audioStart, 5.0);

  const r3 = setPanelAudioGainAndFades(
    r2.panels,
    r2.audioDurations,
    1,
    { gain: 1.4, fadeIn: 0.2, fadeOut: 0.3 },
    { ...nleOpts, currentTimelineVersion: r2.timelineVersion }
  );
  assert.equal(r3.timelineVersion, 5);
  assert.equal(r3.panels[0].gain, 1.4);

  const r4 = togglePanelMute(r3.panels, r3.audioDurations, 1, undefined, { ...nleOpts, currentTimelineVersion: r3.timelineVersion });
  assert.equal(r4.timelineVersion, 6);
  assert.equal(r4.panels[0].muted, true);

  const r5 = togglePanelSolo(r4.panels, r4.audioDurations, 2, undefined, { ...nleOpts, currentTimelineVersion: r4.timelineVersion });
  assert.equal(r5.timelineVersion, 7);
  assert.equal(r5.panels[1].solo, true);

  const r6 = reorderPanelClips(r5.panels, r5.audioDurations, 2, 0, { ...nleOpts, currentTimelineVersion: r5.timelineVersion });
  assert.equal(r6.timelineVersion, 8);
  assert.equal(r6.panels[0].id, 2);

  const r7 = splitPanelAudioClip(r6.panels, r6.audioDurations, 2, 1.5, { ...nleOpts, currentTimelineVersion: r6.timelineVersion });
  assert.equal(r7.timelineVersion, 9);
  assert.equal(r7.panels.length, 3);
});

test('Итерация 2 — P1 (6, 7, 15, 16, 17, 18): квота без estimate, идемпотентный recoverInterruptedImport, ZIP round-trip (NLE/imageFiles/durationOverride) и сквозной интеграционный цикл', async () => {
  // P1 п. 6: checkStorageQuotaBeforeImport при отсутствии estimate возвращает estimateAvailable: false
  const quotaUnavailable = await checkStorageQuotaBeforeImport(1024, {
    estimate: async () => {
      throw new Error('Not supported');
    },
  });
  assert.equal(quotaUnavailable.ok, true);
  assert.equal(quotaUnavailable.estimateAvailable, false);

  // P1 п. 7: recoverInterruptedImport не удаляет журнал до явного вызова completeImportJournal
  beginImportJournal('proj-journal-1', ['1.mp3', '2.mp3']);
  recordImportJournalStep('proj-journal-1', { fileName: '1.mp3', panelId: 1, sha256: 'abc' });
  const firstRecover = recoverInterruptedImport('proj-journal-1');
  assert.equal(firstRecover.recovered, true);
  assert.equal(firstRecover.completedCount, 1);
  assert.deepEqual(firstRecover.remainingFiles, ['2.mp3']);
  const secondRecover = recoverInterruptedImport('proj-journal-1');
  assert.equal(secondRecover.recovered, true, 'Повторный вызов recoverInterruptedImport до завершения восстановления должен видеть тот же журнал');
  completeImportJournal('proj-journal-1');
  assert.equal(recoverInterruptedImport('proj-journal-1').recovered, false);

  // P1 п. 15, 16, 17: ZIP round-trip сохраняет durationOverride, trimIn/out, muted, solo, gain, fadeIn/out и нормализует имена imageFiles
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const audBlob = makeTestWavBlob(2.5);
  const zipProject: Project = {
    id: 'zip-roundtrip-p1',
    name: 'ZIP Roundtrip P1',
    createdAt: 1000,
    updatedAt: 1000,
    images: [pngDataUrl],
    imageFiles: ['page_custom_01.png'],
    panels: [
      makePanel(1, {
        order: 0,
        imageIndex: 0,
        durationOverride: 4.2,
        trimIn: 0.15,
        trimOut: 0.25,
        muted: false,
        solo: true,
        gain: 1.35,
        fadeIn: 0.1,
        fadeOut: 0.2,
        audioSource: 'import',
        audioFileName: '001.wav',
      }),
    ],
    audioDurations: { 1: 4.2 },
    intro: 'Старт',
    outro: 'Финиш',
    introDuration: 1.5,
    outroDuration: 1.0,
    characters: [],
    voiceAssignments: {},
    settings: {
      ttsProvider: 'google',
      llmProvider: 'openrouter',
      visionModel: 'google/gemini-2.5-flash',
      ttsSpeed: 1,
      musicVolume: 0.2,
      panelGap: 0.5,
    },
    timeline: [
      makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.5, audioEnd: 5.7 }),
    ],
    seoPackage: null,
    srt: '',
    timelineVersion: 3,
  };

  const { blob: exportedZip } = await exportProjectToZip(zipProject, {
    images: zipProject.images,
    audio: new Map([[1, audBlob]]),
  });
  const importedZip = await importProjectFromZip(exportedZip);
  assert.equal(importedZip.project.panels[0].durationOverride, 4.2);
  assert.equal(importedZip.project.panels[0].trimIn, 0.15);
  assert.equal(importedZip.project.panels[0].trimOut, 0.25);
  assert.equal(importedZip.project.panels[0].solo, true);
  assert.equal(importedZip.project.panels[0].gain, 1.35);
  assert.equal(importedZip.project.panels[0].fadeIn, 0.1);
  assert.equal(importedZip.project.panels[0].fadeOut, 0.2);
  assert.deepEqual(importedZip.project.imageFiles, ['0.png']);

  // P1 п. 17: пересборка таймлайна после импорта ZIP сохраняет durationOverride = 4.2 с
  const rebuiltAfterZip = invalidateAndRebuildTimeline(importedZip.project, { 1: 2.5 });
  assert.ok(Math.abs((rebuiltAfterZip.timeline[0].audioEnd - rebuiltAfterZip.timeline[0].audioStart) - 4.2) < 1e-6);

  // P1 п. 18: сквозной интеграционный цикл: создание -> сценарий -> импорт аудио -> Preview -> seek -> экспорт
  const scenarioParsed = parseScenario('Изображение 1 [0..50%]\nАлиса (Ж): Первая фраза\nИзображение 1 [50..100%]\nБоб (М): Вторая фраза');
  const e2eApplied = applyScenarioToProject(zipProject, scenarioParsed.lines, {
    imagesCount: 1,
    panelGap: 0.5,
    voiceAssignments: {},
  });
  const pA = e2eApplied.panels[0].id;
  const pB = e2eApplied.panels[1].id;
  const e2eProject = invalidateAndRebuildTimeline(
    { ...zipProject, ...e2eApplied },
    { [pA]: 2.0, [pB]: 3.0 },
    { introAudioDuration: 1.0, outroAudioDuration: 1.0 }
  );

  const e2eScene = createStripScene({
    sizes: [{ width: 1000, height: 1600 }],
    images: [null],
    timeline: e2eProject.timeline,
    panels: e2eProject.panels,
    options: { frameWidth: 1000, frameHeight: 600, gap: 0 },
  });

  const e2eClock = new ProjectClock({ duration: 7.5, currentTime: 0 });
  e2eClock.seek(2.0, 'seek'); // середина первой реплики [1.0..3.0]

  const previewFrame = sampleCameraFrame({
    time: e2eClock.getTime(),
    timeline: e2eProject.timeline,
    panels: e2eProject.panels,
    introDuration: e2eProject.introDuration,
    outroDuration: e2eProject.outroDuration,
    introAudioDuration: 1.0,
    outroAudioDuration: 1.0,
    renderMode: 'strip',
    strip: { scene: e2eScene },
    viewportWidth: 1000,
    viewportHeight: 600,
  });

  const noopCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    shadowColor: '',
    shadowBlur: 0,
    fillRect: () => {},
    strokeRect: () => {},
    fillText: () => {},
    strokeText: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    clip: () => {},
    rect: () => {},
    roundRect: () => {},
    fill: () => {},
    measureText: (txt: string) => ({ width: txt.length * 8 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  } as unknown as CanvasRenderingContext2D;

  const exportFrame = renderExportFrameToCanvas({
    ctx: noopCtx,
    width: 1000,
    height: 600,
    time: e2eClock.getTime(),
    options: {
      images: [],
      panels: e2eProject.panels,
      timeline: e2eProject.timeline,
      audioBlobs: [],
      introText: e2eProject.intro,
      outroText: e2eProject.outro,
      introDuration: e2eProject.introDuration,
      outroDuration: e2eProject.outroDuration,
      introAudioDuration: 1.0,
      outroAudioDuration: 1.0,
      srtContent: e2eProject.srt,
      fps: 30,
      musicVolume: 0.2,
      renderMode: 'strip',
    },
    loadedImages: new Map(),
    stripScene: e2eScene,
  });

  assert.equal(previewFrame.stripScrollY, exportFrame.stripScrollY);
  assert.equal(previewFrame.frameSignature, exportFrame.frameSignature);

  // Итерация 2.1 — Блокирующая задача 6 (Б10):
  // Полный цикл с серией clock.seek(t1), clock.seek(t2), clock.seek(t3) ->
  // sampleCameraFrame + renderExportFrameToCanvas на каждом шаге ->
  // совпадение stripScrollY / panelProgress и проверка scrollAt(t) === cameraYForSpan(span, t)
  const e2eSpans = buildStripScrollSpans(e2eProject.timeline, e2eScene.layout, e2eProject.panels);
  const seekTimes = [1.6, 3.15, 4.6]; // внутри 1-й панели, в паузе между 1-й и 2-й, внутри 2-й панели
  for (const tk of seekTimes) {
    e2eClock.seek(tk, 'seek');
    assert.ok(Math.abs(e2eClock.getTime() - tk) < 1e-6);

    for (const mode of ['strip', 'panels'] as const) {
      const pFrame = sampleCameraFrame({
        time: e2eClock.getTime(),
        renderMode: mode,
        panels: e2eProject.panels,
        timeline: e2eProject.timeline,
        introDuration: e2eProject.introDuration,
        outroDuration: e2eProject.outroDuration,
        stripScene: mode === 'strip' ? e2eScene : null,
        viewportWidth: 1000,
        viewportHeight: 600,
      });

      const xFrame = renderExportFrameToCanvas({
        ctx: noopCtx,
        width: 1000,
        height: 600,
        time: e2eClock.getTime(),
        options: {
          images: [],
          panels: e2eProject.panels,
          timeline: e2eProject.timeline,
          audioBlobs: [],
          introText: e2eProject.intro,
          outroText: e2eProject.outro,
          introDuration: e2eProject.introDuration,
          outroDuration: e2eProject.outroDuration,
          introAudioDuration: 1.0,
          outroAudioDuration: 1.0,
          srtContent: e2eProject.srt,
          fps: 30,
          musicVolume: 0.2,
          renderMode: mode,
        },
        loadedImages: new Map(),
        stripScene: mode === 'strip' ? e2eScene : undefined,
      });

      assert.equal(pFrame.stripScrollY, xFrame.stripScrollY, `Несовпадение stripScrollY на t=${tk}, mode=${mode}`);
      assert.equal(pFrame.panelProgress, xFrame.panelProgress, `Несовпадение panelProgress на t=${tk}, mode=${mode}`);
      assert.equal(pFrame.frameSignature, xFrame.frameSignature, `Несовпадение frameSignature на t=${tk}, mode=${mode}`);
    }

    // Если t попадает внутрь сегмента, проверяем тождество scrollAt(t) === cameraYForSpan(span, t)
    const activeSpan = e2eSpans.find(sp => tk >= sp.start && tk <= sp.end);
    if (activeSpan) {
      assert.ok(
        Math.abs(e2eScene.scrollAt(tk) - cameraYForSpan(activeSpan, tk)) < 1e-6,
        `scrollAt(${tk}) !== cameraYForSpan(span, ${tk})`
      );
    }
  }
});

test('Итерация 2.1 — Блокирующая задача 7 (Б6) и P1 (11): mixAudioPlacements с introDuration < introAudioDuration и freeBytes: null при недоступной оценке квоты', async () => {
  clearBufferCache();
  // Интро-аудио длительностью 3.0 с, но introDuration в проекте вручную уменьшен до 2.0 с
  const intro3sBlob = makeTestWavBlob(3.0);
  const placements = buildTimelineAudioPlacements({
    timeline: [],
    panels: [],
    panelBlobs: new Map(),
    introAudio: intro3sBlob,
    introDuration: 2.0,
  });
  assert.equal(placements.length, 1);
  assert.equal(placements[0].maxPlayDuration, 2.0);

  // Полный цикл mixAudioPlacements: длина итогового буфера должна быть равна introDuration (2.0 с), а не introAudioDuration (3.0 с)
  const mixed = await mixAudioPlacements(placements);
  assert.ok(mixed, 'mixAudioPlacements должен вернуть буфер');
  assert.ok(
    Math.abs(mixed.duration - 2.0) < 1e-3,
    `Ожидалась длительность микса 2.0 с (introDuration), получено ${mixed.duration} с`
  );
  assert.ok(
    Math.abs(mixed.buffer.duration - 2.0) < 1e-3,
    `Ожидалась длительность AudioBuffer 2.0 с (introDuration), получено ${mixed.buffer.duration} с`
  );

  // P1 п. 11: checkStorageQuotaBeforeImport возвращает freeBytes: null при estimateAvailable: false
  const quotaUnavailable = await checkStorageQuotaBeforeImport(1024 * 1024, {
    estimate: async () => null,
  });
  assert.equal(quotaUnavailable.estimateAvailable, false);
  assert.equal(quotaUnavailable.freeBytes, null);

  // Итерация 2.2 — Б-2.3: независимый тест mixAudioPlacements([{ start: 0, blob: wav2s, playDuration: 2 }]) без totalDuration
  clearBufferCache();
  const wav2s = makeTestWavBlob(2.0);
  const sampleRate = 44100;
  const directMix = await mixAudioPlacements([{ start: 0, blob: wav2s, playDuration: 2 }], undefined, {
    sampleRate,
    channels: 2,
  });
  assert.ok(directMix, 'mixAudioPlacements без totalDuration должен вернуть MixedAudio');
  assert.ok(Math.abs(directMix.duration - 2.0) < 1e-4, `Ожидалась duration == 2.0, получено ${directMix.duration}`);
  assert.ok(
    Math.abs(directMix.buffer.duration - 2.0) < 1e-4,
    `Ожидалась buffer.duration == 2.0, получено ${directMix.buffer.duration}`
  );
  assert.ok(
    Math.abs(directMix.buffer.length - 2 * sampleRate) <= 1,
    `Ожидалось buffer.length == ${2 * sampleRate} (±1 сэмпл), получено ${directMix.buffer.length}`
  );

  // Итерация 2.2 — P1-5: inspectProjectHealth предупреждает при высоте панели < 2%
  const tinyPanel = makePanel(99, { bbox: { x: 0, y: 10, width: 100, height: 1.5 }, fullFrame: false });
  const tinyHealth = inspectProjectHealth({
    panels: [tinyPanel],
    timeline: [makeSeg({ panelId: 99, imageIndex: 0, audioStart: 0, audioEnd: 2.0, panelBbox: tinyPanel.bbox })],
    srt: '1\n00:00:00,000 --> 00:00:02,000\nГерой: Первая часть реплики номер 99 и вторая часть реплики\n',
    intro: '',
    outro: '',
    introDuration: 0,
    outroDuration: 0,
    availableImageIndices: [0],
    voicedPanelIds: [99],
  });
  assert.ok(
    tinyHealth.issues.some(iss => iss.code === 'PANEL_HEIGHT_UNDER_2_PERCENT'),
    'inspectProjectHealth должен выдать предупреждение PANEL_HEIGHT_UNDER_2_PERCENT для панели < 2% высоты'
  );
});

test('Этап 3 (подэтапы 3.1–3.6): assertValidPackedPlacements (Н-3.5), очистка scrollRafRef (Н-3.6), drag-and-drop (п. 51), ручки trim (п. 52), скорость камеры при durationOverride (п. 54), подсветка Preview (п. 62) и мобильный layout (п. 97)', () => {
  // 1. Подэтап 3.1 (Н-3.5): валидация обязательного playDuration > 0
  assertValidPackedPlacements([{ start: 0, playDuration: 1.25, label: 'Клип 1' }]);
  assert.throws(
    () => assertValidPackedPlacements([{ start: 0, playDuration: 0, label: 'Пустой' }]),
    /Некорректный playDuration/
  );
  assert.throws(
    () => assertValidPackedPlacements([{ start: 0, playDuration: Number.NaN, label: 'NaN' }]),
    /Некорректный playDuration/
  );

  // 2. Подэтап 3.1 (Н-3.6): проверка очистки scrollRafRef при размонтировании Timeline.tsx
  const timelineSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/studio/Timeline.tsx'), 'utf-8');
  assert.equal(
    timelineSrc.includes('window.cancelAnimationFrame(scrollRafRef.current)'),
    true,
    'Timeline.tsx должен отменять scrollRafRef.current при unmount'
  );
  assert.equal(timelineSrc.includes('data-trim-handle="in"'), true, 'Timeline.tsx должен рендерить левую ручку trim');
  assert.equal(timelineSrc.includes('data-trim-handle="out"'), true, 'Timeline.tsx должен рендерить правую ручку trim');
  assert.equal(timelineSrc.includes('data-reorder-confirm-bar'), true, 'Timeline.tsx должен подтверждать перестановку drag-and-drop');

  // 3. Подэтап 3.2 (п. 51 и п. 59): расчёт целевого индекса drag-and-drop с привязкой snapTimeToTargets -> reorderPanelClips
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 3.0 }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 3.5, audioEnd: 6.5 }),
    makeSeg({ panelId: 3, imageIndex: 0, audioStart: 7.0, audioEnd: 9.0 }),
  ];
  const snapTargets = collectSnapTargets(tl, 1.0, 10.0);
  const dropResult = computeDragDropReorderTarget({
    dropTimeRaw: 3.52, // рядом с началом 2-го клипа (3.5 с) -> привязка к 3.5 с и выбор индекса 1
    timeline: tl,
    snapTargets,
    snapEnabled: true,
    toleranceSec: 0.15,
  });
  assert.equal(dropResult.snappedTime, 3.5);
  assert.equal(dropResult.targetIndex, 1);

  let simPanels = [
    makePanel(1, { order: 0 }),
    makePanel(2, { order: 1 }),
    makePanel(3, { order: 2 }),
  ];
  const dragDurs = { 1: 2.0, 2: 3.0, 3: 2.0 };
  let simTimeline = [...tl];
  let simTimelineVersion = 10;

  // Симуляция pointerdown -> pointermove -> pointerup через createTimelinePointerController,
  // подключённый к reorderPanelClips и setPanelAudioTrim
  const pointerController = createTimelinePointerController({
    onReorderPanel: (panelId, targetIndex) => {
      const res = reorderPanelClips(simPanels, dragDurs, panelId, targetIndex, {
        panelGap: 0.5,
        introDuration: 1.0,
        outroDuration: 1.0,
        currentTimelineVersion: simTimelineVersion,
      });
      simPanels = res.panels;
      simTimeline = res.timeline;
      simTimelineVersion = res.timelineVersion;
    },
    onTrimPanel: (panelId, trimIn, trimOut) => {
      const res = setPanelAudioTrim(simPanels, dragDurs, panelId, trimIn, trimOut, {
        panelGap: 0.5,
        introDuration: 1.0,
        outroDuration: 1.0,
        currentTimelineVersion: simTimelineVersion,
      });
      simPanels = res.panels;
      simTimeline = res.timeline;
      simTimelineVersion = res.timelineVersion;
    },
  });

  // 3.1. Симуляция pointer-событий перетаскивания клипа #1 на позицию клипа #2 на той же дорожке ('video')
  assert.equal(
    pointerController.pointerDownClip({ panelId: 1, track: 'video', clipIndex: 0 }),
    true
  );
  assert.equal(
    pointerController.pointerMoveClip({
      overTrack: 'video',
      dropTimeRaw: 3.52,
      timeline: simTimeline,
      snapTargets,
      snapEnabled: true,
    }),
    1
  );
  const upSameTrack = pointerController.pointerUpClip({ overTrack: 'video' });
  assert.equal(upSameTrack.reordered, true);
  assert.equal(simTimelineVersion, 11, 'Pointer drag-and-drop должен инкрементировать timelineVersion (10 -> 11)');
  assert.deepEqual(simTimeline.map(s => s.panelId), [2, 1, 3]);

  // 3.2. Попытка перетащить клип между разными дорожками ('video' -> 'audio') игнорируется
  pointerController.pointerDownClip({ panelId: 2, track: 'video', clipIndex: 0 });
  assert.equal(
    pointerController.pointerMoveClip({
      overTrack: 'audio',
      dropTimeRaw: 7.0,
      timeline: simTimeline,
      snapTargets,
      snapEnabled: true,
    }),
    null
  );
  const upCrossTrack = pointerController.pointerUpClip({ overTrack: 'audio' });
  assert.equal(upCrossTrack.reordered, false);
  assert.equal(simTimelineVersion, 11, 'Междорожечный drop не должен менять timelineVersion');
  assert.equal(
    timelineSrc.includes("draggedTrack !== 'video'") && timelineSrc.includes("draggedTrack !== 'audio'"),
    true,
    'Timeline.tsx должен отклонять перетаскивание клипа между разными дорожками (видео <-> аудио)'
  );

  // 4. Подэтап 3.2 (п. 52 и п. 59): расчёт ручек trimIn / trimOut и pointer-симуляция на ручках -> setPanelAudioTrim
  const trimInRes = computeTrimHandleUpdate({
    edge: 'in',
    deltaSec: 0.4,
    currentTrimIn: 0.1,
    currentTrimOut: 0.2,
    segStart: 1.0,
    segEnd: 3.0,
    snapTargets: [
      { time: 1.0, kind: 'audio-start' },
      { time: 1.42, kind: 'audio-start' },
      { time: 3.0, kind: 'audio-end' },
    ],
    snapEnabled: true,
    toleranceSec: 0.06, // 1.0 + 0.4 = 1.40 притягивается к 1.42 (+0.42s)
  });
  assert.equal(trimInRes.snappedEdgeTime, 1.42);
  assert.equal(trimInRes.trimIn, 0.52);
  assert.equal(trimInRes.trimOut, 0.2);

  const trimOutRes = computeTrimHandleUpdate({
    edge: 'out',
    deltaSec: -0.5,
    currentTrimIn: trimInRes.trimIn,
    currentTrimOut: 0.2,
    segStart: 1.0,
    segEnd: 3.0,
    snapTargets: [
      { time: 1.0, kind: 'audio-start' },
      { time: 2.48, kind: 'audio-end' },
      { time: 3.0, kind: 'audio-end' },
    ],
    snapEnabled: true,
    toleranceSec: 0.06, // 3.0 - 0.5 = 2.50 притягивается к 2.48 (обрезка с конца +0.52s)
  });
  assert.equal(trimOutRes.snappedEdgeTime, 2.48);
  assert.equal(trimOutRes.trimOut, 0.72);

  // 4.1. Симуляция pointerdown -> pointermove -> pointerup на левой ручке ('in') и правой ручке ('out')
  pointerController.pointerDownTrimHandle({
    panelId: 1,
    edge: 'in',
    clientX: 100,
    initialTrimIn: 0.1,
    initialTrimOut: 0.2,
    segStart: 1.0,
    segEnd: 3.0,
  });
  // При trackWidth = 1000 и safeDuration = 10 с: 1 секунда = 100 px -> сдвиг +40 px = +0.40 с
  const previewIn = pointerController.pointerMoveTrimHandle({
    panelId: 1,
    edge: 'in',
    clientX: 140,
    trackWidth: 1000,
    safeDuration: 10,
    snapTargets: [
      { time: 1.0, kind: 'audio-start' },
      { time: 1.42, kind: 'audio-start' },
      { time: 3.0, kind: 'audio-end' },
    ],
    snapEnabled: true,
  });
  assert.deepEqual(previewIn, { trimIn: 0.52, trimOut: 0.2 });
  const commitIn = pointerController.pointerUpTrimHandle({ panelId: 1, edge: 'in' });
  assert.equal(commitIn.committed, true);
  assert.equal(simTimelineVersion, 12, 'Отпускание левой ручки trim должно инкрементировать timelineVersion (11 -> 12)');

  pointerController.pointerDownTrimHandle({
    panelId: 1,
    edge: 'out',
    clientX: 300,
    initialTrimIn: 0.52,
    initialTrimOut: 0.2,
    segStart: 1.0,
    segEnd: 3.0,
  });
  // Сдвиг -50 px = -0.50 с
  const previewOut = pointerController.pointerMoveTrimHandle({
    panelId: 1,
    edge: 'out',
    clientX: 250,
    trackWidth: 1000,
    safeDuration: 10,
    snapTargets: [
      { time: 1.0, kind: 'audio-start' },
      { time: 2.48, kind: 'audio-end' },
      { time: 3.0, kind: 'audio-end' },
    ],
    snapEnabled: true,
  });
  assert.deepEqual(previewOut, { trimIn: 0.52, trimOut: 0.72 });
  const commitOut = pointerController.pointerUpTrimHandle({ panelId: 1, edge: 'out' });
  assert.equal(commitOut.committed, true);
  assert.equal(simTimelineVersion, 13, 'Отпускание правой ручки trim должно инкрементировать timelineVersion (12 -> 13)');
  const trimmedPanel1 = simPanels.find(p => p.id === 1)!;
  assert.equal(trimmedPanel1.trimIn, 0.52);
  assert.equal(trimmedPanel1.trimOut, 0.72);

  // 5. Подэтап 3.2 (п. 54): влияние durationOverride на скорость движения камеры в panels и strip
  const pSpeed = makePanel(1, { bbox: { x: 0, y: 0, width: 100, height: 40 } }); // [0..40%]
  const baseSpeedTimeline: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 2.0, panelBbox: pSpeed.bbox }),
  ];
  const overridden = setPanelDurationOverride([pSpeed], { 1: 2.0 }, 1, 4.0, {
    panelGap: 0,
    introDuration: 0,
    outroDuration: 0,
  });
  assert.equal(overridden.timeline[0].audioEnd - overridden.timeline[0].audioStart, 4.0);

  // Сравниваем смещение камеры за 1 с в режиме panels (при 2 с прогресс = 0.5, при 4 с прогресс = 0.25)
  const sample2sAt1 = sampleCameraFrame({
    time: 1.0,
    renderMode: 'panels',
    panels: [pSpeed],
    timeline: baseSpeedTimeline,
    introDuration: 0,
    outroDuration: 0,
  });
  const sample4sAt1 = sampleCameraFrame({
    time: 1.0,
    renderMode: 'panels',
    panels: overridden.panels,
    timeline: overridden.timeline,
    introDuration: 0,
    outroDuration: 0,
  });
  assert.equal(sample2sAt1.panelProgress, 0.5);
  assert.equal(sample4sAt1.panelProgress, 0.25);

  const rect2sAt1 = computePanelCameraDrawRect({
    imgWidth: 1000,
    imgHeight: 2000,
    canvasWidth: 1280,
    canvasHeight: 720,
    yRange: sample2sAt1.yRange,
    progress: sample2sAt1.panelProgress,
  });
  const rect4sAt1 = computePanelCameraDrawRect({
    imgWidth: 1000,
    imgHeight: 2000,
    canvasWidth: 1280,
    canvasHeight: 720,
    yRange: sample4sAt1.yRange,
    progress: sample4sAt1.panelProgress,
  });
  assert.ok(
    Math.abs(rect4sAt1.oy - 0.5 * rect2sAt1.oy) < 1e-6,
    'При удвоении длительности через durationOverride скорость камеры за 1 с уменьшается ровно вдвое'
  );

  // И в режиме strip скорость scrollAt(1.0) уменьшается ровно вдвое
  const strip2s = createStripScene({
    sizes: [{ width: 1000, height: 2000 }],
    images: [null],
    timeline: baseSpeedTimeline,
    panels: [pSpeed],
    options: { frameWidth: 1000, frameHeight: 500, gap: 0 },
  });
  const strip4s = createStripScene({
    sizes: [{ width: 1000, height: 2000 }],
    images: [null],
    timeline: overridden.timeline,
    panels: overridden.panels,
    options: { frameWidth: 1000, frameHeight: 500, gap: 0 },
  });
  assert.ok(Math.abs(strip4s.scrollAt(1.0) - 0.5 * strip2s.scrollAt(1.0)) < 1e-6);

  // 6. Подэтап 3.3 (п. 62) и 3.2 (п. 51, 52): проверка двусторонней подсветки в Preview.tsx/Timeline.tsx и вызовов onReorderPanel/onTrimPanel
  const previewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/studio/Preview.tsx'), 'utf-8');
  assert.equal(previewSrc.includes('useSyncExternalStore'), true, 'Preview.tsx должен использовать useSyncExternalStore для шапки');
  assert.equal(previewSrc.includes('data-linked-clip-highlight'), true, 'Preview.tsx должен подсвечивать связанные видео/аудиоклипы');
  assert.equal(timelineSrc.includes('draggedPanelId'), true, 'Timeline.tsx должен хранить draggedPanelId при перетаскивании клипа');
  assert.equal(timelineSrc.includes('onReorderPanel'), true, 'Timeline.tsx должен вызывать onReorderPanel при отпускании над допустимой позицией');
  assert.equal(timelineSrc.includes('onTrimPanel'), true, 'Timeline.tsx должен вызывать onTrimPanel при отпускании ручки trim');

  const editorSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/app/editor/[id]/page.tsx'), 'utf-8');
  assert.equal(editorSrc.includes('onReorderPanel={handleReorderClip}'), true, 'EditorPage должен передавать onReorderPanel в Timeline');
  assert.equal(editorSrc.includes('onTrimPanel={handleSetPanelAudioTrim}'), true, 'EditorPage должен передавать onTrimPanel в Timeline');
});
