import { test } from 'node:test';
import assert from 'node:assert/strict';
import './fixtures/browserEnv';
import {
  applyAudioImport,
  buildAudioImportPreviewRows,
  createAudioImportUndoSnapshot,
  getPanelAudioTargetInfo,
  inspectFilesBeforeAudioImport,
  markPanelsImported,
  mergeAddedAudioImportSelection,
  planAudioImport,
  undoLastAudioImport,
} from '../src/lib/pipeline/audioImport';
import {
  canonicalizeMimeString,
  detectAudioMime,
  normalizeAudioBlobMime,
} from '../src/lib/providers/tts/mime';
import { pcmToWav } from '../src/lib/providers/tts/wav';
import { ObjectUrlRegistry } from '../src/lib/pipeline/objectUrlRegistry';
import {
  convertAudioBufferToWavBlob,
  formatMediaElementError,
  UnifiedAudioPlayer,
  type AudioLikeElement,
} from '../src/lib/pipeline/audioPlayer';
import { ProjectClock } from '../src/lib/pipeline/projectClock';
import { loadProjectAudio } from '../src/lib/storage/opfs';
import type { PanelData } from '../src/lib/storage/db';

function makePanel(id: number, overrides: Partial<PanelData> = {}): PanelData {
  return {
    id,
    order: id - 1,
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 50 },
    dialogue: `Текст реплики ${id}`,
    character: 'Герой',
    emotion: 'neutral',
    type: 'speech',
    ...overrides,
  };
}

function makeValidWavBlob(durationSec = 1.5, sampleRate = 8000): Blob {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const pcm = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    pcm[i] = Math.round(Math.sin(i * 0.1) * 8000);
  }
  const pcmAb = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
  const wavAb = pcmToWav(pcmAb, { sampleRate, channels: 1, bitsPerSample: 16 });
  return new Blob([wavAb], { type: 'audio/wav' });
}

test('Stage 2 (11–15): явное разделение panelNumber и imageNumber, подпись полосы [0..30%], номера с ведущими нулями и приоритет манифеста без молчаливого фолбэка', () => {
  const panels: PanelData[] = [
    makePanel(10, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 30 }, character: 'Аня' }),
    makePanel(20, { order: 1, imageIndex: 0, bbox: { x: 0, y: 30, width: 100, height: 40 }, character: 'Боб' }),
    makePanel(30, { order: 2, imageIndex: 6, bbox: { x: 0, y: 0, width: 100, height: 100 }, fullFrame: true, character: 'Вика' }),
  ];

  const info0 = getPanelAudioTargetInfo(panels[0], 0);
  assert.equal(info0.panelNumber, 1);
  assert.equal(info0.imageNumber, 1);
  assert.equal(info0.anchor, 'Изображение 1 [0..30%]');
  assert.ok(info0.label.includes('Изображение 1 [0..30%]'));

  const info2 = getPanelAudioTargetInfo(panels[2], 2);
  assert.equal(info2.panelNumber, 3);
  assert.equal(info2.imageNumber, 7);

  // Ведущие нули и префиксы (panel-0003.mp3 -> 3-я панель по префиксу panel-, 001_intro.wav -> 1-я панель по номеру)
  const numberRefs = [{ name: '001_intro.wav' }, { name: 'panel-0003.mp3' }];
  const numberPlan = planAudioImport(numberRefs, panels);
  assert.equal(numberPlan.matches.length, 2);
  assert.equal(numberPlan.matches[0].target.id, 10);
  assert.equal(numberPlan.matches[0].via, 'number');
  assert.equal(numberPlan.matches[1].target.id, 30);
  assert.ok(numberPlan.matches[1].via === 'name' || numberPlan.matches[1].via === 'number');

  // Приоритет манифеста без молчаливого фолбэка на сопоставление по порядку для битых строк манифеста
  const manifestRefs = [{ name: 'a.mp3' }, { name: 'b.mp3' }];
  const manifestPlan = planAudioImport(
    manifestRefs,
    panels,
    {
      manifest: [
        'Изображение 1 [30..70%] = a.mp3',
        'Изображение 999 [0..50%] = b.mp3', // несуществующий якорь — должен дать явную ошибку
      ].join('\n'),
    }
  );
  assert.equal(manifestPlan.matches.length, 1);
  assert.equal(manifestPlan.matches[0].file, 'a.mp3');
  assert.equal(manifestPlan.matches[0].target.id, 20);
  assert.equal(manifestPlan.matches[0].via, 'manifest');
  assert.ok(manifestPlan.errors.some(e => e.includes('999') || e.includes('строка 2')));

  const rows = buildAudioImportPreviewRows(manifestRefs, panels, manifestPlan);
  assert.equal(rows.length, 2);
  const matchedRow = rows.find(r => r.file === 'a.mp3');
  assert.ok(matchedRow);
  assert.equal(matchedRow.status, 'matched');
  assert.equal(matchedRow.panelNumber, 2);
  assert.equal(matchedRow.imageNumber, 1);
});

