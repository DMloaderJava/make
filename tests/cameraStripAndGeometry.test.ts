import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeRangeText,
  validateYRange,
} from '../src/lib/pipeline/yRange';
import {
  buildTimeline,
} from '../src/lib/pipeline/buildTimeline';
import {
  buildStripScrollSpans,
  cameraYForSpan,
  computeStripLayout,
  createStripScene,
  scrollDirectionAt,
} from '../src/lib/pipeline/mangaStrip';
import {
  computeAutoFollowScrollLeft,
  computeTimelineGaps,
  computeTimelineGeometry,
  computeZoomAroundTime,
} from '../src/lib/pipeline/timelineGeometry';
import {
  CanvasFrameDeduplicator,
  computePanelCameraDrawRect,
  diagnoseSlotResources,
  drawPanelWithCamera,
  resolveFirstSegmentForPage,
  sampleCameraFrame,
} from '../src/lib/pipeline/cameraSampler';
import { renderExportFrameToCanvas } from '../src/lib/pipeline/assembleVideo';
import { computePreviewHeaderSelectorKey } from '../src/components/studio/Preview';
import type { PanelData, SyncTimeline } from '../src/lib/storage/db';

function makePanel(id: number, overrides: Partial<PanelData> = {}): PanelData {
  return {
    id,
    order: id - 1,
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    dialogue: `Текст ${id}`,
    character: 'Герой',
    emotion: 'neutral',
    type: 'speech',
    ...overrides,
  };
}

function makeSeg(overrides: Partial<SyncTimeline> & { panelId: number; imageIndex: number; audioStart: number; audioEnd: number }): SyncTimeline {
  return {
    panelBbox: { x: 0, y: 0, width: 100, height: 100 },
    voiceId: 'default',
    text: `Реплика ${overrides.panelId}`,
    character: 'Герой',
    ...overrides,
  };
}

test('Stage 4 (31–33): строгая валидация 0 <= from < to <= 100 и нормализация синтаксиса [0..30%]', () => {
  assert.equal(validateYRange(0, 30).ok, true);
  assert.equal(validateYRange(0, 100).ok, true);
  assert.equal(validateYRange(-5, 30).ok, false);
  assert.equal(validateYRange(30, 105).ok, false);
  assert.equal(validateYRange(50, 50).ok, false);
  assert.equal(validateYRange(70, 30).ok, false);

  const norm1 = normalizeRangeText('[ 0 .. 30 % ]');
  assert.equal(norm1.ok, true);
  if (norm1.ok) {
    assert.equal(norm1.canonical, '[0..30%]');
    assert.deepEqual(norm1.range, { from: 0, to: 30 });
  }

  const norm2 = normalizeRangeText('[12,5 .. 80]');
  assert.equal(norm2.ok, true);
  if (norm2.ok) {
    assert.equal(norm2.canonical, '[12.5..80%]');
  }

  const badNorm = normalizeRangeText('[80..20%]');
  assert.equal(badNorm.ok, false);
});

test('Stage 4 (34–36): проценты — только пространственные якоря; короткое (1.5с) и длинное (12с) аудио проходят одну и ту же дистанцию [0..30%] за своё время аудио', () => {
  const panel = makePanel(1, {
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 30 },
  });

  // Короткое аудио 1.5с и длинное аудио 12.0с на одной и той же полосе [0..30%]
  const shortTl = buildTimeline([panel], { 1: 1.5 }, {}, 0, 0, { mode: 'real' });
  const longTl = buildTimeline([panel], { 1: 12.0 }, {}, 0, 0, { mode: 'real' });

  assert.equal(shortTl[0].audioEnd - shortTl[0].audioStart, 1.5);
  assert.equal(longTl[0].audioEnd - longTl[0].audioStart, 12.0);

  const layout = computeStripLayout(
    [{ width: 1000, height: 3000 }],
    { frameWidth: 1000, frameHeight: 400 }
  );
  const shortSpans = buildStripScrollSpans(shortTl, layout, [panel]);
  const longSpans = buildStripScrollSpans(longTl, layout, [panel]);

  // Пространственные координаты startPx и endPx идентичны в обоих случаях!
  assert.equal(shortSpans[0].startPx, longSpans[0].startPx);
  assert.equal(shortSpans[0].endPx, longSpans[0].endPx);

  // Камера в начале (t=0) и в конце (t=duration) в точности совпадает по Y, отличается только скорость
  const shortY0 = cameraYForSpan(shortSpans[0], 0);
  const longY0 = cameraYForSpan(longSpans[0], 0);
  const shortYEnd = cameraYForSpan(shortSpans[0], 1.5);
  const longYEnd = cameraYForSpan(longSpans[0], 12.0);

  assert.equal(shortY0, longY0);
  assert.equal(shortYEnd, longYEnd);
  assert.ok(shortYEnd > shortY0);

  // Посередине времени (0.75с для короткого, 6.0с для длинного) камера ровно посередине прохода
  const shortMid = cameraYForSpan(shortSpans[0], 0.75);
  const longMid = cameraYForSpan(longSpans[0], 6.0);
  assert.ok(Math.abs(shortMid - longMid) < 1e-6);
});

