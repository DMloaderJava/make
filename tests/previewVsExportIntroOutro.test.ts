import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStripScene } from '../src/lib/pipeline/mangaStrip';
import { renderExportFrameToCanvas } from '../src/lib/pipeline/assembleVideo';
import { drawPreviewFrameToCanvas } from '../src/components/studio/Preview';
import type { PanelData, SyncTimeline } from '../src/lib/storage/db';

interface RecordedCanvasCalls {
  drawImages: Array<[number, number, number, number]>;
  fillTexts: Array<[string, number, number]>;
  fillRects: Array<[string, number, number, number, number]>;
  gradients: Array<Array<[number, string]>>;
  linearGradientCalls: number;
}

function createRecordingCanvasContext(): {
  ctx: CanvasRenderingContext2D;
  calls: RecordedCanvasCalls;
} {
  const calls: RecordedCanvasCalls = {
    drawImages: [],
    fillTexts: [],
    fillRects: [],
    gradients: [],
    linearGradientCalls: 0,
  };

  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    shadowColor: '',
    shadowBlur: 0,
    fillRect: (x: number, y: number, w: number, h: number) => {
      calls.fillRects.push([
        String(ctx.fillStyle),
        Number(x.toFixed(4)),
        Number(y.toFixed(4)),
        Number(w.toFixed(4)),
        Number(h.toFixed(4)),
      ]);
    },
    strokeRect: () => {},
    clearRect: () => {},
    fillText: (text: string, x: number, y: number) => {
      calls.fillTexts.push([String(text), Number(x.toFixed(4)), Number(y.toFixed(4))]);
    },
    strokeText: () => {},
    drawImage: (_img: unknown, ...rest: number[]) => {
      if (rest.length === 4) {
        const [ox, oy, dw, dh] = rest;
        calls.drawImages.push([
          Number(ox.toFixed(4)),
          Number(oy.toFixed(4)),
          Number(dw.toFixed(4)),
          Number(dh.toFixed(4)),
        ]);
      } else if (rest.length === 8) {
        const [, , , , dx, dy, dw, dh] = rest;
        calls.drawImages.push([
          Number(dx.toFixed(4)),
          Number(dy.toFixed(4)),
          Number(dw.toFixed(4)),
          Number(dh.toFixed(4)),
        ]);
      }
    },
    save: () => {},
    restore: () => {},
    translate: () => {},
    scale: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    clip: () => {},
    rect: () => {},
    roundRect: () => {},
    fill: () => {},
    measureText: (txt: string) => ({ width: String(txt).length * 9 }),
    createLinearGradient: () => {
      calls.linearGradientCalls += 1;
      const stops: Array<[number, string]> = [];
      calls.gradients.push(stops);
      return {
        addColorStop: (offset: number, color: string) => {
          stops.push([offset, color]);
        },
      };
    },
  } as unknown as CanvasRenderingContext2D;

  return { ctx, calls };
}

const imgUrl0 = 'data:image/png;base64,page0';
const imgUrl1 = 'data:image/png;base64,page1';
const fakeImg0 = { width: 1000, height: 2000 } as unknown as HTMLImageElement;
const fakeImg1 = { width: 1000, height: 2000 } as unknown as HTMLImageElement;

const panels: PanelData[] = [
  {
    id: 1,
    order: 0,
    imageIndex: 0,
    bbox: { x: 0, y: 0, width: 100, height: 40 },
    dialogue: 'Реплика первой панели внутри сцены',
    character: 'Акира',
    emotion: 'neutral',
    type: 'speech',
  },
  {
    id: 2,
    order: 1,
    imageIndex: 1,
    bbox: { x: 0, y: 20, width: 100, height: 50 },
    dialogue: 'Реплика второй панели в финале',
    character: 'Рей',
    emotion: 'serious',
    type: 'speech',
  },
];

const introDuration = 2.0;
const outroDuration = 2.0;
const timeline: SyncTimeline[] = [
  {
    panelId: 1,
    imageIndex: 0,
    audioStart: 2.0,
    audioEnd: 4.5,
    panelBbox: panels[0].bbox,
    voiceId: 'default',
    text: panels[0].dialogue,
    character: panels[0].character,
  },
  {
    panelId: 2,
    imageIndex: 1,
    audioStart: 5.0,
    audioEnd: 8.0,
    panelBbox: panels[1].bbox,
    voiceId: 'default',
    text: panels[1].dialogue,
    character: panels[1].character,
  },
];
const duration = 10.0; // 8.0 + outroDuration (2.0)
const introText = 'Глава 1: Тень над Токио';
const outroText = 'Продолжение следует в главе 2';
const width = 1280;
const height = 720;

