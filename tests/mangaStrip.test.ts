import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRIP_SCENARIOS } from './fixtures/stripScenarios';
import {
  buildScrollKeyframes,
  buildScrollSpans,
  clampScroll,
  computeStripLayout,
  createStripScene,
  maxScrollY,
  pageIndexAtScroll,
  renderStripFrame,
  resolveStripViewport,
  sampleScroll,
  STRIP_SLOT_LIMITS,
  STRIP_ZOOM_MAX,
  STRIP_ZOOM_MIN,
  targetScrollForSlot,
  timeAtScroll,
  timeForScrollContinuous,
  visibleSlots,
} from '../src/lib/pipeline/mangaStrip';

const FRAME = { frameWidth: 1920, frameHeight: 1080 };
const PAGES = [
  { width: 1000, height: 1000 },
  { width: 1000, height: 2000 },
];

test('computeStripLayout: страницы масштабируются по ширине кадра, gap между ними', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });

  assert.equal(layout.scale, 1);
  assert.equal(layout.width, 1920);
  assert.equal(layout.slots[0].height, 1920);
  assert.equal(layout.slots[1].height, 3840);
  assert.equal(layout.slots[1].y, 1920 + 24);
  assert.equal(layout.totalHeight, 1920 + 24 + 3840);
  assert.equal(maxScrollY(layout), layout.totalHeight - FRAME.frameHeight);
});

// Табличные сценарии: новый кейс добавляется объектом в fixtures/stripScenarios.ts
for (const scenario of STRIP_SCENARIOS) {
  test(`сценарий ленты: ${scenario.name}`, () => {
    const layout = computeStripLayout(scenario.sizes, {
      ...FRAME,
      viewport: scenario.viewport,
      gap: scenario.gap,
    });

    assert.equal(layout.slots.length, scenario.expectedHeights.length, 'число страниц');
    layout.slots.forEach((slot, i) => {
      assert.ok(
        Math.abs(slot.height - scenario.expectedHeights[i]) < 0.5,
        `страница ${i}: высота ${slot.height}, ожидали ${scenario.expectedHeights[i]}`
      );
    });
    assert.ok(
      Math.abs(layout.totalHeight - scenario.expectedTotalHeight) < 0.5,
      `полная высота ${layout.totalHeight}, ожидали ${scenario.expectedTotalHeight}`
    );
    if (scenario.expectClamped) {
      assert.equal(layout.slots.some(sl => sl.height >= 12000), true, 'лимит высоты сработал');
    }
  });
}

test('лента: зум клампится к диапазону ползунка — битые настройки не ломают раскладку', () => {
  assert.equal(resolveStripViewport(1080, 1080), 1080, 'нормальное значение не трогаем');
  assert.equal(resolveStripViewport(1080, undefined), 1080, 'без настройки — дефолт');
  assert.equal(resolveStripViewport(1080, Number.NaN), 1080, 'NaN — дефолт, а не NaN в раскладке');
  assert.equal(resolveStripViewport(1080, 0), 1080, 'ноль — дефолт');
  assert.equal(resolveStripViewport(1080, 100000), 1080 / STRIP_ZOOM_MIN, 'слишком мелкий зум зажат');
  assert.equal(resolveStripViewport(1080, 10), 1080 / STRIP_ZOOM_MAX, 'слишком крупный зум зажат');

  const wild = computeStripLayout(PAGES, { ...FRAME, viewport: 100000, gap: 24 });
  const bounded = computeStripLayout(PAGES, { ...FRAME, viewport: resolveStripViewport(1080, 100000), gap: 24 });
  assert.deepEqual(wild, bounded, 'computeStripLayout клампит сам, а не полагается на вызывающего');
});

test('computeStripLayout: viewport меньше кадра → крупнее (лента шире кадра)', () => {
  const zoom = computeStripLayout(PAGES, { ...FRAME, viewport: 720, gap: 0 });
  assert.equal(zoom.scale, 1.5);
  assert.equal(zoom.width, 2880);
  assert.equal(zoom.slots[0].height, 2880);
  assert.equal(zoom.totalHeight, 2880 + 5760);

  const wide = computeStripLayout(PAGES, { ...FRAME, viewport: 1620, gap: 0 });
  assert.ok(wide.scale < 1, 'большой viewport показывает больше контекста');
  assert.ok(wide.totalHeight < zoom.totalHeight);
});