test('Stage 4 (37–40): соседние полосы одного изображения без отката назад, режим паузы hold vs interpolate, целая картинка [0..100%] и обратное время timeAtScroll', () => {
  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 30 } }),
    makePanel(2, { order: 1, imageIndex: 0, bbox: { x: 0, y: 30, width: 100, height: 30 } }),
    makePanel(3, { order: 2, imageIndex: 0, bbox: { x: 0, y: 60, width: 100, height: 40 } }),
  ];

  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 2, panelBbox: panels[0].bbox }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 2.5, audioEnd: 4.5, panelBbox: panels[1].bbox }),
    makeSeg({ panelId: 3, imageIndex: 0, audioStart: 5.0, audioEnd: 8.0, panelBbox: panels[2].bbox }),
  ];

  const sceneHold = createStripScene({
    sizes: [{ width: 1000, height: 3000 }],
    images: [null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 400 },
  });

  // Проверка отсутствия отката назад между соседними полосами [0..30%] -> [30..60%] -> [60..100%]
  let prevY = -Infinity;
  for (let t = 0; t <= 8.0; t += 0.25) {
    const yHold = sceneHold.scrollAt(t);
    assert.ok(yHold >= prevY - 1e-6, `Откат камеры назад при t=${t}: ${yHold} < ${prevY}`);
    prevY = yHold;
  }

  // Во время паузы 2.0..2.5 в режиме 'hold' камера стоит на месте (endPx первого прохода)
  const yAt2_0 = sceneHold.scrollAt(2.0);
  const yAt2_25Hold = sceneHold.scrollAt(2.25);
  assert.ok(Math.abs(yAt2_0 - yAt2_25Hold) < 1e-6);

  // Обратное отображение Y -> t (п. 40: ручной скролл / drag двигает ProjectClock)
  const midY = sceneHold.scrollAt(3.5);
  const recoveredT = sceneHold.timeAtScroll(midY);
  assert.ok(recoveredT !== null && recoveredT >= 0);

  // Направление прокрутки ленты (п. 64)
  const dir = scrollDirectionAt(sceneHold.keyframes, 1.0);
  assert.equal(dir, 'down');
});

test('Stage 5 (41–50): единая геометрия дорожки trackRect, инвариант позиций 0 / duration/2 / duration, зум вокруг курсора и автоскролл', () => {
  const duration = 20;
  const geom = computeTimelineGeometry({
    duration,
    zoom: 2,
    viewportWidth: 1000,
    trackOffset: 72,
  });

  // Инвариант геометрии (п. 50): в точках 0, duration/2, duration время <-> X совпадают на всех дорожках
  const x0 = geom.timeToTrackPx(0);
  const xHalf = geom.timeToTrackPx(duration / 2);
  const xEnd = geom.timeToTrackPx(duration);

  assert.equal(x0, 0);
  assert.ok(Math.abs(xHalf - geom.trackWidth / 2) < 1e-6);
  assert.ok(Math.abs(xEnd - geom.trackWidth) < 1e-6);

  assert.ok(Math.abs(geom.trackPxToTime(x0) - 0) < 1e-6);
  assert.ok(Math.abs(geom.trackPxToTime(xHalf) - duration / 2) < 1e-6);
  assert.ok(Math.abs(geom.trackPxToTime(xEnd) - duration) < 1e-6);

  // Геометрия сегментов одинакова для Видео и Аудио дорожек
  const segGeom = geom.segmentGeometry(0, duration / 2);
  assert.ok(Math.abs(segGeom.leftPx - 0) < 1e-6);
  assert.ok(Math.abs(segGeom.widthPx - geom.trackWidth / 2) < 1e-6);

  // Зум вокруг выбранного времени сохраняет экранное положение anchorTime (п. 44, 45)
  const anchorTime = 7.5;
  const currentScrollLeft = 200;
  const geomWithScroll = computeTimelineGeometry({
    duration,
    zoom: 2,
    scrollLeft: currentScrollLeft,
    viewportWidth: 1000,
    trackOffset: 72,
  });
  const anchorViewportBefore = geomWithScroll.timeToViewportPx(anchorTime);

  const zoomed = computeZoomAroundTime({
    duration,
    oldZoom: 2,
    newZoom: 4,
    oldScrollLeft: currentScrollLeft,
    viewportWidth: 1000,
    anchorTime,
    trackOffset: 72,
  });

  const newGeom = computeTimelineGeometry({
    duration,
    zoom: zoomed.zoom,
    scrollLeft: zoomed.scrollLeft,
    viewportWidth: 1000,
    trackOffset: 72,
  });
  const anchorViewportAfter = newGeom.timeToViewportPx(anchorTime);
  assert.ok(Math.abs(anchorViewportAfter - anchorViewportBefore) < 2.0);

  // Автоскролл при выходе красного курсора за правую границу видимого окна (п. 43)
  const nextScroll = computeAutoFollowScrollLeft({
    currentTime: 18,
    duration,
    zoom: 4,
    scrollLeft: 0,
    viewportWidth: 1000,
    trackOffset: 72,
  });
  assert.ok(nextScroll > 0);

  // Визуализация межрепликовых пауз panelGap (п. 48)
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 2, audioEnd: 5 }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 5.6, audioEnd: 9 }),
  ];
  const gaps = computeTimelineGaps(tl, geom);
  assert.equal(gaps.length, 1);
  assert.ok(Math.abs(gaps[0].duration - 0.6) < 1e-6);
});