test('Stage 2 (16–20): пред-импортное декодирование, SHA-256 дубликаты, отсечение битых файлов, выборочный импорт и откат последнего импорта', async () => {
  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 50 } }),
    makePanel(2, { order: 1, imageIndex: 0, bbox: { x: 0, y: 50, width: 100, height: 50 } }),
  ];

  const validBlob1 = makeValidWavBlob(1.2);
  const validBlob1Copy = makeValidWavBlob(1.2); // точный дубликат по SHA-256
  const brokenBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mp3' });

  const fileMap = new Map<string, Blob>([
    ['001_a.wav', validBlob1],
    ['001_b.wav', validBlob1Copy],
    ['002_bad.mp3', brokenBlob],
  ]);

  const inspected = await inspectFilesBeforeAudioImport(
    [
      { name: '001_a.wav', blob: validBlob1 },
      { name: '001_b.wav', blob: validBlob1Copy },
      { name: '002_bad.mp3', blob: brokenBlob },
    ],
    {
      decode: async (ab: ArrayBuffer) => {
        if (ab.byteLength < 44) throw new Error('Undecodable audio stream');
        return 1.25;
      },
    }
  );

  assert.equal(inspected.length, 3);
  assert.equal(inspected[0].duration, 1.25);
  assert.equal(inspected[0].sha256, inspected[1].sha256);
  assert.ok(inspected[2].decodeError);

  const plan = planAudioImport(inspected, panels);
  // Дубликат по SHA-256 и битый файл фиксируются в ошибках плана
  assert.ok(plan.errors.some(w => w.includes('SHA-256') || w.includes('Дубликат')));
  assert.ok(plan.errors.some(e => e.includes('002_bad.mp3')));
  assert.equal(plan.matches.some(m => m.file === '002_bad.mp3'), false);

  // Выборочный импорт (п. 19): отмечаем только 001_a.wav
  const validBlob2 = makeValidWavBlob(2.4);
  fileMap.set('001_b.wav', validBlob2);
  const twoValidRefs = [{ name: '001_a.wav' }, { name: '001_b.wav' }];
  const selectivePlan = planAudioImport(twoValidRefs, panels, {
    selectedFiles: new Set(['001_a.wav']),
  });
  assert.equal(selectivePlan.matches.length, 1);
  assert.equal(selectivePlan.matches[0].file, '001_a.wav');

  // Снимок состояния перед импортом для кнопки «Откатить последний импорт» (п. 20)
  const snapshot = await createAudioImportUndoSnapshot({
    projectId: 'proj-undo-1',
    panels,
    audioDurations: {},
    timeline: [],
    srt: '',
    targetPanelIds: [1, 2],
  });

  const report = await applyAudioImport(selectivePlan, fileMap, {
    projectId: 'proj-undo-1',
    decode: async () => 1.8,
  });

  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].panelId, 1);
  assert.equal(report.applied[0].duration, 1.8);

  const markedPanels = markPanelsImported(panels, report.applied);
  assert.equal(markedPanels[0].audioSource, 'import');
  assert.equal(markedPanels[0].audioFileName, '001_a.wav');
  assert.equal(markedPanels[1].audioSource, undefined);

  // Откат последнего импорта восстанавливает прежние панели и очищает OPFS
  const restored = await undoLastAudioImport(snapshot);
  assert.equal(restored.panels[0].audioSource, undefined);
  const opfsAfterUndo = await loadProjectAudio('proj-undo-1', 1);
  assert.equal(opfsAfterUndo, null);
});

