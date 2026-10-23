"use client";

import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { appendProjectEvent, saveProject, type Project } from '@/lib/storage/db';
import { rebuildSrt } from '@/lib/pipeline/buildTimeline';
import {
  applyAudioImport,
  createAudioImportUndoSnapshot,
  createImportPersister,
  mergeAppliedAudio,
  undoLastAudioImport,
  type AudioImportPlan,
  type LastAudioImportSnapshot,
} from '@/lib/pipeline/audioImport';
import type { AudioImportApplyControls } from '@/components/studio/modals/AudioImportModal';

/**
 * Импорт собственных аудиофайлов (P0-1) — отдельно от TTS-генерации.
 *
 * Сюда входит план импорта, запись файлов в OPFS с журналом, слияние с
 * таймлайном/SRT и откат последнего импорта. Генерация озвучки живёт в
 * `useEditorAudioOps`.
 */
export function useEditorAudioImport({
  project,
  tl,
  audioBlobs,
  audioFull,
  audioDurations,
  panelGap,
  lastImportUndo,
  updateProject,
  setAudioBlobs,
  setAudioFull,
  setAudioDurations,
  setLastImportUndo,
  setNotice,
}: {
  project: Project | null;
  tl: Project['timeline'];
  audioBlobs: Map<number, Blob>;
  audioFull: Map<number, { blob: Blob; duration: number }>;
  audioDurations: Map<number, number>;
  panelGap: number;
  lastImportUndo: LastAudioImportSnapshot | null;
  updateProject: (updates: Partial<Project>) => void;
  setAudioBlobs: Dispatch<SetStateAction<Map<number, Blob>>>;
  setAudioFull: Dispatch<SetStateAction<Map<number, { blob: Blob; duration: number }>>>;
  setAudioDurations: Dispatch<SetStateAction<Map<number, number>>>;
  setLastImportUndo: Dispatch<SetStateAction<LastAudioImportSnapshot | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
}) {
  /** id панелей, у которых сейчас есть аудио — «уже есть» для плана импорта. */
  const existingAudioIds = useMemo(() => [...audioBlobs.keys()], [audioBlobs]);

  /**
   * Импорт аудио: applyAudioImport пишет файлы в OPFS по ключам
   * панелей; после КАЖДОГО записанного файла отметка «импорт» сразу уходит в
   * IDB (падение вкладки на 4-м файле оставит 3 видимых импорта, а не файлы без
   * отметки, которые «Озвучить всё» приняло бы за устаревший TTS). Состояние
   * редактора, таймлайн и SRT — один раз в конце.
   */
  const handleImportAudio = async (
    plan: AudioImportPlan,
    files: Map<string, File>,
    controls: AudioImportApplyControls
  ) => {
    if (!project) throw new Error('Проект не загружен');
    const snapshot = project;
    const prevDurationsObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { prevDurationsObj[k] = v; });
    const undoSnap = await createAudioImportUndoSnapshot({
      projectId: snapshot.id,
      panels: snapshot.panels,
      audioDurations: prevDurationsObj,
      timeline: tl,
      srt: snapshot.srt,
      existingBlobs: audioBlobs,
      targetPanelIds: plan.matches.map(m => m.target.id),
    });

    const persister = createImportPersister({
      snapshot,
      save: async (proj) => {
        const saved = await saveProject(proj, { allowStale: true });
        project.revision = saved.revision;
      },
      onSaveError: (e) => console.warn('Не удалось сохранить отметку импорта', e),
    });

    const report = await applyAudioImport(plan, files, {
      projectId: snapshot.id,
      currentPanelIds: snapshot.panels.map(p => p.id),
      signal: controls.signal,
      onProgress: controls.onProgress,
      onApplied: persister.onApplied,
    });
    await persister.flush();
    if (report.applied.length === 0) return report;

    undoSnap.importedPanelIds = report.applied.map(a => a.panelId);
    setLastImportUndo(undoSnap);

    const merged = mergeAppliedAudio({
      panels: snapshot.panels,
      applied: report.applied,
      files,
      blobs: audioBlobs,
      full: audioFull,
      durations: audioDurations,
    });
    setAudioBlobs(merged.blobs);
    setAudioFull(merged.full);
    setAudioDurations(merged.durations);

    const rebuilt = rebuildSrt({
      panels: merged.panels,
      audioDurations: merged.durations,
      voiceAssignments: snapshot.voiceAssignments,
      intro: snapshot.intro,
      outro: snapshot.outro,
      introDuration: snapshot.introDuration,
      outroDuration: snapshot.outroDuration,
      panelGap,
      realDurations: merged.realDurations,
    });
    const eventLog = appendProjectEvent(snapshot.eventLog, {
      type: 'import-audio',
      summary: `Импортировано аудиофайлов: ${report.applied.length}`,
    });
    updateProject({
      panels: merged.panels,
      timeline: rebuilt.timeline,
      srt: rebuilt.srt,
      audioDurations: merged.durationsObj,
      eventLog,
    });
    return report;
  };

  /** Отмена последнего импорта аудио (Этап 2 п. 20). */
  const handleUndoLastAudioImport = async () => {
    if (!project || !lastImportUndo) return;
    const restored = await undoLastAudioImport(lastImportUndo);
    const nextDurations = new Map<number, number>();
    for (const [k, v] of Object.entries(restored.audioDurations)) {
      nextDurations.set(Number(k), v);
    }
    const nextFull = new Map<number, { blob: Blob; duration: number }>();
    for (const [id, blob] of restored.restoredBlobs.entries()) {
      nextFull.set(id, { blob, duration: nextDurations.get(id) ?? 2 });
    }
    setAudioBlobs(restored.restoredBlobs);
    setAudioDurations(nextDurations);
    setAudioFull(nextFull);
    setLastImportUndo(null);
    const eventLog = appendProjectEvent(project.eventLog, {
      type: 'undo-import-audio',
      summary: 'Отменён последний импорт аудио',
    });
    updateProject({
      panels: restored.panels,
      audioDurations: restored.audioDurations,
      timeline: restored.timeline,
      srt: restored.srt,
      eventLog,
    });
    setNotice('Последний импорт аудио отменён, прежние файлы и таймлайн восстановлены.');
  };


  return { existingAudioIds, handleImportAudio, handleUndoLastAudioImport };
}