test('Stage 7 (61–70) & Stage 9 (81): единый сэмплер кадра sampleCameraFrame для превью и экспорта, дедупликация Canvas и диагностика ресурсов', () => {
  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 50 } }),
    makePanel(2, { order: 1, imageIndex: 1, bbox: { x: 0, y: 0, width: 100, height: 100 }, fullFrame: true }),
  ];
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 3.0, panelBbox: panels[0].bbox }),
    makeSeg({ panelId: 2, imageIndex: 1, audioStart: 3.5, audioEnd: 6.5, panelBbox: panels[1].bbox }),
  ];

  const stripScene = createStripScene({
    sizes: [
      { width: 1000, height: 2000 },
      { width: 1000, height: 2000 },
    ],
    images: [null, null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 500 },
  });

  const sampleAt2 = sampleCameraFrame({
    time: 2.0,
    timeline: tl,
    panels,
    introDuration: 1.0,
    outroDuration: 1.0,
    renderMode: 'strip',
    strip: { scene: stripScene },
    viewportWidth: 1000,
    viewportHeight: 500,
  });

  assert.equal(sampleAt2.phase, 'panel');
  assert.equal(sampleAt2.activePanelId, 1);
  assert.equal(sampleAt2.activeImageIndex, 0);
  assert.ok(sampleAt2.stripScrollY >= 0);

  // Клик по миниатюре страницы находит первый сегмент этой страницы (п. 67)
  const firstOnPage2 = resolveFirstSegmentForPage(1, panels, tl);
  assert.ok(firstOnPage2);
  assert.equal(firstOnPage2.panelId, 2);
  assert.equal(firstOnPage2.seekTime, 3.5);

  // Дедупликация перерисовок Canvas при неизменном состоянии (п. 69)
  const dedup = new CanvasFrameDeduplicator();
  assert.equal(dedup.shouldDraw(sampleAt2.frameSignature), true);
  assert.equal(dedup.shouldDraw(sampleAt2.frameSignature), false);

  // Раздельная диагностика «нет изображения» vs «нет аудио» (п. 70)
  const diagMissingAudio = diagnoseSlotResources({
    panel: panels[0],
    hasImageResource: true,
    hasAudioResource: false,
  });
  assert.equal(diagMissingAudio.hasImage, true);
  assert.equal(diagMissingAudio.hasAudio, false);
  assert.ok(diagMissingAudio.missingAudioMessage?.includes('озвучка'));
});

test('Итерация 2 — Задача 7 и Задача 10: линейная камера строго внутри [seg.audioStart, seg.audioEnd], стоп в паузах и полный запрет gapMode: interpolate', () => {
  // Настройка: кадр 1000x500, страница 1000x1000 -> height=1000
  // Сегмент 1: [1.0, 4.0], полоса [0..80%] -> yTop=0, yBot=800 -> startPx=0, endPx=800-500=300
  // Пауза до 4.6 с, Сегмент 2: [4.6, 6.6], полоса [30..100%] на той же странице (startPx=300, endPx=500)
  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 80 } }),
    makePanel(2, { order: 1, imageIndex: 0, bbox: { x: 0, y: 30, width: 100, height: 70 } }),
  ];
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 4.0, panelBbox: panels[0].bbox }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 4.6, audioEnd: 6.6, panelBbox: panels[1].bbox }),
  ];

  const scene = createStripScene({
    sizes: [
      { width: 1000, height: 1000 },
    ],
    images: [null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 500, gap: 0 },
  });

  const spans = buildStripScrollSpans(tl, scene.layout, panels);
  assert.equal(spans[0].startPx, 0);
  assert.equal(spans[0].endPx, 300);

  // Доказательство Задачи 7:
  assert.equal(scene.scrollAt(1.0), 0);
  assert.equal(scene.scrollAt(2.5), 150);
  assert.equal(scene.scrollAt(4.0), 300);
  // В межсегментной паузе [4.0, 4.6) камера стоит на 300
  assert.equal(scene.scrollAt(4.1), 300);
  assert.equal(scene.scrollAt(4.3), 300);
  assert.equal(scene.scrollAt(4.59), 300);

  // Постоянство производной внутри [1.0, 4.0]: скорость 100 px/s
  const dt = 0.05;
  for (let t = 1.0; t < 3.95; t = Number((t + dt).toFixed(4))) {
    const v = (scene.scrollAt(t + dt) - scene.scrollAt(t)) / dt;
    assert.ok(Math.abs(v - 100) < 1e-6, `Ожидалась постоянная скорость 100 px/s на t=${t}, получено ${v}`);
  }

  // Доказательство Задачи 10: передача gapMode: 'interpolate' бросает ошибку
  assert.throws(
    () =>
      createStripScene({
        sizes: [{ width: 1000, height: 800 }],
        images: [null],
        timeline: tl.slice(0, 1),
        panels: panels.slice(0, 1),
        options: { frameWidth: 1000, frameHeight: 500, ...({ gapMode: 'interpolate' } as Record<string, unknown>) },
      }),
    /камера на паузах всегда в режиме 'hold'/
  );
});