test('Задача 3.1.1 (Н-3.1) и Б-2.1: побитовое совпадение fillRect, fillText и drawImage между Preview и Export на t ∈ {0, introDuration/2, introDuration + 0.1, duration - 0.1, duration} в режимах panels и strip', () => {
  const loadedImages = new Map<string, HTMLImageElement>([
    [imgUrl0, fakeImg0],
    [imgUrl1, fakeImg1],
  ]);

  const stripScene = createStripScene({
    sizes: [
      { width: 1000, height: 2000 },
      { width: 1000, height: 2000 },
    ],
    images: [fakeImg0, fakeImg1],
    timeline,
    panels,
    options: { frameWidth: width, frameHeight: height, gap: 24 },
  });

  const probeTimes = [
    0,
    introDuration / 2,
    introDuration + 0.1,
    duration - 0.1,
    duration,
  ];

  for (const mode of ['panels', 'strip'] as const) {
    for (const t of probeTimes) {
      const previewRec = createRecordingCanvasContext();
      const exportRec = createRecordingCanvasContext();

      const previewSample = drawPreviewFrameToCanvas({
        ctx: previewRec.ctx,
        width,
        height,
        time: t,
        renderMode: mode,
        images: [imgUrl0, imgUrl1],
        loadedImages,
        panels,
        timeline,
        introText,
        outroText,
        introDuration,
        outroDuration,
        introAudioDuration: introDuration,
        outroAudioDuration: outroDuration,
        duration,
        stripScene: mode === 'strip' ? stripScene : null,
        debugOverlay: false,
        showProgressBar: false,
      });

      const exportSample = renderExportFrameToCanvas({
        ctx: exportRec.ctx,
        width,
        height,
        time: t,
        options: {
          images: [imgUrl0, imgUrl1],
          panels,
          timeline,
          audioBlobs: [],
          introText,
          outroText,
          introDuration,
          outroDuration,
          introAudioDuration: introDuration,
          outroAudioDuration: outroDuration,
          srtContent: '',
          fps: 30,
          musicVolume: 0.2,
          renderMode: mode,
        },
        loadedImages,
        stripScene: mode === 'strip' ? stripScene : null,
        showStripProgress: false,
      });

      assert.equal(previewSample.phase, exportSample.phase, `Несовпадение фазы на t=${t}, mode=${mode}`);
      assert.equal(previewRec.calls.linearGradientCalls, 0, `Preview не должен вызывать createLinearGradient на t=${t}, mode=${mode}`);
      assert.equal(exportRec.calls.linearGradientCalls, 0, `Export не должен вызывать createLinearGradient на t=${t}, mode=${mode}`);
      assert.deepEqual(previewRec.calls.gradients, exportRec.calls.gradients);
      assert.deepEqual(
        previewRec.calls.fillRects,
        exportRec.calls.fillRects,
        `Несовпадение fillRect вызовов (fillStyle, x, y, w, h) на t=${t}, mode=${mode}: Preview=${JSON.stringify(
          previewRec.calls.fillRects
        )} vs Export=${JSON.stringify(exportRec.calls.fillRects)}`
      );
      assert.deepEqual(
        previewRec.calls.drawImages,
        exportRec.calls.drawImages,
        `Несовпадение drawImage вызовов (ox, oy, dw, dh) на t=${t}, mode=${mode}`
      );
      assert.deepEqual(
        previewRec.calls.fillTexts,
        exportRec.calls.fillTexts,
        `Несовпадение fillText вызовов (текст, x, y) на t=${t}, mode=${mode}: Preview=${JSON.stringify(
          previewRec.calls.fillTexts
        )} vs Export=${JSON.stringify(exportRec.calls.fillTexts)}`
      );

      const renderedStrings = previewRec.calls.fillTexts.map(([s]) => s).join(' ');
      if (t < introDuration) {
        assert.ok(
          renderedStrings.includes('Глава 1:'),
          `На интро (t=${t}, mode=${mode}) должен рисоваться introText, получено: "${renderedStrings}"`
        );
        assert.equal(
          renderedStrings.includes(panels[0].dialogue),
          false,
          `На интро (t=${t}, mode=${mode}) НЕ должна рисоваться реплика первой панели`
        );
      } else if (t >= duration - outroDuration) {
        assert.ok(
          renderedStrings.includes('Продолжение следует'),
          `На аутро (t=${t}, mode=${mode}) должен рисоваться outroText, получено: "${renderedStrings}"`
        );
        assert.equal(
          renderedStrings.includes(panels[1].dialogue),
          false,
          `На аутро (t=${t}, mode=${mode}) НЕ должна рисоваться реплика последней панели`
        );
      } else if (mode === 'panels') {
        assert.ok(
          renderedStrings.includes('Акира') && renderedStrings.includes('Реплика первой панели'),
          `В фазе panel режима panels (t=${t}) должен рисоваться диалог активной панели`
        );
      }
    }
  }
});