test('computeStripLayout: защита от панорам 1px и «бесконечных» страниц', () => {
  const layout = computeStripLayout(
    [
      { width: 10000, height: 10 }, // панорама-полоска
      { width: 100, height: 100000 }, // «бесконечный» вебтун
    ],
    { ...FRAME, viewport: 1080, gap: 24 }
  );
  assert.ok(layout.slots[0].height >= 240, 'слишком низкая страница растянута до минимума');
  assert.ok(layout.slots[1].height <= STRIP_SLOT_LIMITS.max, 'слишком высокая обрезана по максимуму');
});

// ---- Длинная webtoon-полоса: пропорции не должны страдать от лимитов ----

test('computeStripLayout: полоса 900×12540 не плющится и не обрезается потолком', () => {
  const source = { width: 900, height: 12540 };
  const layout = computeStripLayout([source], { ...FRAME, viewport: 1080, gap: 24 });
  const slot = layout.slots[0];
  const sourceAspect = source.height / source.width;

  assert.equal(slot.width, layout.width, 'полоса занимает всю ширину ленты');
  assert.equal(slot.x, 0);
  assert.equal(slot.drawHeight, slot.height, 'содержимое рисуется на всю высоту слота');
  assert.ok(
    Math.abs(slot.height / slot.width - sourceAspect) < 1e-9,
    `пропорции сохранены: ${slot.height / slot.width} вместо ${sourceAspect}`
  );
  assert.ok(slot.height > 20000, `виртуальная высота полосы ${slot.height} не упирается в старый потолок 12000`);
  assert.ok(slot.height <= STRIP_SLOT_LIMITS.max, 'потолок всё ещё защищает от мусорных размеров');
});

test('computeStripLayout: слишком высокая страница ограничивается по ширине, а не по пропорциям', () => {
  const source = { width: 100, height: 100000 };
  const layout = computeStripLayout([source], { ...FRAME, viewport: 1080, gap: 0 });
  const slot = layout.slots[0];

  assert.equal(slot.height, STRIP_SLOT_LIMITS.max);
  assert.ok(
    Math.abs(slot.height / slot.width - source.height / source.width) < 1e-6,
    'ширина уменьшена пропорционально, картинка не растянута'
  );
  assert.ok(slot.width < layout.width, 'страница уже ленты');
  assert.ok(Math.abs(slot.x - (layout.width - slot.width) / 2) < 1e-6, 'страница центрирована в ленте');
});

test('computeStripLayout: панорама дотягивается до минимума без вертикального растяжения', () => {
  const layout = computeStripLayout([{ width: 10000, height: 10 }], { ...FRAME, viewport: 1080, gap: 0 });
  const slot = layout.slots[0];

  assert.equal(slot.height, 240, 'минимальная высота слота сохранена');
  assert.equal(slot.width, layout.width, 'ширина ленты не раздувается');
  assert.ok(slot.drawHeight < slot.height, 'содержимое ниже слота — оно центрируется, а не растягивается');
  assert.ok(
    Math.abs(slot.drawHeight / slot.width - 10 / 10000) < 1e-6,
    'тонкая полоска сохраняет свои пропорции'
  );
});