test('Итерация 2 — Задача 11: интро/аутро камера (дрейф при наличии озвучки, стоп без озвучки)', () => {
  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 100 } }),
  ];
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 3.0, audioEnd: 6.0 }),
  ];
  const scene = createStripScene({
    sizes: [{ width: 1000, height: 1500 }],
    images: [null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 500, gap: 0 },
  });
  const maxY = scene.layout.slots[0].height - 500; // 1000

  // Тест 1: introDuration = 3, introAudioDuration = null -> стоп на 0
  for (const t of [0, 1.5, 2.9]) {
    const s = sampleCameraFrame({
      time: t,
      timeline: tl,
      panels,
      introDuration: 3.0,
      outroDuration: 2.0,
      introAudioDuration: null,
      outroAudioDuration: null,
      renderMode: 'strip',
      strip: { scene },
      viewportWidth: 1000,
      viewportHeight: 500,
    });
    assert.equal(s.phase, 'intro');
    assert.equal(s.cameraMotion, 'hold');
    assert.equal(s.stripScrollY, 0);
  }

  // Тест 2: introDuration = 3, introAudioDuration = 3 -> линейный дрейф 0 -> maxY
  const s0 = sampleCameraFrame({
    time: 0,
    timeline: tl,
    panels,
    introDuration: 3.0,
    outroDuration: 2.0,
    introAudioDuration: 3.0,
    renderMode: 'strip',
    strip: { scene },
    viewportWidth: 1000,
    viewportHeight: 500,
  });
  const sMid = sampleCameraFrame({
    time: 1.5,
    timeline: tl,
    panels,
    introDuration: 3.0,
    outroDuration: 2.0,
    introAudioDuration: 3.0,
    renderMode: 'strip',
    strip: { scene },
    viewportWidth: 1000,
    viewportHeight: 500,
  });
  const sEnd = sampleCameraFrame({
    time: 3.0,
    timeline: tl,
    panels,
    introDuration: 3.0,
    outroDuration: 2.0,
    introAudioDuration: 3.0,
    renderMode: 'strip',
    strip: { scene },
    viewportWidth: 1000,
    viewportHeight: 500,
  });
  assert.equal(s0.cameraMotion, 'drift');
  assert.equal(s0.stripScrollY, 0);
  assert.equal(sMid.cameraMotion, 'drift');
  assert.ok(Math.abs(sMid.stripScrollY - 0.5 * maxY) < 1e-4);
  assert.equal(sEnd.stripScrollY, maxY);

  // Тест 3: introDuration = 4, introAudioDuration = 2.5 -> на [2.5, 4.0] stripScrollY === maxY (hold)
  const tl4: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 4.0, audioEnd: 7.0 }),
  ];
  for (const t of [2.5, 3.2, 4.0]) {
    const sHold = sampleCameraFrame({
      time: t,
      timeline: tl4,
      panels,
      introDuration: 4.0,
      outroDuration: 2.0,
      introAudioDuration: 2.5,
      renderMode: 'strip',
      strip: { scene },
      viewportWidth: 1000,
      viewportHeight: 500,
    });
    assert.equal(sHold.stripScrollY, maxY);
    assert.equal(sHold.cameraMotion, 'drift');
  }
});

