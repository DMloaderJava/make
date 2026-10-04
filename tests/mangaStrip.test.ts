import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRIP_SCENARIOS } from './fixtures/stripScenarios';
import {
  buildScrollKeyframes,
  buildScrollSpans,
  clampScroll,
  computeStripLayout,
  maxScrollY,
  pageIndexAtScroll,
  sampleScroll,
  targetScrollForSlot,
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
  assert.ok(layout.slots[1].height <= 12000, 'слишком высокая обрезана по максимуму');
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