test('renderStripFrame: рисуется только видимый срез, пропорции длинной полосы сохранены', () => {
  const source = { width: 900, height: 12540 };
  const layout = computeStripLayout([source], { ...FRAME, viewport: 1080, gap: 24 });
  const calls: Array<[number, number, number, number, number, number, number, number]> = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    fillRect: () => {}, strokeRect: () => {}, save: () => {}, restore: () => {},
    beginPath: () => {}, rect: () => {}, clip: () => {}, translate: () => {}, scale: () => {},
    drawImage: (
      _img: unknown,
      sx: number, sy: number, sw: number, sh: number,
      dx: number, dy: number, dw: number, dh: number
    ) => calls.push([sx, sy, sw, sh, dx, dy, dw, dh]),
  } as unknown as CanvasRenderingContext2D;

  renderStripFrame(ctx, { layout, images: [{ width: source.width, height: source.height } as CanvasImageSource], scrollY: 0, kenBurnsAmount: 0 });
  assert.equal(calls.length, 1, 'страница рисуется одним срезом');
  const [sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
  assert.equal(dw, layout.width, 'полоса на всю ширину кадра');
  assert.equal(dx, 0, 'без горизонтальных полей');
  assert.equal(dy, 0, 'верх полосы у верха кадра при scrollY=0');
  assert.equal(dh, layout.frameHeight, 'в кадр попадает ровно высота кадра');
  assert.ok(
    Math.abs(sh / sw - dh / dw) < 1e-9,
    `срез исходника масштабируется без искажений: ${sh / sw} вместо ${dh / dw}`
  );
  assert.ok(
    Math.abs(layout.slots[0].height / layout.slots[0].width - source.height / source.width) < 1e-9,
    'полная страница в раскладке сохраняет пропорции'
  );
  assert.equal(sx, 0, 'срез начинается с левого края исходника');
  assert.equal(sy, 0, 'срез начинается с верха исходника');
  assert.equal(sw, source.width, 'по ширине взят весь исходник');
  assert.ok(
    Math.abs(sh - (layout.frameHeight / layout.slots[0].height) * source.height) < 1e-6,
    'из исходника берётся ровно та полоса, что видна в кадре'
  );
  assert.ok(sh < source.height, 'высокая полоса не растеризуется целиком');
});

test('renderStripFrame: срез следует за скроллом и не выходит за исходник', () => {
  const source = { width: 900, height: 12540 };
  const layout = computeStripLayout([source], { ...FRAME, viewport: 1080, gap: 0 });
  const calls: Array<[number, number, number, number]> = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    fillRect: () => {}, strokeRect: () => {}, save: () => {}, restore: () => {},
    beginPath: () => {}, rect: () => {}, clip: () => {}, translate: () => {}, scale: () => {},
    drawImage: (_img: unknown, sx: number, sy: number, _sw: number, sh: number) => calls.push([sx, sy, _sw, sh]),
  } as unknown as CanvasRenderingContext2D;
  const image = { width: source.width, height: source.height } as CanvasImageSource;
  const max = maxScrollY(layout);

  renderStripFrame(ctx, { layout, images: [image], scrollY: max / 2, kenBurnsAmount: 0 });
  const [, syMid, , shMid] = calls[0];
  assert.ok(syMid > 0, `середина ленты берёт середину исходника, получено ${syMid}`);
  assert.ok(syMid + shMid <= source.height + 1e-6, 'срез не выходит за низ исходника');

  calls.length = 0;
  renderStripFrame(ctx, { layout, images: [image], scrollY: max, kenBurnsAmount: 0 });
  const [, syEnd, , shEnd] = calls[0];
  assert.ok(Math.abs(syEnd + shEnd - source.height) < 1e-6, 'в конце ленты срез доходит до низа исходника');
});

test('scroll: клампится в границы ленты, target центрирует страницу', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  assert.equal(targetScrollForSlot(layout, 0), 420); // 1920/2 - 540
  assert.equal(clampScroll(-100, layout), 0);
  assert.equal(clampScroll(10 ** 9, layout), maxScrollY(layout));
});

test('visibleSlots: за кадром остаются только пересекающиеся страницы', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  assert.deepEqual(visibleSlots(layout, 0).map(s => s.index), [0]);
  const second = visibleSlots(layout, 2000).map(s => s.index);
  assert.deepEqual(second, [1]);
});

test('длинная лента не упирается в лимит canvas 32767px', () => {
  const many = Array.from({ length: 40 }, () => ({ width: 1000, height: 1500 }));
  const layout = computeStripLayout(many, { ...FRAME, viewport: 1080, gap: 24 });
  assert.ok(layout.totalHeight > 32767, 'лента заведомо выше лимита canvas');

  // Рисуем только окно: одновременно видно 1–2 страницы, а не всю ленту.
  const visible = visibleSlots(layout, layout.totalHeight / 2);
  assert.ok(visible.length <= 2, `видимых страниц должно быть мало, а не ${visible.length}`);
});