test('Итерация 2 — Задача 8 и P1 (5, 12, 13, 14): Preview и экспорт рисуют из sampleCameraFrame (совпадение в t ∈ {0, 1.5, 3, 5, 5.5} в режимах panels и strip)', () => {
  // Проверяем, что Preview.tsx не вызывает stripScene.scrollAt напрямую в рендере
  const previewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/studio/Preview.tsx'), 'utf-8');
  assert.equal(previewSrc.includes('.scrollAt('), false, 'Preview.tsx не должен вызывать scrollAt в обход sampleCameraFrame');
  assert.equal(previewSrc.includes('const scrollY = sample.stripScrollY'), true, 'Preview.tsx должен передавать sample.stripScrollY в stripScene.render');

  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 60 } }),
    makePanel(2, { order: 1, imageIndex: 0, bbox: { x: 0, y: 60, width: 100, height: 40 } }),
  ];
  // Интро: [0..1.0], Панель 1: [1.0..3.0], Пауза: [3.0..3.5], Панель 2: [3.5..5.0], Аутро: [5.0..6.0]
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 3.0, panelBbox: panels[0].bbox }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 3.5, audioEnd: 5.0, panelBbox: panels[1].bbox }),
  ];

  const scene = createStripScene({
    sizes: [{ width: 1000, height: 1500 }],
    images: [null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 500, gap: 24 },
  });

  const fakeCtx = {
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

  // Сравнение Preview (sampleCameraFrame) и Экспорта (renderExportFrameToCanvas) на сетке t ∈ [0, 6.0] с шагом 0.05
  // и явно в контрольных точках t ∈ {0, 1.5, 3, 5, 5.5} в обоих режимах (panels и strip)
  const checkPoints = [0, 1.5, 3.0, 5.0, 5.5];
  for (let i = 0; i <= 120; i++) {
    const t = Number((i * 0.05).toFixed(2));
    for (const mode of ['panels', 'strip'] as const) {
      const previewSample = sampleCameraFrame({
        time: t,
        timeline: tl,
        panels,
        introDuration: 1.0,
        outroDuration: 1.0,
        introAudioDuration: 1.0,
        outroAudioDuration: 1.0,
        renderMode: mode,
        strip: mode === 'strip' ? { scene } : null,
        viewportWidth: 1000,
        viewportHeight: 500,
      });
      const exportSample = renderExportFrameToCanvas({
        ctx: fakeCtx,
        width: 1000,
        height: 500,
        time: t,
        options: {
          images: [],
          panels,
          timeline: tl,
          audioBlobs: [],
          introText: 'Интро',
          outroText: 'Аутро',
          introDuration: 1.0,
          outroDuration: 1.0,
          introAudioDuration: 1.0,
          outroAudioDuration: 1.0,
          srtContent: '',
          fps: 30,
          musicVolume: 0.2,
          renderMode: mode,
        },
        loadedImages: new Map(),
        stripScene: mode === 'strip' ? scene : null,
      });

      assert.equal(previewSample.phase, exportSample.phase);
      assert.equal(previewSample.cameraMotion, exportSample.cameraMotion);
      assert.equal(previewSample.stripScrollY, exportSample.stripScrollY);
      assert.equal(previewSample.panelProgress, exportSample.panelProgress);
      assert.equal(previewSample.frameSignature, exportSample.frameSignature);

      if (checkPoints.includes(t) && mode === 'strip') {
        if (t === 0) assert.equal(previewSample.stripScrollY, 0);
        if (t === 1.5) assert.equal(previewSample.stripScrollY, 100); // 25% пути [0..400] на [1.0..3.0]
        if (t === 3.0) assert.equal(previewSample.stripScrollY, 400); // стоп в паузе [3.0..3.5]
        if (t === 5.0) assert.equal(previewSample.stripScrollY, 0); // старт аутро-дрейфа
        if (t === 5.5) assert.equal(previewSample.stripScrollY, 500); // середина аутро-дрейфа [0..1000]
      }
    }
  }

  // P1 п. 5: изменение stripGap / frameHeight меняет frameSignature (перерисовка дедупликатора)
  const sceneDifferentGap = createStripScene({
    sizes: [{ width: 1000, height: 1500 }],
    images: [null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 450, gap: 48 },
  });
  const sigA = sampleCameraFrame({
    time: 2.0,
    timeline: tl,
    panels,
    introDuration: 1.0,
    outroDuration: 1.0,
    renderMode: 'strip',
    strip: { scene },
    viewportWidth: 1000,
    viewportHeight: 500,
  }).frameSignature;
  const sigB = sampleCameraFrame({
    time: 2.0,
    timeline: tl,
    panels,
    introDuration: 1.0,
    outroDuration: 1.0,
    renderMode: 'strip',
    strip: { scene: sceneDifferentGap },
    viewportWidth: 1000,
    viewportHeight: 450,
  }).frameSignature;
  const dedup = new CanvasFrameDeduplicator();
  assert.equal(dedup.shouldDraw(sigA), true);
  assert.equal(dedup.shouldDraw(sigB), true, 'Смена параметров ленты должна пробивать дедупликатор');

  // P1 п. 12: computeZoomAroundTime без округления scrollLeft сохраняет якорь с точностью < 0.5 px при 10 циклах зума туда-обратно
  let zoom = 2.0;
  let scrollLeft = 180;
  const initialGeom = computeTimelineGeometry({
    duration: 60,
    zoom,
    scrollLeft,
    viewportWidth: 900,
    trackOffset: 72,
  });
  const anchorT = 17.35;
  const initialViewportX = initialGeom.timeToViewportPx(anchorT);
  for (let cycle = 0; cycle < 10; cycle++) {
    const zIn = computeZoomAroundTime({
      duration: 60,
      oldZoom: zoom,
      newZoom: 5.5,
      oldScrollLeft: scrollLeft,
      viewportWidth: 900,
      anchorTime: anchorT,
    });
    const zOut = computeZoomAroundTime({
      duration: 60,
      oldZoom: zIn.zoom,
      newZoom: 2.0,
      oldScrollLeft: zIn.scrollLeft,
      viewportWidth: 900,
      anchorTime: anchorT,
    });
    zoom = zOut.zoom;
    scrollLeft = zOut.scrollLeft;
  }
  const finalGeom = computeTimelineGeometry({
    duration: 60,
    zoom,
    scrollLeft,
    viewportWidth: 900,
    trackOffset: 72,
  });
  assert.ok(Math.abs(finalGeom.timeToViewportPx(anchorT) - initialViewportX) < 0.5);

  // P1 п. 13: плавный computeAutoFollowScrollLeft (коэффициент 0.2)
  const smoothScroll = computeAutoFollowScrollLeft({
    currentTime: 20,
    duration: 60,
    zoom: 4,
    scrollLeft: 0,
    viewportWidth: 800,
    smoothing: 0.2,
  });
  const instantScroll = computeAutoFollowScrollLeft({
    currentTime: 20,
    duration: 60,
    zoom: 4,
    scrollLeft: 0,
    viewportWidth: 800,
    smoothing: 1.0,
  });
  assert.ok(Math.abs(smoothScroll - instantScroll * 0.2) < 1e-6);

  // P1 п. 14: scrollDirectionAt с dt = 1/60 на коротком сегменте 60 мс
  const shortScene = createStripScene({
    sizes: [{ width: 1000, height: 1500 }],
    images: [null],
    timeline: [makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 1.06, panelBbox: { x: 0, y: 0, width: 100, height: 80 } })],
    panels: [makePanel(1, { bbox: { x: 0, y: 0, width: 100, height: 80 } })],
    options: { frameWidth: 1000, frameHeight: 500, gap: 0 },
  });
  assert.equal(scrollDirectionAt(shortScene.keyframes, 1.02), 'down');
});

