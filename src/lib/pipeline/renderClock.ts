/**
 * Мастер-клок рендера и расчёт задержки старта записи.
 *
 * Вынесено из assembleVideo.ts отдельным модулем не ради красоты: здесь дважды
 * подряд ошибались с учётом `leadIn` (сначала вычитали его дважды, потом один
 * раз, но в другом месте), а проверить это юнит-тестом внутри компонента
 * с canvas нельзя. Теперь формулы живут в чистой функции и покрыты тестами.
 */

/** Через сколько миллисекунд от текущего момента начнётся аудио. */
export function startDelayMs(audioStartedAt: number | null, ctxNow: number | null): number {
  if (audioStartedAt === null || ctxNow === null) return 0;
  return Math.max(0, (audioStartedAt - ctxNow) * 1000);
}

/**
 * Время кадра относительно начала ролика.
 *
 * ВАЖНО: если аудио есть, отсчёт идёт от `audioStartedAt` — момента, когда
 * звук реально начинает играть. Никаких дополнительных поправок на `leadIn`
 * быть не должно: он уже содержится в `audioStartedAt`, и второе вычитание
 * сдвигало картинку на 0.25 с назад относительно звука.
 */
export function frameTime(params: {
  audioStartedAt: number | null;
  ctxNow: number;
  wallNow: number;
  fallbackStart: number;
}): number {
  const { audioStartedAt, ctxNow, wallNow, fallbackStart } = params;
  if (audioStartedAt !== null) {
    return Math.max(0, ctxNow - audioStartedAt);
  }
  return Math.max(0, (wallNow - fallbackStart) / 1000);
}