test('buildScrollSpans: страницы группируются по imageIndex, соседние панели склеиваются', () => {
  const spans = buildScrollSpans(
    [
      { panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 3 },
      { panelId: 2, imageIndex: 0, audioStart: 3, audioEnd: 6 },
      { panelId: 3, imageIndex: 1, audioStart: 6, audioEnd: 8 },
    ]
  );
  assert.deepEqual(spans, [
    { slotIndex: 0, start: 0, end: 6 },
    { slotIndex: 1, start: 6, end: 8 },
  ]);
});

test('buildScrollSpans: работает без imageIndex в таймлайне (fallback на panels)', () => {
  const spans = buildScrollSpans(
    [{ panelId: 7, audioStart: 1, audioEnd: 4 }],
    [{ id: 7, imageIndex: 2 }]
  );
  assert.deepEqual(spans, [{ slotIndex: 2, start: 1, end: 4 }]);
});

test('buildScrollKeyframes: страница держится, переход — в хвосте интервала', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const keys = buildScrollKeyframes(
    [
      { slotIndex: 0, start: 0, end: 5 },
      { slotIndex: 1, start: 5, end: 9 },
    ],
    layout,
    { transition: 0.8, panInside: false }
  );

  const firstTarget = targetScrollForSlot(layout, 0);
  const secondTarget = targetScrollForSlot(layout, 1);

  assert.equal(sampleScroll(keys, 0), firstTarget);
  assert.equal(sampleScroll(keys, 0.5), firstTarget, 'в начале интервала окно стоит');
  assert.equal(sampleScroll(keys, 4.2), firstTarget, 'перед переходом всё ещё стоит');
  assert.equal(sampleScroll(keys, 5), secondTarget, 'к концу интервала переход завершён');
  assert.equal(sampleScroll(keys, 9), secondTarget, 'после последней страницы окно стоит');
});

test('buildScrollKeyframes: переход плавный (easeInOut), а не рывок', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const keys = buildScrollKeyframes(
    [
      { slotIndex: 0, start: 0, end: 5 },
      { slotIndex: 1, start: 5, end: 9 },
    ],
    layout,
    { transition: 1, panInside: false }
  );

  const from = targetScrollForSlot(layout, 0);
  const to = targetScrollForSlot(layout, 1);
  const middle = sampleScroll(keys, 4.5);
  // smoothstep на середине даёт ровно половину пути
  assert.ok(Math.abs(middle - (from + to) / 2) < 1, `середина перехода ≈ ${(from + to) / 2}, получено ${middle}`);
  // и не выходит за границы
  assert.ok(middle > from && middle < to);
});

test('buildScrollKeyframes: короткая страница над короткой — переход всё равно виден', () => {
  // Регрессия: ключ удержания следующей короткой страницы (span.start) совпадает по
  // времени с переходом к ней (span.end предыдущей). Раньше удержание брало target и
  // затирало посчитанный нудж — переход схлопывался до 4 px. Проверяем именно стык
  // двух коротких страниц, когда прокрутка в принципе возможна (третья — длинная).
  const layout = computeStripLayout(
    [{ width: 1920, height: 240 }, { width: 1920, height: 240 }, { width: 1920, height: 800 }],
    { ...FRAME, viewport: 720, gap: 4 }
  );
  const transition = 1;
  const keys = buildScrollKeyframes(
    [
      { slotIndex: 0, start: 0, end: 4 },
      { slotIndex: 1, start: 4, end: 7 },
      { slotIndex: 2, start: 7, end: 11 },
    ],
    layout,
    { transition, panInside: true }
  );

  const from = sampleScroll(keys, 4 - transition - 0.01);
  const to = sampleScroll(keys, 4 + 0.01);
  assert.ok(Math.abs(to - from) >= 8, `сдвиг на стыке ${from} → ${to}, ожидали ≥ 8 px`);
});