test('Итерация 2.1 — Б1 (Задача 1): побитовое совпадение drawImage offset между Preview и Export (renderPanel) в режиме panels для bbox [0..30%] на t ∈ {0, 1, 2}', () => {
  // Проверяем, что assembleVideo.ts не использует старый getKenBurnsParams в renderPanel
  const assembleSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/pipeline/assembleVideo.ts'), 'utf-8');
  assert.equal(assembleSrc.includes('getKenBurnsParams'), false, 'renderPanel в assembleVideo.ts не должен использовать getKenBurnsParams');
  assert.equal(assembleSrc.includes('drawPanelWithCamera('), true, 'renderPanel в assembleVideo.ts должен использовать drawPanelWithCamera');

  const panel = makePanel(1, {
    order: 0,
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 30 }, // [0..30%]
  });
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 2.0, panelBbox: panel.bbox }),
  ];

  const fakeImg = { width: 1000, height: 2000 } as unknown as HTMLImageElement;
  const imgUrl = 'data:image/png;base64,fake';
  const loadedImages = new Map<string, HTMLImageElement>([[imgUrl, fakeImg]]);

  const w = 1280;
  const h = 720;

  for (const t of [0, 1.0, 2.0]) {
    // 1. Записываем вызов ctx.drawImage со стороны Preview (sampleCameraFrame + drawPanelWithCamera)
    let previewDrawCall: [number, number, number, number] | null = null;
    const previewCtx = {
      drawImage: (_img: unknown, ox: number, oy: number, dw: number, dh: number) => {
        previewDrawCall = [ox, oy, dw, dh];
      },
    } as unknown as CanvasRenderingContext2D;

    const previewSample = sampleCameraFrame({
      time: t,
      renderMode: 'panels',
      panels: [panel],
      timeline: tl,
      introDuration: 0,
      outroDuration: 0,
      viewportWidth: w,
      viewportHeight: h,
    });
    const previewProgress =
      (previewSample.phase === 'intro' || previewSample.phase === 'outro') && previewSample.cameraMotion === 'hold'
        ? 0
        : previewSample.panelProgress;
    drawPanelWithCamera(previewCtx, fakeImg, w, h, previewSample.yRange, previewProgress);

    // 2. Записываем вызов ctx.drawImage со стороны Export (renderExportFrameToCanvas -> renderPanel)
    let exportDrawCall: [number, number, number, number] | null = null;
    const exportCtx = {
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
      drawImage: (_img: unknown, ox: number, oy: number, dw: number, dh: number) => {
        exportDrawCall = [ox, oy, dw, dh];
      },
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

    renderExportFrameToCanvas({
      ctx: exportCtx,
      width: w,
      height: h,
      time: t,
      options: {
        images: [imgUrl],
        panels: [panel],
        timeline: tl,
        audioBlobs: [],
        introText: '',
        outroText: '',
        introDuration: 0,
        outroDuration: 0,
        srtContent: '',
        fps: 30,
        musicVolume: 0.2,
        renderMode: 'panels',
      },
      loadedImages,
    });

    assert.ok(previewDrawCall, `Preview должен вызвать drawImage на t=${t}`);
    assert.ok(exportDrawCall, `Export должен вызвать drawImage на t=${t}`);
    assert.deepEqual(
      previewDrawCall,
      exportDrawCall,
      `Несовпадение drawImage offset между Preview и Export на t=${t}: ${JSON.stringify(previewDrawCall)} !== ${JSON.stringify(exportDrawCall)}`
    );
  }

  // Проверяем линейность смещения oy по [0..30%] на t ∈ {0, 1, 2}
  const r0 = computePanelCameraDrawRect({ imgWidth: 1000, imgHeight: 2000, canvasWidth: w, canvasHeight: h, yRange: [0, 30], progress: 0 });
  const r1 = computePanelCameraDrawRect({ imgWidth: 1000, imgHeight: 2000, canvasWidth: w, canvasHeight: h, yRange: [0, 30], progress: 0.5 });
  const r2 = computePanelCameraDrawRect({ imgWidth: 1000, imgHeight: 2000, canvasWidth: w, canvasHeight: h, yRange: [0, 30], progress: 1.0 });
  assert.equal(Math.abs(r0.oy), 0);
  assert.ok(r2.oy < 0, 'Камера должна смещаться вниз по полосе [0..30%]');
  assert.ok(Math.abs(r1.oy - 0.5 * r2.oy) < 1e-6, 'На t=1s смещение должно быть ровно половиной от t=2s');
});

