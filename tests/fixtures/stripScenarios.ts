/**
 * Табличные сценарии раскладки ленты.
 *
 * Добавить новый кейс = добавить объект в массив, а не копипастить блок теста.
 * Ожидаемые значения — в единицах кадра 1920×1080.
 */

export interface StripScenario {
  name: string;
  sizes: Array<{ width: number; height: number }>;
  viewport: number;
  gap: number;
  /** Ожидаемые высоты отрисованных страниц по порядку. */
  expectedHeights: number[];
  /** Ожидаемая полная высота ленты. */
  expectedTotalHeight: number;
  /** Есть ли страницы, обрезанные лимитом maxSlotHeight. */
  expectClamped?: boolean;
}

const FRAME_H = 1080;

export const STRIP_SCENARIOS: StripScenario[] = [
  {
    name: 'страница ровно в кадр (16:9)',
    sizes: [{ width: 1920, height: 1080 }],
    viewport: FRAME_H,
    gap: 0,
    expectedHeights: [1080],
    expectedTotalHeight: 1080,
  },
  {
    name: 'манга-страница 1:1.4 со стандартным отступом',
    sizes: [
      { width: 1000, height: 1400 },
      { width: 1000, height: 1400 },
    ],
    viewport: FRAME_H,
    gap: 24,
    expectedHeights: [2688, 2688],
    expectedTotalHeight: 2688 * 2 + 24,
  },
  {
    name: 'вебтун-полоса 1:3',
    sizes: [{ width: 1080, height: 3240 }],
    viewport: FRAME_H,
    gap: 0,
    expectedHeights: [5760],
    expectedTotalHeight: 5760,
  },
  {
    name: 'панорама-полоска растягивается до минимума',
    sizes: [{ width: 10000, height: 10 }],
    viewport: FRAME_H,
    gap: 0,
    expectedHeights: [240],
    expectedTotalHeight: 240,
  },
  {
    name: 'слишком высокая страница обрезается лимитом',
    sizes: [{ width: 100, height: 100000 }],
    viewport: FRAME_H,
    gap: 0,
    expectedHeights: [12000],
    expectedTotalHeight: 12000,
    expectClamped: true,
  },
  {
    name: 'увеличенный масштаб (viewport 720 = 150 %)',
    sizes: [{ width: 1000, height: 1000 }],
    viewport: 720,
    gap: 0,
    expectedHeights: [2880],
    expectedTotalHeight: 2880,
  },
  {
    name: 'уменьшенный масштаб (viewport 1620 = 67 %)',
    sizes: [{ width: 1000, height: 1000 }],
    viewport: 1620,
    gap: 24,
    expectedHeights: [1280],
    expectedTotalHeight: 1280,
  },
];