test('buildScrollKeyframes: меньше 8 px окно едет только упёршись в границу ленты', () => {
  // Инвариант вместо запрета: если сдвиг на стыке < 8 px, значит окно уже на пределе
  // (0 или maxScrollY) — двигать нечего, а не «нудж потерялся» где-то внутри.
  const atBound = (v: number, max: number) => Math.abs(v) < 1e-6 || Math.abs(v - max) < 1e-6;
  for (const h0 of [240, 500, 1080]) {
    for (const h2 of [800, 3000]) {
      for (const gap of [0, 4, 8, 24]) {
        for (const viewport of [720, 1080]) {
        const layout = computeStripLayout(
          [
            { width: 1920, height: h0 },
            { width: 1920, height: 240 },
            { width: 1920, height: h2 },
          ],
          { ...FRAME, viewport, gap }
        );
        const max = maxScrollY(layout);
        if (max <= 8) continue; // прокрутки нет — переход и не требуется

        const keys = buildScrollKeyframes(
          [
            { slotIndex: 0, start: 0, end: 4 },
            { slotIndex: 1, start: 4, end: 7 },
            { slotIndex: 2, start: 7, end: 11 },
          ],
          layout,
          { transition: 1, panInside: true }
        );

        for (const end of [4, 7]) {
          const from = sampleScroll(keys, end - 1.01);
          const to = sampleScroll(keys, end + 0.01);
          if (Math.abs(to - from) < 8) {
            assert.ok(
              atBound(from, max) && atBound(to, max),
              `h=${h0}/${h2} gap=${gap} vp=${viewport} стык@${end}: ${from} → ${to}, max=${max} — сдвиг потерян не у границы`
            );
          }
        }
        }
      }
    }
  }
});

test('buildScrollKeyframes: страница выше кадра проезжается (webtoon-чтение)', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const keys = buildScrollKeyframes([{ slotIndex: 1, start: 0, end: 10 }], layout, {
    transition: 0.8,
    panInside: true,
  });

  const top = clampScroll(layout.slots[1].y, layout);
  const bottom = clampScroll(layout.slots[1].y + layout.slots[1].height - FRAME.frameHeight, layout);

  assert.equal(sampleScroll(keys, 0), top);
  assert.equal(sampleScroll(keys, 9.2), bottom, 'к концу озвучки страница прочитана до низа');
  const middle = sampleScroll(keys, 4.6);
  assert.ok(middle > top && middle < bottom, 'середина между верхом и низом');
});

test('buildScrollKeyframes: панель может быть выключена (panInside=false)', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const keys = buildScrollKeyframes([{ slotIndex: 1, start: 0, end: 10 }], layout, { panInside: false });
  const value = sampleScroll(keys, 5);
  assert.equal(value, sampleScroll(keys, 0), 'без проезда окно стоит на месте');
});

test('buildScrollKeyframes: ПОСЛЕДНЯЯ длинная страница не откатывается наверх', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  // Последняя страница — длинный вебтун (slotIndex: 1), после неё панелей нет.
  const keys = buildScrollKeyframes([{ slotIndex: 1, start: 0, end: 10 }], layout, {
    transition: 0.8,
    panInside: true,
  });

  const bottom = clampScroll(layout.slots[1].y + layout.slots[1].height - FRAME.frameHeight, layout);
  const center = targetScrollForSlot(layout, 1);
  assert.notEqual(bottom, center, 'низ и центр длинной страницы — разные позиции');

  assert.equal(sampleScroll(keys, 9.2), bottom, 'к концу озвучки окно у низа страницы');
  assert.equal(sampleScroll(keys, 10), bottom, 'и остаётся там, а не прыгает в центр');
  assert.equal(sampleScroll(keys, 12), bottom, 'после конца интервала позиция не меняется');
});

test('buildScrollKeyframes: короткая последняя страница остаётся центрированной', () => {
  // 1000×600 при ширине ленты 1920 даёт высоту 1152 > 1080 — берём заведомо низкую.
  const short = computeStripLayout([{ width: 1000, height: 400 }], { ...FRAME, viewport: 1080, gap: 0 });
  assert.ok(short.slots[0].height < FRAME.frameHeight, 'страница ниже кадра');
  const keys = buildScrollKeyframes([{ slotIndex: 0, start: 0, end: 5 }], short, { panInside: true });
  assert.equal(sampleScroll(keys, 5), targetScrollForSlot(short, 0), 'позиция = центр страницы');
});