test('Итерация 2.1 — Б2 (Задача 2): отсутствие скачка на стыке полос [0..30%] -> [40..70%] одного изображения (|scrollAt(t+dt) - scrollAt(t)| < maxSpeed*dt + 1px)', () => {
  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 30 } }), // [0..30%]
    makePanel(2, { order: 1, imageIndex: 0, bbox: { x: 0, y: 40, width: 100, height: 30 } }), // [40..70%]
  ];
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 0.0, audioEnd: 3.0, panelBbox: panels[0].bbox }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 3.6, audioEnd: 6.6, panelBbox: panels[1].bbox }),
  ];

  const scene = createStripScene({
    sizes: [{ width: 1000, height: 2000 }],
    images: [null],
    timeline: tl,
    panels,
    options: { frameWidth: 1000, frameHeight: 500, gap: 0 },
  });

  // Для [0..30%]: startPx=0, endPx=600-500=100; для [40..70%]: startPx=800, endPx=1400-500=900
  // Разница на стыке = 700 px за min(0.15, gap/2) = 0.15 с (пиковая скорость smoothstep = 1.5 * 700 / 0.15 = 7000 px/s)
  const maxSpeed = 7000;
  const dt = 0.005;

  // На [3.0, 3.45] до окна сглаживания 0.15 с камера держит prevEndPx = 100
  assert.equal(scene.scrollAt(3.0), 100);
  assert.equal(scene.scrollAt(3.2), 100);
  assert.equal(scene.scrollAt(3.45), 100);

  // Проверяем непрерывность |scrollAt(t+dt) - scrollAt(t)| < maxSpeed*dt + 1 на всём протяжении [0, 6.6]
  for (let t = 0; t <= 6.6 - dt; t = Number((t + dt).toFixed(4))) {
    const y0 = scene.scrollAt(t);
    const y1 = scene.scrollAt(t + dt);
    const stepDiff = Math.abs(y1 - y0);
    assert.ok(
      stepDiff < maxSpeed * dt + 1,
      `Обнаружен скачок камеры на t=${t} -> ${t + dt}: |${y1} - ${y0}| = ${stepDiff.toFixed(2)} px >= ${(maxSpeed * dt + 1).toFixed(2)} px`
    );
  }
});

