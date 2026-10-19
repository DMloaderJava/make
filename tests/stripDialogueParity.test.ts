import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStripScene } from '../src/lib/pipeline/mangaStrip';
import { renderExportFrameToCanvas } from '../src/lib/pipeline/assembleVideo';
import { drawPreviewFrameToCanvas } from '../src/components/studio/Preview';
import type { PanelData, SyncTimeline } from '../src/lib/storage/db';

test('Итерация 2.2 — Б-2.2 (stripDialogueParity): в режиме strip в фазах panel и gap ни Preview, ни Export не рисуют плашку drawDialogue (чистый вебтун без плашек)', () => {
  // 1. Проверяем, что архитектурное решение задокументировано в шапке mangaStrip.ts
  const mangaStripSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/lib/pipeline/mangaStrip.ts'),
    'utf-8'
  );
  assert.ok(
    mangaStripSrc.includes('чистым вебтуном без плашек'),
    'В шапке src/lib/pipeline/mangaStrip.ts должно быть явно задокументировано решение Б-2.2'
  );

  // 2. Проверяем паритет на нескольких точках t внутри сегментов и в межрепликовой паузе
  const imgUrl = 'data:image/png;base64,webtoon_strip';
  const fakeImg = { width: 1000, height: 2400 } as unknown as HTMLImageElement;
  const loadedImages = new Map<string, HTMLImageElement>([[imgUrl, fakeImg]]);

  const panels: PanelData[] = [
    {
      id: 1,
      order: 0,
      imageIndex: 0,
      bbox: { x: 0, y: 0, width: 100, height: 40 },
      dialogue: 'Эта фраза уже нарисована в баббле на самой странице манги',
      character: 'Герой',
      emotion: 'neutral',
      type: 'speech',
    },
    {
      id: 2,
      order: 1,
      imageIndex: 0,
      bbox: { x: 0, y: 40, width: 100, height: 45 },
      dialogue: 'Вторая реплика на той же полосе вебтуна',
      character: 'Герой',
      emotion: 'neutral',
      type: 'speech',
    },
  ];

  const timeline: SyncTimeline[] = [
    {
      panelId: 1,
      imageIndex: 0,
      audioStart: 1.0,
      audioEnd: 3.0,
      panelBbox: panels[0].bbox,
      voiceId: 'default',
      text: panels[0].dialogue,
      character: panels[0].character,
    },
    {
      panelId: 2,
      imageIndex: 0,
      audioStart: 3.5,
      audioEnd: 6.0,
      panelBbox: panels[1].bbox,
      voiceId: 'default',
      text: panels[1].dialogue,
      character: panels[1].character,
    },
  ];

  const width = 1280;
  const height = 720;
  const stripScene = createStripScene({
    sizes: [{ width: 1000, height: 2400 }],
    images: [fakeImg],
    timeline,
    panels,
    options: { frameWidth: width, frameHeight: height, gap: 0 },
  });

  // Точки внутри 1-й панели (1.8 с), в паузе между панелями (3.25 с) и внутри 2-й панели (4.5 с)
  for (const t of [1.8, 3.25, 4.5]) {
    const previewTexts: string[] = [];
    const exportTexts: string[] = [];
    const previewImages: Array<[number, number, number, number]> = [];
    const exportImages: Array<[number, number, number, number]> = [];

    const makeCtx = (
      texts: string[],
      imgs: Array<[number, number, number, number]>
    ): CanvasRenderingContext2D =>
      ({
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        font: '',
        textAlign: 'center',
        textBaseline: 'middle',
        fillRect: () => {},
        strokeRect: () => {},
        fillText: (txt: string) => {
          texts.push(String(txt));
        },
        drawImage: (_img: unknown, ox: number, oy: number, dw: number, dh: number) => {
          imgs.push([ox, oy, dw, dh]);
        },
        save: () => {},
        restore: () => {},
        translate: () => {},
        scale: () => {},
        beginPath: () => {},
        closePath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        rect: () => {},
        roundRect: () => {},
        clip: () => {},
        fill: () => {},
        stroke: () => {},
        measureText: (txt: string) => ({ width: String(txt).length * 8 }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
      }) as unknown as CanvasRenderingContext2D;

    drawPreviewFrameToCanvas({
      ctx: makeCtx(previewTexts, previewImages),
      width,
      height,
      time: t,
      renderMode: 'strip',
      images: [imgUrl],
      loadedImages,
      panels,
      timeline,
      introText: 'Интро',
      outroText: 'Аутро',
      introDuration: 1.0,
      outroDuration: 1.0,
      duration: 7.0,
      stripScene,
      showProgressBar: false,
    });

    renderExportFrameToCanvas({
      ctx: makeCtx(exportTexts, exportImages),
      width,
      height,
      time: t,
      options: {
        images: [imgUrl],
        panels,
        timeline,
        audioBlobs: [],
        introText: 'Интро',
        outroText: 'Аутро',
        introDuration: 1.0,
        outroDuration: 1.0,
        srtContent: '',
        fps: 30,
        musicVolume: 0.2,
        renderMode: 'strip',
      },
      loadedImages,
      stripScene,
      showStripProgress: false,
    });

    assert.deepEqual(previewTexts, [], `Preview в режиме strip на t=${t} не должен рисовать плашку drawDialogue`);
    assert.deepEqual(exportTexts, [], `Export в режиме strip на t=${t} не должен рисовать плашку drawDialogue`);
    assert.deepEqual(previewImages, exportImages, `Совпадение drawImage в режиме strip на t=${t}`);
  }
});