test('computeStripLayout: minSlotHeight не масштабируется дважды', () => {
  const panorama = [{ width: 10000, height: 10 }];
  const normal = computeStripLayout(panorama, { ...FRAME, viewport: 1080, gap: 0 });
  const zoomed = computeStripLayout(panorama, { ...FRAME, viewport: 720, gap: 0 });

  assert.equal(normal.scale, 1);
  assert.equal(normal.slots[0].height, 240, 'при scale=1 минимум = 240');

  assert.equal(zoomed.scale, 1.5);
  assert.equal(zoomed.slots[0].height, 360, 'при scale=1.5 минимум = 240×1.5 = 360, а не 540');
});

test('createStripSceneFromMedia: работает без imageIndex в таймлайне, если переданы panels', async () => {
  const { createStripSceneFromMedia } = await import('../src/lib/pipeline/mangaStrip');
  const scene = createStripSceneFromMedia({
    images: ['a', 'b'],
    loaded: new Map(),
    timeline: [{ panelId: 1, audioStart: 0, audioEnd: 4 }],
    panels: [{ id: 1, imageIndex: 0 }],
    frameWidth: 1920,
    frameHeight: 1080,
  });
  assert.ok(scene, 'сцена создаётся');
  assert.equal(scene!.keyframes.length > 1, true, 'спаны построены по panels, а не пустые');
  assert.ok(scene!.layout.slots.length === 2);
});

test('createStripSceneFromMedia: imageIndex из таймлайна приоритетнее panels', async () => {
  const { createStripSceneFromMedia } = await import('../src/lib/pipeline/mangaStrip');
  const scene = createStripSceneFromMedia({
    images: ['a', 'b'],
    loaded: new Map(),
    timeline: [{ panelId: 1, imageIndex: 1, audioStart: 0, audioEnd: 4 }],
    panels: [{ id: 1, imageIndex: 0 }],
    frameWidth: 1920,
    frameHeight: 1080,
  });
  assert.ok(scene);
  // сцена должна уехать ко второй странице
  assert.ok(scene!.keyframes.some(k => k.y > 0), 'есть отличная от нуля позиция скролла');
});

test('стык двух ДЛИННЫХ страниц: переход сохраняет easeInOut и не теряет плавность', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const keys = buildScrollKeyframes(
    [
      { slotIndex: 0, start: 0, end: 6 },
      { slotIndex: 1, start: 6, end: 12 },
    ],
    layout,
    { transition: 1, panInside: true }
  );

  const junction = keys.find(k => Math.abs(k.time - 6) < 1e-4);
  assert.ok(junction, 'ключ на стыке есть');
  assert.equal(junction!.ease, 'easeInOut', 'стык длинных страниц — мягкий переход, а не замена на linear');

  // Движение на стыке не мгновенное: середина перехода лежит между страницами
  const before = sampleScroll(keys, 5);
  const mid = sampleScroll(keys, 5.5);
  const after = sampleScroll(keys, 6);
  assert.ok(mid > before && mid < after, `плавное движение: ${before} → ${mid} → ${after}`);

  // И сам переход ведёт в верх следующей (длинной) страницы, а не в её центр
  const top2 = clampScroll(layout.slots[1].y, layout);
  assert.ok(Math.abs(after - top2) < 1e-6, 'приходим к верху длинной страницы');
});

test('sampleScroll: пустые ключи и время до первого', () => {
  assert.equal(sampleScroll([], 5), 0);
  assert.equal(sampleScroll([{ time: 2, y: 100, ease: 'linear' }], 0), 100);
});

test('timeForScrollContinuous: точная инверсия линейного сегмента', () => {
  const keys = [
    { time: 0, y: 0, ease: 'linear' as const },
    { time: 4, y: 400, ease: 'linear' as const },
  ];
  for (const t of [0, 0.5, 1, 2.37, 3.9, 4]) {
    const y = sampleScroll(keys, t);
    assert.ok(Math.abs(timeForScrollContinuous(keys, y) - t) < 1e-6, `t=${t}`);
  }
  // Клампинг за границы траектории
  assert.equal(timeForScrollContinuous(keys, -50), 0);
  assert.equal(timeForScrollContinuous(keys, 9999), 4);
  assert.equal(timeForScrollContinuous([], 100), 0);
});

