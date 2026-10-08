/**
 * Состояние кнопки «Озвучить всё» в редакторе.
 *
 * Кнопка не может всё время называться одинаково: после создания панелей,
 * правки текста или удаления аудио часть работы либо не сделана, либо
 * устарела — и пользователь должен видеть это ДО клика, а не гадать,
 * «сработало ли нажатие». Функция чистая, чтобы состояния проверялись
 * юнит-тестами без браузера (tests/voicePipeline.test.ts).
 */

export type VoiceButtonKind = 'empty' | 'none' | 'partial' | 'all';

export interface VoiceButtonState {
  kind: VoiceButtonKind;
  /** Текст кнопки (спиннер и прогресс рисует страница отдельно). */
  label: string;
  /** Подсказка под кнопкой; null — показывать нечего. */
  hint: string | null;
  totalPanels: number;
  voicedCount: number;
  pendingCount: number;
  /** Есть неозвученные панели — кнопку стоит подсветить. */
  needsAttention: boolean;
}

/** Русская плюрализация: 1 панель, 2 панели, 5 панелей, 21 панель. */
export function pluralize(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * @param panels        панели проекта
 * @param voicedPanelIds ID панелей, для которых сейчас есть аудио (audioBlobs)
 * @param audioTexts    снимок текстов на момент последней озвучки (project.audioTexts)
 */
export function getVoiceButtonState(params: {
  panels: Array<{ id: number; dialogue: string }>;
  voicedPanelIds: Iterable<number>;
  audioTexts?: Record<number, string> | null;
}): VoiceButtonState {
  const voicedIds = new Set(params.voicedPanelIds);
  const totalPanels = params.panels.length;

  let voicedCount = 0;
  for (const panel of params.panels) {
    if (!voicedIds.has(panel.id)) continue;
    const snapshot = params.audioTexts?.[panel.id];
    // Аудио есть, но текст панели изменился после озвучки: при следующем
    // прогоне панель уйдёт в TTS заново — для пользователя она «не озвучена».
    // Без снимка (проекты до v1.3.2) панель с аудио считается озвученной.
    if (typeof snapshot === 'string' && snapshot !== panel.dialogue) continue;
    voicedCount += 1;
  }

  const pendingCount = totalPanels - voicedCount;
  const panelsWord = pluralize(totalPanels, 'панель', 'панели', 'панелей');

  if (totalPanels === 0) {
    // Панелей нет — кнопка озвучивает только интро/аутро.
    return { kind: 'empty', label: 'Озвучить всё', hint: null, totalPanels, voicedCount, pendingCount, needsAttention: false };
  }
  if (pendingCount === 0) {
    return { kind: 'all', label: 'Переозвучить всё', hint: null, totalPanels, voicedCount, pendingCount, needsAttention: false };
  }
  if (voicedCount === 0) {
    return {
      kind: 'none',
      label: `Озвучить все ${totalPanels} ${panelsWord}`,
      hint: 'Аудио ещё нет — SRT сейчас черновик, финальным станет после озвучки',
      totalPanels,
      voicedCount,
      pendingCount,
      needsAttention: true,
    };
  }
  return {
    kind: 'partial',
    label: `Озвучить оставшиеся ${pendingCount}`,
    hint: `${voicedCount} из ${totalPanels} озвучено`,
    totalPanels,
    voicedCount,
    pendingCount,
    needsAttention: true,
  };
}
