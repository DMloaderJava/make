/**
 * Загрузка аудио панелей при открытии проекта (вынесено из редактора ради
 * тестов). Источник истины — наличие файла audio/{id}.mp3 в OPFS, а НЕ
 * подпись .sig: у импортированных файлов подписи нет, и фильтр «есть .sig →
 * это аудио» отсеял бы их — модалка импорта показала бы «аудио нет», повторный
 * импорт без «Перезаписать» затёр бы файлы, а кнопка озвучки звала бы TTS.
 */
import type { PanelData } from './extractPanels';
import { loadProjectAudio } from '../storage/opfs';
import { estimateDuration } from './buildTimeline';

export interface LoadedPanelAudio {
  blobs: Map<number, Blob>;
  full: Map<number, { blob: Blob; duration: number }>;
  /** Для каждой панели: декодированная, сохранённая или оценочная. */
  durations: Map<number, number>;
}

export async function loadPanelAudios(params: {
  projectId: string;
  panels: readonly PanelData[];
  storedDurations?: Record<number, number>;
  decode: (blob: Blob) => Promise<number>;
  isCancelled?: () => boolean;
}): Promise<LoadedPanelAudio | null> {
  const blobs = new Map<number, Blob>();
  const full = new Map<number, { blob: Blob; duration: number }>();
  const durations = new Map<number, number>();
  const fallback = (panel: PanelData) => params.storedDurations?.[panel.id] || estimateDuration(panel.dialogue);
  for (const panel of params.panels) {
    if (params.isCancelled?.()) return null;
    try {
      const blob = await loadProjectAudio(params.projectId, panel.id);
      if (blob) {
        const duration = await params.decode(blob);
        durations.set(panel.id, duration);
        blobs.set(panel.id, blob);
        full.set(panel.id, { blob, duration });
      } else {
        durations.set(panel.id, fallback(panel));
      }
    } catch {
      durations.set(panel.id, fallback(panel));
    }
  }
  return { blobs, full, durations };
}