test('timeForScrollContinuous: холд не заставляет время прыгать назад (hintTime)', () => {
  const keys = [
    { time: 0, y: 0, ease: 'linear' as const },
    { time: 2, y: 0, ease: 'linear' as const },
    { time: 4, y: 400, ease: 'linear' as const },
  ];
  // Позиция холда достижима на всём интервале [0, 2] — hint удерживает время на месте
  assert.equal(timeForScrollContinuous(keys, 0, 1.25), 1.25);
  assert.equal(timeForScrollContinuous(keys, 0, 0.4), 0.4);
  // Без hint возвращается начало плато
  assert.equal(timeForScrollContinuous(keys, 0), 0);
  // После холда инверсия снова точная
  const y = sampleScroll(keys, 3);
  assert.ok(Math.abs(timeForScrollContinuous(keys, y, 3) - 3) < 1e-6);
});

test('timeForScrollContinuous: инверсия easeInOut монотонна и попадает в якоря', () => {
  const keys = [
    { time: 0, y: 100, ease: 'linear' as const },
    { time: 2, y: 100, ease: 'linear' as const },
    { time: 3, y: 500, ease: 'easeInOut' as const },
    { time: 5, y: 500, ease: 'linear' as const },
  ];
  // Внутри перехода инверсия строго в его временном окне и монотонна
  let prevT = 2;
  for (let y = 101; y < 500; y += 10) {
    const t = timeForScrollContinuous(keys, y, prevT);
    assert.ok(t > 2 - 1e-9 && t < 3 + 1e-9, `инверсия внутри перехода (y=${y}, t=${t})`);
    assert.ok(t >= prevT - 1e-9, `время не убывает по мере скролла вниз (y=${y})`);
    prevT = t;
  }
  // Якоря: на холдах hint удерживает время, без hint — начало плато
  assert.equal(timeForScrollContinuous(keys, 100, 1), 1);
  assert.equal(timeForScrollContinuous(keys, 100), 0);
  assert.equal(timeForScrollContinuous(keys, 500, 5), 5);
  // Без hint верхняя граница клампится к последнему времени траектории
  assert.equal(timeForScrollContinuous(keys, 500), 5);
});

test('timeForScrollContinuous: ручной скролл на реальной сцене с диапазонами непрерывен', () => {
  const panels = [
    { id: 1, order: 0, imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 30 } },
    { id: 2, order: 1, imageIndex: 0, bbox: { x: 0, y: 30, width: 100, height: 30 } },
    { id: 3, order: 2, imageIndex: 0, bbox: { x: 0, y: 60, width: 100, height: 40 } },
  ];
  const timeline = [
    { panelId: 1, imageIndex: 0, audioStart: 0, audioEnd: 2 },
    { panelId: 2, imageIndex: 0, audioStart: 2.5, audioEnd: 4.5 },
    { panelId: 3, imageIndex: 0, audioStart: 5, audioEnd: 8 },
  ];
  const scene = createStripScene({
    sizes: [{ width: 1000, height: 3000 }],
    images: [null],
    timeline,
    panels,
    options: { frameWidth: FRAME.frameWidth, frameHeight: FRAME.frameHeight, gap: 0 },
  })!;

  // Траектория неубывает — предпосылка бинарного поиска инверсии
  let prevY = -Infinity;
  for (let t = 0; t <= 8; t += 0.01) {
    const y = scene.scrollAt(t);
    assert.ok(y >= prevY - 1e-6, `траектория откатывается назад при t=${t}`);
    prevY = y;
  }

  // Гладкость = визуальная непрерывность: время, полученное из позиции y,
  // возвращает камеру ровно в y (round-trip), а само время не убывает.
  const max = maxScrollY(scene.layout);
  let prevT = 0;
  for (let y = 0; y <= max; y += 1) {
    const t = scene.timeAtScrollContinuous(y, prevT);
    assert.ok(t >= prevT - 1e-9, `время не убывает при скролле вниз (y=${y})`);
    const backY = scene.scrollAt(t);
    assert.ok(Math.abs(backY - y) <= 1.5, `round-trip позиции y=${y} дал ${backY}`);
    prevT = t;
  }

  // Семантический timeAtScroll дискретен (снап к audioStart панелей) —
  // именно он давал ступеньки при ручной прокрутке.
  const semanticPoints = new Set<number>();
  for (let y = 0; y <= max; y += 4) {
    semanticPoints.add(scene.timeAtScroll(y) ?? -1);
  }
  assert.ok(
    semanticPoints.size <= timeline.length + 1,
    `семантический маппинг должен снапить к границам реплик, получено точек: ${semanticPoints.size}`
  );
});