test('Задача 3.1.1 (Н-3.1 подтест): при отсутствии изображений (loadedImages = new Map()) fillRects совпадают побитово между Preview и Export', () => {
  const emptyLoaded = new Map<string, HTMLImageElement>();
  const probeTimes = [0, introDuration / 2, introDuration + 0.1, duration - 0.1, duration];

  for (const mode of ['panels', 'strip'] as const) {
    const emptyStripScene =
      mode === 'strip'
        ? createStripScene({
            sizes: [
              { width: 1000, height: 2000 },
              { width: 1000, height: 2000 },
            ],
            images: [undefined, undefined],
            timeline,
            panels,
            options: { frameWidth: width, frameHeight: height, gap: 24 },
          })
        : null;

    for (const t of probeTimes) {
      const previewRec = createRecordingCanvasContext();
      const exportRec = createRecordingCanvasContext();

      drawPreviewFrameToCanvas({
        ctx: previewRec.ctx,
        width,
        height,
        time: t,
        renderMode: mode,
        images: [imgUrl0, imgUrl1],
        loadedImages: emptyLoaded,
        panels,
        timeline,
        introText,
        outroText,
        introDuration,
        outroDuration,
        introAudioDuration: introDuration,
        outroAudioDuration: outroDuration,
        duration,
        stripScene: emptyStripScene,
        debugOverlay: false,
        showProgressBar: false,
      });

      renderExportFrameToCanvas({
        ctx: exportRec.ctx,
        width,
        height,
        time: t,
        options: {
          images: [imgUrl0, imgUrl1],
          panels,
          timeline,
          audioBlobs: [],
          introText,
          outroText,
          introDuration,
          outroDuration,
          introAudioDuration: introDuration,
          outroAudioDuration: outroDuration,
          srtContent: '',
          fps: 30,
          musicVolume: 0.2,
          renderMode: mode,
        },
        loadedImages: emptyLoaded,
        stripScene: emptyStripScene,
        showStripProgress: false,
      });

      assert.equal(exportRec.calls.linearGradientCalls, 0);
      assert.deepEqual(
        previewRec.calls.fillRects,
        exportRec.calls.fillRects,
        `Несовпадение fillRects без изображений на t=${t}, mode=${mode}`
      );
      assert.deepEqual(
        previewRec.calls.fillTexts,
        exportRec.calls.fillTexts,
        `Несовпадение fillTexts без изображений на t=${t}, mode=${mode}`
      );
    }
  }
});

