"use client";

import { useMemo } from 'react';
import type { Project } from '@/lib/storage/db';
import { buildTimeline, calculateTotalDuration } from '@/lib/pipeline/buildTimeline';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { getSettings } from '@/lib/storage/local';
import { estimateTotalCost } from '@/lib/validators';
import { getVoiceButtonState } from '@/lib/pipeline/voiceButtonState';
import { inspectProjectHealth } from '@/lib/pipeline/projectHealth';

/**
 * Производные значения редактора (P0-1): таймлайн, длительность, черновик SRT,
 * стоимость озвучки, состояние кнопки «Озвучить» и отчёт о здоровье проекта.
 *
 * Всё это `useMemo` от состояния — держим отдельно, чтобы контроллер читался
 * как «собери зависимости и отдай представлению», а не как 60 строк формул.
 */
export function useEditorDerived({
  project,
  images,
  audioBlobs,
  audioDurations,
  panelGap,
}: {
  project: Project | null;
  images: string[];
  audioBlobs: Map<number, Blob>;
  audioDurations: Map<number, number>;
  panelGap: number;
}) {
  const tl = useMemo(() => {
    if (!project) return [];
    return project.timeline.length > 0 ? project.timeline : buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, panelGap);
  }, [project, audioDurations, panelGap]);

  const duration = useMemo(() => {
    if (!project) return 0;
    return calculateTotalDuration(tl, project.introDuration, project.outroDuration);
  }, [project, tl]);

  // SRT «черновик»: есть панели, но у хотя бы одной ещё нет реальной озвучки
  // (нет OPFS-блоба) — тайминги собраны из оценки. После «Озвучить всё»
  // флаг сбрасывается, SRT финализируется реальными длительностями.
  const srtDraft = useMemo(() => {
    if (!project || project.panels.length === 0) return false;
    return project.panels.some(p => !audioBlobs.has(p.id));
  }, [project, audioBlobs]);

  // Счётчик символов и стоимость — производные от проекта, а не state: раньше
  // setCostEstimate вызывался только при загрузке и при клике по кнопке, и
  // после создания панелей/правок текста под кнопкой висело «1 симв.».
  const costEstimate = useMemo(() => {
    if (!project) return null;
    const ttsId = resolveTTSProviderId(project.settings.ttsProvider, getSettings().defaultTTSProvider);
    if (!ttsId) return null;
    const cost = estimateTotalCost(project.panels, project.intro, project.outro, ttsId);
    return { characters: cost.characters, cost: cost.estimatedCost };
  }, [project]);

  // Что осталось озвучить: панели без аудио или с изменённым после озвучки
  // текстом. От этого зависят подпись кнопки, её подсветка и подсказка под ней
  // (связка «панели появились / аудио удалено → нажми озвучить»).
  const voiceButton = useMemo(() => getVoiceButtonState({
    panels: project?.panels ?? [],
    voicedPanelIds: audioBlobs.keys(),
    audioTexts: project?.audioTexts,
  }), [project, audioBlobs]);

  // Отчёт о здоровье проекта («Проверка проекта», Этап 9 п. 84–86, 89; Этап 10 п. 91–93)
  const healthReport = useMemo(() => {
    if (!project) return null;
    return inspectProjectHealth({
      panels: project.panels,
      timeline: tl,
      srt: project.srt,
      intro: project.intro,
      outro: project.outro,
      panelGap,
      introDuration: project.introDuration,
      outroDuration: project.outroDuration,
      availableImageIndices: images.length,
      voicedPanelIds: audioBlobs.keys(),
      realDurations: audioDurations,
    });
  }, [project, tl, panelGap, images.length, audioBlobs, audioDurations]);

  return { tl, duration, srtDraft, costEstimate, voiceButton, healthReport };
}