test('pageIndexAtScroll: центр окна определяет активную страницу', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  assert.equal(pageIndexAtScroll(layout, 0), 0);
  assert.equal(pageIndexAtScroll(layout, maxScrollY(layout)), 1);
  assert.equal(pageIndexAtScroll(computeStripLayout([], FRAME), 0), null);
});

test('короткие страницы с совпадающей позицией: переход всё равно заметен', () => {
  // Две страницы одинаковой высоты дают одинаковые центры — раньше окно не
  // двигалось вовсе, и смена страницы не читалась.
  const layout = computeStripLayout(
    [
      { width: 1000, height: 400 },
      { width: 1000, height: 400 },
    ],
    { ...FRAME, viewport: 1080, gap: 24 }
  );
  const keys = buildScrollKeyframes(
    [
      { slotIndex: 0, start: 0, end: 4 },
      { slotIndex: 1, start: 4, end: 8 },
    ],
    layout,
    { transition: 1, panInside: true }
  );

  const first = sampleScroll(keys, 3);
  const second = sampleScroll(keys, 4.1);
  assert.ok(Math.abs(second - first) >= 8, `окно должно сместиться (${first} → ${second})`);

  // и остаётся в границах ленты
  const max = maxScrollY(layout);
  assert.ok(second >= 0 && second <= max);
});

// ---- Задача 1: маппинг panelId ⇄ пиксели скролла и обратный seek ----

test('timeAtScroll: верх страницы — первая панель, низ — вторая; края — null/смысл', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const timeline = [
    { panelId: 0, imageIndex: 0, audioStart: 0, audioEnd: 3 },
    { panelId: 1, imageIndex: 0, audioStart: 3.6, audioEnd: 6 },
    { panelId: 2, imageIndex: 1, audioStart: 6.6, audioEnd: 10 },
  ];
  assert.equal(timeAtScroll(layout, timeline, 0), 0, 'верх ленты → первая панель');
  assert.equal(timeAtScroll(layout, timeline, 630), 3.6, '75% диапазона страницы → вторая панель страницы');
  assert.equal(timeAtScroll(layout, timeline, 1944), 6.6, 'верх второй страницы → её панель');
  assert.equal(timeAtScroll(layout, timeline, 4704), 6.6, 'конец ленты → панель последней страницы');
  assert.equal(timeAtScroll(layout, [], 0), null, 'пустой таймлайн → null');
  const emptyLayout = computeStripLayout([], { ...FRAME, viewport: 1080, gap: 24 });
  assert.equal(timeAtScroll(emptyLayout, timeline, 0), null, 'пустая лента → null');
});

test('лента → время → лента: scrollAt(t) приводит к панели, которая реально звучит', () => {
  const layout = computeStripLayout(PAGES, { ...FRAME, viewport: 1080, gap: 24 });
  const timeline = [
    { panelId: 0, imageIndex: 0, audioStart: 0, audioEnd: 3 },
    { panelId: 1, imageIndex: 1, audioStart: 3.6, audioEnd: 10 },
  ];
  const keys = buildScrollKeyframes(buildScrollSpans(timeline), layout, { transition: 0.8 });
  for (const t of [1.5, 5, 7, 9]) {
    const scroll = sampleScroll(keys, t);
    const panelTime = timeAtScroll(layout, timeline, scroll);
    const active = timeline.find(s => t >= s.audioStart && t < s.audioEnd);
    assert.ok(active, `t=${t}: должен быть активный сегмент`);
    assert.equal(panelTime, active.audioStart, `t=${t}: scroll ${scroll.toFixed(0)} → панель ${active.audioStart}`);
  }
});