test('Stage 3 (21–25): сигнатуры magic bytes, нормализация MIME, конвертация в WAV и человекочитаемые ошибки HTMLMediaElement', async () => {
  const toAb = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

  // Magic bytes для WAV, MP3, OGG, FLAC, M4A, AIFF
  const wavHeader = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
  assert.equal(detectAudioMime(toAb(wavHeader)), 'audio/wav');

  const mp3Id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectAudioMime(toAb(mp3Id3)), 'audio/mpeg');

  const oggHeader = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectAudioMime(toAb(oggHeader)), 'audio/ogg');

  const flacHeader = new Uint8Array([0x66, 0x4c, 0x61, 0x43, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectAudioMime(toAb(flacHeader)), 'audio/flac');

  const m4aHeader = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  assert.equal(detectAudioMime(toAb(m4aHeader)), 'audio/mp4');

  const aiffHeader = new Uint8Array([0x46, 0x4f, 0x52, 0x4d, 0, 0, 0, 0, 0x41, 0x49, 0x46, 0x46]);
  assert.equal(detectAudioMime(toAb(aiffHeader)), 'audio/aiff');

  assert.equal(canonicalizeMimeString('audio/x-wav; codecs=1'), 'audio/wav');
  assert.equal(canonicalizeMimeString('audio/mp3'), 'audio/mpeg');
  assert.equal(canonicalizeMimeString('application/octet-stream'), 'application/octet-stream');

  // Нормализация Blob с кривым MIME application/octet-stream по magic bytes
  const rawWav = makeValidWavBlob(0.5);
  const octetBlob = new Blob([await rawWav.arrayBuffer()], { type: 'application/octet-stream' });
  const normalized = await normalizeAudioBlobMime(octetBlob);
  assert.equal(normalized.originalMime, 'application/octet-stream');
  assert.equal(normalized.normalizedMime, 'audio/wav');
  assert.equal(normalized.blob.type, 'audio/wav');

  // Конвертация декодированного буфера в стандартный PCM WAV (п. 22)
  const fakeBuffer = {
    sampleRate: 16000,
    numberOfChannels: 1,
    length: 1600,
    getChannelData: () => new Float32Array(1600).fill(0.25),
  };
  const convertedWav = convertAudioBufferToWavBlob(fakeBuffer);
  assert.equal(convertedWav.type, 'audio/wav');
  assert.equal(detectAudioMime(await convertedWav.arrayBuffer()), 'audio/wav');

  // Человекочитаемая ошибка вместо немого NotSupportedError (п. 25)
  const errMsg = formatMediaElementError({ code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' }, {
    panelId: 5,
    mime: 'audio/x-caf',
  });
  assert.ok(errMsg.message.includes('панель 5'));
  assert.ok(errMsg.message.includes('audio/x-caf'));
});