test('Итерация 2.1 — Задачи 4, 5 и P1 (8, 13): 0 совпадений stripGapMode в src/, clockTime в Preview.tsx только для formatTime, scrollLeft в Timeline.tsx и panelProgress=0 для fullFrame', () => {
  // Задача 4: grep 'stripGapMode' src/ -> 0 совпадений
  const srcRoot = path.resolve(process.cwd(), 'src');
  const walkFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkFiles(full));
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
    return out;
  };
  const forbiddenProp = 'stripGap' + 'Mode';
  for (const file of walkFiles(srcRoot)) {
    const content = fs.readFileSync(file, 'utf-8');
    assert.equal(
      content.includes(forbiddenProp),
      false,
      `В файле ${path.relative(process.cwd(), file)} найдено устаревшее свойство ${forbiddenProp}`
    );
  }

  // Задача 5: clockTime в Preview.tsx используется только в useState и в JSX для formatTime, не в sampleCameraFrame
  const previewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/studio/Preview.tsx'), 'utf-8');
  const clockTimeLines = previewSrc
    .split('\n')
    .map(l => l.trim())
    .filter(l => !l.startsWith('//') && !l.startsWith('*') && /\bclockTime\b/.test(l));
  assert.equal(clockTimeLines.length, 2, `Ожидалось ровно 2 вхождения clockTime (useState и formatTime), найдено: ${JSON.stringify(clockTimeLines)}`);
  assert.ok(clockTimeLines[0].includes('useState('));
  assert.ok(clockTimeLines[1].includes('formatTime('));
  assert.equal(previewSrc.includes('const frameTime = clock ? clock.getTime() : currentTime;'), true);

  // P1 п. 8: Timeline.tsx передаёт актуальный scrollLeft в computeTimelineGeometry (не scrollLeft: 0)
  const timelineSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/studio/Timeline.tsx'), 'utf-8');
  assert.equal(timelineSrc.includes('scrollLeft: 0'), false, 'Timeline.tsx должен передавать актуальный scrollLeft в computeTimelineGeometry');

  // P1 п. 13: для fullFrame-панели panelProgress === 0 и frameSignature неизменна внутри сегмента
  const ffPanel = makePanel(1, { fullFrame: true, bbox: { x: 0, y: 0, width: 100, height: 100 } });
  const ffTl = [makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 4.0 })];
  const sA = sampleCameraFrame({
    time: 1.5,
    renderMode: 'panels',
    panels: [ffPanel],
    timeline: ffTl,
    introDuration: 1.0,
    outroDuration: 1.0,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  const sB = sampleCameraFrame({
    time: 3.2,
    renderMode: 'panels',
    panels: [ffPanel],
    timeline: ffTl,
    introDuration: 1.0,
    outroDuration: 1.0,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  assert.equal(sA.panelProgress, 0);
  assert.equal(sB.panelProgress, 0);
  assert.equal(sA.frameSignature, sB.frameSignature);
});

test('Задача 3.1.3 (Н-3.3): useSyncExternalStore и computePreviewHeaderSelectorKey обновляют селектор шапки при смене фазы/панели/yRange/stripScrollDirection и не вызывают лишних ререндеров внутри одной полосы', () => {
  const previewSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/components/studio/Preview.tsx'), 'utf-8');
  assert.ok(
    previewSrc.includes('useSyncExternalStore(') && previewSrc.includes('computePreviewHeaderSelectorKey('),
    'Preview.tsx должен подписываться на clock через useSyncExternalStore с computePreviewHeaderSelectorKey'
  );

  const panels: PanelData[] = [
    makePanel(1, { order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 45 } }),
    makePanel(2, { order: 1, imageIndex: 0, bbox: { x: 0, y: 50, width: 100, height: 50 } }),
  ];
  const tl: SyncTimeline[] = [
    makeSeg({ panelId: 1, imageIndex: 0, audioStart: 1.0, audioEnd: 3.0, panelBbox: panels[0].bbox }),
    makeSeg({ panelId: 2, imageIndex: 0, audioStart: 3.5, audioEnd: 6.0, panelBbox: panels[1].bbox }),
  ];

  // Внутри одной полосы [1.2, 2.6] ключ-селектор идентичен (нет ререндеров шапки на каждом rAF)
  const s1a = sampleCameraFrame({
    time: 1.2,
    renderMode: 'panels',
    panels,
    timeline: tl,
    introDuration: 1.0,
    outroDuration: 1.0,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  const s1b = sampleCameraFrame({
    time: 2.6,
    renderMode: 'panels',
    panels,
    timeline: tl,
    introDuration: 1.0,
    outroDuration: 1.0,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  assert.equal(computePreviewHeaderSelectorKey(s1a), computePreviewHeaderSelectorKey(s1b));

  // При переходе в gap (t=3.2) и во вторую полосу с другим yRange (t=4.0) ключ меняется
  const sGap = sampleCameraFrame({
    time: 3.2,
    renderMode: 'panels',
    panels,
    timeline: tl,
    introDuration: 1.0,
    outroDuration: 1.0,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  const s2 = sampleCameraFrame({
    time: 4.0,
    renderMode: 'panels',
    panels,
    timeline: tl,
    introDuration: 1.0,
    outroDuration: 1.0,
    viewportWidth: 1280,
    viewportHeight: 720,
  });
  assert.notEqual(computePreviewHeaderSelectorKey(s1a), computePreviewHeaderSelectorKey(sGap));
  assert.notEqual(computePreviewHeaderSelectorKey(sGap), computePreviewHeaderSelectorKey(s2));
  assert.ok(computePreviewHeaderSelectorKey(s2).includes('50:100'));
});