test('Задача 3.1.6: паритет Preview и Export на точках паузы t ∈ {gap_start, gap_start + gap/2, gap_end} в режимах panels и strip', () => {
  const loadedImages = new Map<string, HTMLImageElement>([
    [imgUrl0, fakeImg0],
    [imgUrl1, fakeImg1],
  ]);

  const stripScene = createStripScene({
    sizes: [
      { width: 1000, height: 2000 },
      { width: 1000, height: 2000 },
    ],
    images: [fakeImg0, fakeImg1],
    timeline,
    panels,
    options: { frameWidth: width, frameHeight: height, gap: 24 },
  });

  const gapStart = timeline[0].audioEnd; // 4.5
  const gapMid = (timeline[0].audioEnd + timeline[1].audioStart) / 2; // 4.75
  const gapEnd = timeline[1].audioStart - 0.001; // 4.999
  const gapProbeTimes = [gapStart, gapMid, gapEnd];

  for (const mode of ['panels', 'strip'] as const) {
    for (const t of gapProbeTimes) {
      const previewRec = createRecordingCanvasContext();
      const exportRec = createRecordingCanvasContext();

      const previewSample = drawPreviewFrameToCanvas({
        ctx: previewRec.ctx,
        width,
        height,
        time: t,
        renderMode: mode,
        images: [imgUrl0, imgUrl1],
        loadedImages,
        panels,
        timeline,
        introText,
        outroText,
        introDuration,
        outroDuration,
        introAudioDuration: introDuration,
        outroAudioDuration: outroDuration,
        duration,
        stripScene: mode === 'strip' ? stripScene : null,
        debugOverlay: false,
        showProgressBar: false,
      });

      const exportSample = renderExportFrameToCanvas({
        ctx: exportRec.ctx,
        width,
        height,
        time: t,
        options: {
          images: [imgUrl0, imgUrl1],
          panels,
          timeline,
          audioBlobs: [],
          introText,
          outroText,
          introDuration,
          outroDuration,
          introAudioDuration: introDuration,
          outroAudioDuration: outroDuration,
          srtContent: '',
          fps: 30,
          musicVolume: 0.2,
          renderMode: mode,
        },
        loadedImages,
        stripScene: mode === 'strip' ? stripScene : null,
        showStripProgress: false,
      });

      assert.equal(previewSample.phase, 'gap');
      assert.equal(exportSample.phase, 'gap');
      assert.equal(previewSample.cameraMotion, 'hold');
      assert.equal(exportSample.cameraMotion, 'hold');
      assert.equal(previewSample.panelProgress, 1);
      assert.equal(exportSample.panelProgress, 1);
      assert.deepEqual(
        previewRec.calls.fillRects,
        exportRec.calls.fillRects,
        `Несовпадение fillRects в gap на t=${t}, mode=${mode}`
      );
      assert.deepEqual(
        previewRec.calls.drawImages,
        exportRec.calls.drawImages,
        `Несовпадение drawImages в gap на t=${t}, mode=${mode}`
      );
      assert.deepEqual(
        previewRec.calls.fillTexts,
        exportRec.calls.fillTexts,
        `Несовпадение fillTexts в gap на t=${t}, mode=${mode}`
      );

      if (mode === 'panels') {
        assert.ok(
          previewRec.calls.fillRects.some(([style]) => style === 'rgba(11,11,12,0.25)'),
          `В режиме panels в gap (t=${t}) должен рисоваться затемняющий слой rgba(11,11,12,0.25)`
        );
      } else {
        assert.equal(
          previewRec.calls.fillTexts.length,
          0,
          `В режиме strip в gap (t=${t}) не должно быть плашек диалога и оверлея`
        );
      }
    }
  }
});

test('Задача 3.3.1 (п. 62): двусторонняя связь выбора панели в Preview и подсветки аудио-клипа (класс selected) в Timeline', () => {
  const previewSrc = readFileSync('src/components/studio/Preview.tsx', 'utf8');
  const timelineSrc = readFileSync('src/components/studio/Timeline.tsx', 'utf8');
  const editorSrc = readFileSync('src/app/editor/[id]/page.tsx', 'utf8');

  assert.ok(
    previewSrc.includes('onSelectPanel?.(first.panelId)'),
    'Preview должен вызывать onSelectPanel при клике по странице'
  );
  assert.ok(
    previewSrc.includes('data-linked-clip-highlight'),
    'Preview должен отображать индикатор связанного клипа при выбранной панели'
  );
  assert.ok(
    editorSrc.includes('selectedPanelId={typeof selectedId === \'number\' ? selectedId : null}'),
    'EditorPage должен передавать selectedPanelId в Preview'
  );
  assert.ok(
    timelineSrc.includes('data-audio-clip-panel={seg.panelId}') &&
      timelineSrc.includes("? 'selected border-[#E8B44C] ring-1 ring-[#6EE7B7] bg-[#164E3E]'") &&
      timelineSrc.includes("? 'selected border-[#E8B44C] ring-1 ring-[#F5D27A] bg-[#57451B]'") &&
      timelineSrc.includes("? 'selected border-[#F5D27A] ring-1 ring-[#E8B44C] bg-[#3A311D] z-10'"),
    'Видео- и аудио-клипы в Timeline должны получать класс selected при совпадении seg.panelId === selectedId'
  );
});