test('Stage 3 (26–30): ObjectUrlRegistry без утечек и UnifiedAudioPlayer с seek внутри сегмента без пересоздания URL', async () => {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  let seq = 0;

  const registry = new ObjectUrlRegistry({
    createObjectURL: () => {
      const u = `blob:test-url-${++seq}`;
      createdUrls.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revokedUrls.push(u);
    },
  });

  const blobA = makeValidWavBlob(1.0);
  const blobB = makeValidWavBlob(2.0);

  // Повторный запрос для того же ключа и того же Blob переиспользует существующий URL
  const r1 = registry.acquire('panel:1', blobA);
  const r2 = registry.acquire('panel:1', blobA);
  assert.equal(r1.url, r2.url);
  assert.equal(r1.reused, false);
  assert.equal(r2.reused, true);
  assert.equal(createdUrls.length, 1);

  // Замена Blob на том же ключе отзывает старый URL
  const r3 = registry.acquire('panel:1', blobB);
  assert.notEqual(r3.url, r1.url);
  assert.equal(revokedUrls.length, 1);
  assert.equal(revokedUrls[0], r1.url);

  // Многократное открытие/закрытие и revokeAll гарантируют отсутствие живых URL (п. 30)
  registry.acquire('panel:2', blobA);
  registry.acquire('panel:3', blobB);
  assert.equal(registry.getActiveCount(), 3);
  registry.revokeAll();
  assert.equal(registry.getActiveCount(), 0);
  assert.equal(createdUrls.length, revokedUrls.length);

  // UnifiedAudioPlayer: seek внутри одного сегмента меняет только currentTime и НЕ пересоздаёт URL (п. 26–29)
  let srcAssignments = 0;
  const fakeAudio: AudioLikeElement = {
    src: '',
    currentTime: 0,
    paused: true,
    muted: false,
    volume: 1,
    playbackRate: 1,
    preload: 'auto',
    error: null,
    onended: null,
    onerror: null,
    onwaiting: null,
    onstalled: null,
    oncanplay: null,
    onloadedmetadata: null,
    async play() {
      this.paused = false;
    },
    pause() {
      this.paused = true;
    },
  };

  let trackedSrc = '';
  Object.defineProperty(fakeAudio, 'src', {
    get: () => trackedSrc,
    set: (v: string) => {
      trackedSrc = v;
      srcAssignments++;
    },
  });

  const clock = new ProjectClock({ duration: 4.0 });
  const playerRegistry = new ObjectUrlRegistry({
    createObjectURL: () => `blob:player-${++seq}`,
    revokeObjectURL: (u: string) => revokedUrls.push(u),
  });
  const player = new UnifiedAudioPlayer({
    clock,
    registry: playerRegistry,
    createAudio: () => fakeAudio,
    requestFrame: () => 1,
    cancelFrame: () => {},
  });

  const timeline = [
    {
      panelId: 1,
      imageIndex: 0,
      audioStart: 0,
      audioEnd: 4.0,
      panelBbox: { x: 0, y: 0, width: 100, height: 100 },
      voiceId: 'default',
      text: 'Тест',
      character: 'Герой',
    },
  ];
  const panelBlobs = new Map<number, Blob>([[1, blobB]]);

  clock.play('play');
  await player.syncPlayback({
    timeline,
    introDuration: 0,
    outroDuration: 0,
    panelBlobs,
  });
  assert.equal(srcAssignments, 1);

  const slot = {
    key: 'panel:1',
    panelId: 1 as const,
    blob: blobB,
    timelineStart: 0,
    timelineEnd: 4.0,
    trimIn: 0,
    trimOut: 0,
    muted: false,
    volume: 1,
  };

  // Два последовательных seek внутри сегмента [0..4.0] не пересоздают src
  const s1 = player.seekTo(1.2, slot);
  const s2 = player.seekTo(2.7, slot);
  assert.equal(s1.reusedUrl, true);
  assert.equal(s2.reusedUrl, true);
  assert.equal(srcAssignments, 1);
  assert.ok(Math.abs(fakeAudio.currentTime - 2.7) < 1e-3);
  assert.ok(Math.abs(clock.getTime() - 2.7) < 1e-3);

  player.dispose();
  assert.equal(playerRegistry.getActiveCount(), 0);
});

