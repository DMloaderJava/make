"use client";

import { useMemo } from 'react';
import type { Project } from '@/lib/storage/db';
import { DEFAULT_PANEL_GAP, rebuildSrt } from '@/lib/pipeline/buildTimeline';
import { serializeScenario } from '@/lib/pipeline/scenario';

/**
 * Пересборка таймлайна и SRT (P0-1).
 *
 * Единственное место, где пауза, интро/аутро и сценарий превращаются в
 * `timeline` + `srt`; раньше это жило вперемешку с обработчиками page.tsx.
 */
export function useEditorSrtOps({
  project,
  audioDurations,
  updateProject,
}: {
  project: Project | null;
  audioDurations: Map<number, number>;
  updateProject: (updates: Partial<Project>) => void;
}) {
  const currentScenarioText = useMemo(() => {
    if (!project || project.panels.length === 0) return '';
    const genders: Record<string, 'female' | 'male'> = {};
    for (const c of project.characters) {
      if (c.gender) genders[c.name] = c.gender;
    }
    return serializeScenario(project.panels, genders);
  }, [project?.panels, project?.characters]);

  /**
   * Единая пересборка таймлайна + SRT (rebuildSrt): реальными длительностями
   * там, где озвучка готова, оценкой — нет; интро/аутро с их длительностями.
   * Вызывается из всех мест, где время/тексты меняются (пауза, интро/аутро,
   * сценарий, озвучка) — SRT больше не «застревает» в старом состоянии.
   */
  const rebuildProjectSrt = (
    patch: Partial<Pick<Project, 'intro' | 'outro' | 'introDuration' | 'outroDuration'>> & { panelGap?: number }
  ) => {
    if (!project) return null;
    const merged = { ...project, ...patch };
    const panelGap = patch.panelGap ?? project.settings.panelGap ?? DEFAULT_PANEL_GAP;
    return rebuildSrt({
      panels: merged.panels,
      audioDurations,
      voiceAssignments: merged.voiceAssignments,
      intro: merged.intro,
      outro: merged.outro,
      introDuration: merged.introDuration,
      outroDuration: merged.outroDuration,
      panelGap,
      realDurations: merged.audioDurations,
    });
  };

  /**
   * Смена паузы между репликами (ползунок в таймлайне): пересобираем
   * сохранённый таймлайн сразу, чтобы превью и длительность отреагировали
   * до переозвучки.
   */
  const handleGapChange = (gap: number) => {
    if (!project) return;
    const rebuilt = rebuildProjectSrt({ panelGap: gap });
    if (!rebuilt) return;
    updateProject({ settings: { ...project.settings, panelGap: gap }, timeline: rebuilt.timeline, srt: rebuilt.srt });
  };

  /** Смена интро/аутро (текст или длительность) → SRT пересобирается сразу. */
  const applyIntroOutroChange = (patch: { intro?: string; outro?: string; introDuration?: number; outroDuration?: number }) => {
    if (!project) return;
    const rebuilt = rebuildProjectSrt(patch);
    if (!rebuilt) return;
    updateProject({ ...patch, timeline: rebuilt.timeline, srt: rebuilt.srt });
  };

  return { currentScenarioText, rebuildProjectSrt, handleGapChange, applyIntroOutroChange };
}
