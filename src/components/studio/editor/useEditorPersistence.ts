"use client";

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { saveProject, type Project } from '@/lib/storage/db';
import { syncProjectSnapshot } from '@/lib/cloud/projectSync';

/**
 * Сохранение проекта (P0-1): автосейв, `handleSave`, `updateProject`.
 *
 * Отдельный хук, потому что это единственное место, которое пишет проект в
 * IndexedDB (и зеркалит снимок в облако).
 */
export function useEditorPersistence({
  project,
  audioDurations,
  handleSaveRef,
  setProject,
  setSaveStatus,
}: {
  project: Project | null;
  audioDurations: Map<number, number>;
  setProject: Dispatch<SetStateAction<Project | null>>;
  handleSaveRef: { current: () => Promise<void> };
  setSaveStatus: Dispatch<SetStateAction<'saved' | 'saving' | 'unsaved'>>;
}) {
  const handleSave = async () => {
    if (!project) return;
    setSaveStatus('saving');
    const obj: Record<number, number> = {};
    audioDurations.forEach((v, k) => obj[k] = v);
    const snapshot = { ...project, audioDurations: obj, updatedAt: Date.now() };
    const saved = await saveProject(snapshot, { allowStale: true });
    project.revision = saved.revision;
    // Облако временное (TTL 24 ч); ошибка сети не ломает локальный режим.
    void syncProjectSnapshot(saved);
    setSaveStatus('saved');
  };

  // Хоткеи живут в эффекте без deps — держим актуальный handleSave в ref,
  // иначе Ctrl+S сохраняет устаревший снимок проекта.
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  const updateProject = (updates: Partial<Project>) => {
    if (!project) return;
    // Задача 2: любая пересборка timeline монотонно инкрементирует timelineVersion
    const nextTimelineVersion =
      updates.timelineVersion !== undefined
        ? updates.timelineVersion
        : updates.timeline !== undefined
          ? (project.timelineVersion ?? 2) + 1
          : project.timelineVersion;
    setProject({
      ...project,
      ...updates,
      ...(nextTimelineVersion !== undefined ? { timelineVersion: nextTimelineVersion } : {}),
      updatedAt: Date.now(),
    });
  };

  // Автосейв: раньше в deps не было timeline/srt/audioDurations, из-за чего после
  // перезагрузки страницы терялись субтитры и длительности озвучки.
  useEffect(() => {
    if (!project) return;
    setSaveStatus('unsaved');
    const t = setTimeout(() => {
      handleSave();
    }, 2000);
    return () => clearTimeout(t);
  }, [
    project?.panels,
    project?.intro,
    project?.outro,
    project?.voiceAssignments,
    project?.name,
    project?.timeline,
    project?.srt,
    project?.audioDurations,
    project?.seoPackage,
    project?.timelineVersion,
    project?.settings?.visionModel,
    project?.settings?.llmProvider,
    project?.settings?.ttsProvider,
    project?.settings?.ttsModel,
    project?.settings?.ttsLanguage,
    project?.settings?.ttsSpeed,
    project?.settings?.renderMode,
    project?.settings?.stripViewport,
    project?.settings?.stripGap,
    project?.settings?.panelGap,
    project?.settings?.chatModel,
    project?.settings?.backgroundMusic,
    project?.settings?.musicVolume,
  ]);

  return { updateProject };
}