test('Итерация 2 — Задача 9 и P1 (1, 4): плавные PLL-часы в аудиорежиме (квантование 26 мс, производная < 2%, 100 переходов audio->gap->audio с дрейфом < 5 мс) и refCount в ObjectUrlRegistry', async () => {
  // 1. P1 п. 1: normalizeAudioBlobMime переиспользует bufferOverride / slice без лишнего чтения всего буфера
  const baseWav = makeValidWavBlob(0.5);
  let fullArrayBufferReads = 0;
  const origArrayBuffer = baseWav.arrayBuffer.bind(baseWav);
  const trackedBlob = new Blob([await origArrayBuffer()], { type: 'application/octet-stream' });
  trackedBlob.arrayBuffer = async () => {
    fullArrayBufferReads++;
    return origArrayBuffer();
  };
  const normRes = await normalizeAudioBlobMime(trackedBlob);
  assert.equal(normRes.normalizedMime, 'audio/wav');
  assert.equal(fullArrayBufferReads, 0, 'normalizeAudioBlobMime должен использовать blob.slice(0, size, mime) вместо чтения всего буфера');

  // 2. P1 п. 4: ObjectUrlRegistry.release по умолчанию force = false (учитывает refCount)
  let revokedCount = 0;
  const reg = new ObjectUrlRegistry({
    createObjectURL: () => 'blob:refcount-1',
    revokeObjectURL: () => {
      revokedCount++;
    },
  });
  const a1 = reg.acquire('slot:1', baseWav);
  const a2 = reg.acquire('slot:1', baseWav);
  assert.equal(a1.url, a2.url);
  assert.equal(reg.release(a1.url), false, 'Первое release при refCount=2 не должно отзывать URL');
  assert.equal(revokedCount, 0);
  assert.equal(reg.release(a1.url), true, 'Второе release при refCount=0 должно отозвать URL');
  assert.equal(revokedCount, 1);

  // 3. Задача 9 (часть 1): 60 fps тики с квантованным audio.currentTime (шаг 26 мс)
  const fakeAudio: AudioLikeElement = {
    src: '',
    currentTime: 0,
    paused: false,
    muted: false,
    volume: 1,
    playbackRate: 1,
    preload: 'auto',
    error: null,
    onended: null,
    onerror: null,
    onwaiting: null,
    onstalled: null,
    oncanplay: null,
    onloadedmetadata: null,
    play: async () => {
      fakeAudio.paused = false;
    },
    pause: () => {
      fakeAudio.paused = true;
    },
  };

  let wallMs = 1000;
  const clock = new ProjectClock({ duration: 10.0, currentTime: 0, playbackRate: 1.0 });
  const player = new UnifiedAudioPlayer({
    clock,
    createAudio: () => fakeAudio,
    requestFrame: () => 1,
    cancelFrame: () => {},
    now: () => wallMs,
  });

  const singleSegTimeline = [
    {
      panelId: 1,
      imageIndex: 0,
      audioStart: 0,
      audioEnd: 5.0,
      panelBbox: { x: 0, y: 0, width: 100, height: 100 },
      voiceId: 'default',
      text: 'PLL тест',
      character: 'Герой',
    },
  ];
  const blobs = new Map<number, Blob>([[1, baseWav]]);

  clock.play('play');
  await player.syncPlayback({
    timeline: singleSegTimeline,
    introDuration: 0,
    outroDuration: 0,
    panelBlobs: blobs,
  });

  const frameDtMs = 1000 / 60; // ~16.6667 ms
  let prevClockTime = clock.getTime();
  for (let frame = 1; frame <= 120; frame++) {
    wallMs = 1000 + frame * frameDtMs;
    const elapsedSec = (wallMs - 1000) / 1000;
    // Имитация квантования currentTime аудиоэлемента шагом 26 мс
    fakeAudio.currentTime = Math.floor(elapsedSec / 0.026) * 0.026;

    const cur = player.tick(wallMs, {
      timeline: singleSegTimeline,
      introDuration: 0,
      outroDuration: 0,
      panelBlobs: blobs,
    });
    assert.ok(cur >= prevClockTime, `Немонотонное время на кадре ${frame}: ${cur} < ${prevClockTime}`);
    const dtSec = frameDtMs / 1000;
    const derivative = (cur - prevClockTime) / dtSec;
    const relDiff = Math.abs(derivative - 1.0);
    assert.ok(
      relDiff < 0.02,
      `Производная ${derivative.toFixed(4)} отклонилась от playbackRate=1 более чем на 2% (${(relDiff * 100).toFixed(2)}%)`
    );
    prevClockTime = cur;
  }

  // Проверяем явный clock.seek(slot.timelineEnd) по onended
  fakeAudio.onended?.();
  assert.ok(Math.abs(clock.getTime() - 5.0) < 1e-6);

  // 4. Задача 9 (часть 2): 100 переходов audio -> gap -> audio, накопленный дрейф < 5 мс
  const multiTimeline = [];
  const multiBlobs = new Map<number, Blob>();
  let cursor = 0;
  for (let i = 1; i <= 100; i++) {
    const start = cursor;
    const end = Number((start + 0.1).toFixed(4));
    multiTimeline.push({
      panelId: i,
      imageIndex: 0,
      audioStart: start,
      audioEnd: end,
      panelBbox: { x: 0, y: 0, width: 100, height: 100 },
      voiceId: 'default',
      text: `Фраза ${i}`,
      character: 'Герой',
    });
    multiBlobs.set(i, baseWav);
    cursor = Number((end + 0.05).toFixed(4)); // 0.1s audio + 0.05s gap
  }

  wallMs = 10_000;
  const totalMultiDur = multiTimeline[multiTimeline.length - 1].audioEnd;
  const multiClock = new ProjectClock({ duration: totalMultiDur + 1, currentTime: 0, playbackRate: 1.0 });
  const multiPlayer = new UnifiedAudioPlayer({
    clock: multiClock,
    createAudio: () => fakeAudio,
    requestFrame: () => 1,
    cancelFrame: () => {},
    now: () => wallMs,
  });

  multiClock.play('play');
  const syncParams = {
    timeline: multiTimeline,
    introDuration: 0,
    outroDuration: 0,
    panelBlobs: multiBlobs,
  };
  await multiPlayer.syncPlayback(syncParams);

  const totalSimSec = 14.95; // покрывает все 100 переходов audio <-> gap
  const steps = Math.floor(totalSimSec * 100); // шаг 10 мс
  for (let s = 1; s <= steps; s++) {
    wallMs = 10_000 + s * 10;
    const activeKey = multiPlayer.getActiveKey();
    if (activeKey && activeKey.startsWith('panel:')) {
      const pid = Number(activeKey.slice('panel:'.length));
      const seg = multiTimeline[pid - 1];
      if (seg) {
        const expectedWallTime = (wallMs - 10_000) / 1000;
        fakeAudio.currentTime = Math.max(0, expectedWallTime - seg.audioStart);
      }
    }
    multiPlayer.tick(wallMs, syncParams);
  }

  const expectedFinalTime = (wallMs - 10_000) / 1000;
  const actualFinalTime = multiClock.getTime();
  const driftMs = Math.abs(actualFinalTime - expectedFinalTime) * 1000;
  assert.ok(
    driftMs < 5,
    `Накопленный дрейф после 100 переходов audio->gap->audio составил ${driftMs.toFixed(3)} мс (ожидалось < 5 мс)`
  );
  multiPlayer.dispose();

  // 5. Итерация 2.1 — Блокирующая задача 3 (Б4): систематическое отставание audio.currentTime на 10 мс
  // (квантование 26 мс, audioTarget всегда на 10 мс меньше predicted) -> clock строго монотонно растёт, производная >= 0.5 * playbackRate
  let lagWallMs = 50_000;
  const lagClock = new ProjectClock({ duration: 10.0, currentTime: 0, playbackRate: 1.0 });
  const lagPlayer = new UnifiedAudioPlayer({
    clock: lagClock,
    createAudio: () => fakeAudio,
    requestFrame: () => 1,
    cancelFrame: () => {},
    now: () => lagWallMs,
  });

  lagClock.play('play');
  await lagPlayer.syncPlayback({
    timeline: singleSegTimeline,
    introDuration: 0,
    outroDuration: 0,
    panelBlobs: blobs,
  });

  let prevLagTime = lagClock.getTime();
  for (let frame = 1; frame <= 120; frame++) {
    lagWallMs = 50_000 + frame * frameDtMs;
    const elapsedSec = (lagWallMs - 50_000) / 1000;
    // Систематическое отставание на 10 мс + квантование шагом 26 мс
    const laggedSec = Math.max(0, elapsedSec - 0.01);
    fakeAudio.currentTime = Math.floor(laggedSec / 0.026) * 0.026;

    const cur = lagPlayer.tick(lagWallMs, {
      timeline: singleSegTimeline,
      introDuration: 0,
      outroDuration: 0,
      panelBlobs: blobs,
    });
    assert.ok(cur > prevLagTime, `Часы замерли при отставании audio.currentTime на кадре ${frame}: ${cur} <= ${prevLagTime}`);
    const dtSec = frameDtMs / 1000;
    const derivative = (cur - prevLagTime) / dtSec;
    assert.ok(
      derivative >= 0.5 * lagClock.getPlaybackRate(),
      `Производная ${derivative.toFixed(4)} упала ниже 0.5 * playbackRate на кадре ${frame}`
    );
    prevLagTime = cur;
  }
  lagPlayer.dispose();

  // 6. Итерация 2.1 — P1 п. 10: явное поведение selectAll при добавлении новых файлов в AudioImportModal
  const f1 = { name: '001.mp3' };
  const f2 = { name: '002.mp3' };
  const f3 = { name: '003.mp3' };
  // Пользователь снял галочку с 002.mp3 (selectAll = false, выбран только 001.mp3), затем добавил 003.mp3:
  const afterPartialAdd = mergeAddedAudioImportSelection({
    prevFiles: [f1, f2],
    prevSelected: new Set(['001.mp3']),
    prevSelectAll: false,
    incomingAudio: [f3],
  });
  assert.equal(afterPartialAdd.selectAll, false, '002.mp3 остаётся снятым, поэтому selectAll = false');
  assert.equal(afterPartialAdd.selectedFileNames.has('001.mp3'), true);
  assert.equal(afterPartialAdd.selectedFileNames.has('002.mp3'), false);
  assert.equal(afterPartialAdd.selectedFileNames.has('003.mp3'), true, 'Новый добавленный файл 003.mp3 автоматически выбран');

  // Когда все файлы были выбраны (selectAll = true), добавление нового файла сохраняет selectAll = true
  const afterFullAdd = mergeAddedAudioImportSelection({
    prevFiles: [f1, f2],
    prevSelected: new Set(['001.mp3', '002.mp3']),
    prevSelectAll: true,
    incomingAudio: [f3],
  });
  assert.equal(afterFullAdd.selectAll, true);
  assert.equal(afterFullAdd.selectedFileNames.size, 3);
});
