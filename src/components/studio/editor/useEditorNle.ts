"use client";

import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import type { NleHistorySnapshot, HistoryManager } from '@/lib/pipeline/historyManager';
import {
  reorderPanelClips,
  setPanelAudioGainAndFades,
  setPanelAudioTrim,
  setPanelDurationOverride,
  splitPanelAudioClip,
  togglePanelMute,
  togglePanelSolo,
  deletePanelClipWithRipple,
  duplicatePanelClip,
  type NleMutationResult,
} from '@/lib/pipeline/nleOperations';
import type { ProjectHealthIssue } from '@/lib/pipeline/projectHealth';

/**
 * NLE-операции и стек Undo/Redo (P0-1, Этап 6 п. 51–60).
 *
 * Каждая операция возвращает снимок «панели + длительности + таймлайн + SRT»,
 * поэтому отмена не оставляет редактор в полусобранном состоянии.
 */
export function useEditorNle({
  project,
  tl,
  panelGap,
  audioDurations,
  selectedId,
  currentTime,
  updateProject,
  handleSeek,
  historyRef,
  syncHistoryAvail,
  setSelectedId,
  setCurrentPanelIdx,
  setAudioDurations,
  setShowHealthModal,
  setNotice,
}: {
  project: Project | null;
  tl: Project['timeline'];
  panelGap: number;
  audioDurations: Map<number, number>;
  selectedId: number | 'intro' | 'outro' | null;
  updateProject: (updates: Partial<Project>) => void;
  handleSeek: (t: number) => void;
  historyRef: { current: HistoryManager };
  syncHistoryAvail: () => void;
  setSelectedId: Dispatch<SetStateAction<number | 'intro' | 'outro' | null>>;
  setCurrentPanelIdx: Dispatch<SetStateAction<number>>;
  setAudioDurations: Dispatch<SetStateAction<Map<number, number>>>;
  setShowHealthModal: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  currentTime: number;
}) {
  // --- NLE операции и стек истории Undo/Redo (Этап 6 п. 51–60) ---
  const buildCurrentHistorySnapshot = (label: string): NleHistorySnapshot | null => {
    if (!project) return null;
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    return {
      label,
      timestamp: Date.now(),
      panels: project.panels.map(p => ({ ...p, bbox: { ...p.bbox } })),
      audioDurations: durObj,
      timeline: tl.map(s => ({ ...s })),
      srt: project.srt,
      panelGap,
    };
  };

  const applyHistorySnapshot = (snap: NleHistorySnapshot) => {
    if (!project) return;
    const nextDurs = new Map<number, number>();
    for (const [k, v] of Object.entries(snap.audioDurations)) {
      nextDurs.set(Number(k), v);
    }
    setAudioDurations(nextDurs);
    updateProject({
      panels: snap.panels,
      audioDurations: snap.audioDurations,
      timeline: snap.timeline,
      srt: snap.srt,
      ...(snap.panelGap !== undefined ? { settings: { ...project.settings, panelGap: snap.panelGap } } : {}),
    });
    syncHistoryAvail();
  };

  const handleUndo = () => {
    const cur = buildCurrentHistorySnapshot('current');
    if (!cur) return;
    const prev = historyRef.current.undo(cur);
    if (prev) applyHistorySnapshot(prev);
  };

  const handleRedo = () => {
    const cur = buildCurrentHistorySnapshot('current');
    if (!cur) return;
    const next = historyRef.current.redo(cur);
    if (next) applyHistorySnapshot(next);
  };

  const getNleOptions = () => ({
    voiceAssignments: project?.voiceAssignments ?? {},
    intro: project?.intro ?? '',
    outro: project?.outro ?? '',
    introDuration: project?.introDuration ?? 0,
    outroDuration: project?.outroDuration ?? 0,
    panelGap,
    currentTimelineVersion: project?.timelineVersion,
  });

  // Единый обработчик применения результата NLE-операций (Задача 6):
  // все 7 NLE-операций обновляют setAudioDurations и передают одинаковый набор полей в updateProject.
  const applyNleResult = (res: NleMutationResult) => {
    const nextDurs = new Map<number, number>();
    for (const [k, v] of Object.entries(res.audioDurations)) {
      nextDurs.set(Number(k), v);
    }
    setAudioDurations(nextDurs);
    updateProject({
      panels: res.panels,
      audioDurations: res.audioDurations,
      timeline: res.timeline,
      srt: res.srt,
      timelineVersion: res.timelineVersion,
    });
    syncHistoryAvail();
  };

  const handleSplitActiveClip = () => {
    if (!project) return;
    const targetPanelId = typeof selectedId === 'number'
      ? selectedId
      : tl.find(s => currentTime >= s.audioStart && currentTime < s.audioEnd)?.panelId ?? null;
    if (targetPanelId === null) return;
    const seg = tl.find(s => s.panelId === targetPanelId);
    if (!seg) return;
    const segDur = Math.max(0.2, seg.audioEnd - seg.audioStart);
    const offset = currentTime > seg.audioStart + 0.05 && currentTime < seg.audioEnd - 0.05
      ? currentTime - seg.audioStart
      : segDur / 2;

    try {
      const snap = buildCurrentHistorySnapshot(`Разрезание панели #${targetPanelId}`);
      if (snap) historyRef.current.record(snap);
      const durObj: Record<number, number> = {};
      audioDurations.forEach((v, k) => { durObj[k] = v; });
      const res = splitPanelAudioClip(project.panels, durObj, targetPanelId, offset, getNleOptions());
      applyNleResult(res);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteActiveClip = () => {
    if (!project || typeof selectedId !== 'number') return;
    const snap = buildCurrentHistorySnapshot(`Удаление панели #${selectedId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = deletePanelClipWithRipple(project.panels, durObj, selectedId, getNleOptions());
    applyNleResult(res);
    setSelectedId(null);
  };

  const handleDuplicateActiveClip = () => {
    if (!project || typeof selectedId !== 'number') return;
    const snap = buildCurrentHistorySnapshot(`Дублирование панели #${selectedId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = duplicatePanelClip(project.panels, durObj, selectedId, getNleOptions());
    applyNleResult(res);
  };

  const handleReorderClip = (panelId: number, targetIdx: number) => {
    if (!project) return;
    const sorted = [...project.panels].sort((a, b) => a.order - b.order || a.id - b.id);
    if (targetIdx < 0 || targetIdx >= sorted.length) return;
    const snap = buildCurrentHistorySnapshot(`Перемещение панели #${panelId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = reorderPanelClips(project.panels, durObj, panelId, targetIdx, getNleOptions());
    applyNleResult(res);
  };

  const handleMoveActiveClip = (delta: -1 | 1) => {
    if (!project || typeof selectedId !== 'number') return;
    const sorted = [...project.panels].sort((a, b) => a.order - b.order || a.id - b.id);
    const fromIdx = sorted.findIndex(p => p.id === selectedId);
    if (fromIdx < 0) return;
    handleReorderClip(selectedId, fromIdx + delta);
  };

  const handleTogglePanelMute = (panelId: number) => {
    if (!project) return;
    const snap = buildCurrentHistorySnapshot(`Mute панели #${panelId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = togglePanelMute(project.panels, durObj, panelId, undefined, getNleOptions());
    applyNleResult(res);
  };

  const handleTogglePanelSolo = (panelId: number) => {
    if (!project) return;
    const snap = buildCurrentHistorySnapshot(`Solo панели #${panelId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = togglePanelSolo(project.panels, durObj, panelId, undefined, getNleOptions());
    applyNleResult(res);
  };

  const handleSetPanelAudioTrim = (panelId: number, trimIn: number, trimOut: number) => {
    if (!project) return;
    const snap = buildCurrentHistorySnapshot(`Trim панели #${panelId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = setPanelAudioTrim(project.panels, durObj, panelId, trimIn, trimOut, getNleOptions());
    applyNleResult(res);
  };

  const handleSetPanelDurationOverride = (panelId: number, durationOverride: number | null | undefined) => {
    if (!project) return;
    const snap = buildCurrentHistorySnapshot(`Длительность панели #${panelId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = setPanelDurationOverride(project.panels, durObj, panelId, durationOverride, getNleOptions());
    applyNleResult(res);
  };

  const handleSetPanelAudioGainAndFades = (
    panelId: number,
    params: { gain?: number; fadeIn?: number; fadeOut?: number }
  ) => {
    if (!project) return;
    const snap = buildCurrentHistorySnapshot(`Громкость/Fade панели #${panelId}`);
    if (snap) historyRef.current.record(snap);
    const durObj: Record<number, number> = {};
    audioDurations.forEach((v, k) => { durObj[k] = v; });
    const res = setPanelAudioGainAndFades(project.panels, durObj, panelId, params, getNleOptions());
    applyNleResult(res);
  };

  const handleJumpToHealthIssue = (issue: ProjectHealthIssue) => {
    if (issue.panelId !== undefined && project) {
      setSelectedId(issue.panelId);
      const idx = project.panels.findIndex(p => p.id === issue.panelId);
      if (idx !== -1) setCurrentPanelIdx(idx);
    }
    if (issue.seekTime !== undefined) {
      handleSeek(issue.seekTime);
    }
    setShowHealthModal(false);
  };
  return {
    buildCurrentHistorySnapshot,
    applyHistorySnapshot,
    handleUndo,
    handleRedo,
    getNleOptions,
    applyNleResult,
    handleSplitActiveClip,
    handleDeleteActiveClip,
    handleDuplicateActiveClip,
    handleReorderClip,
    handleMoveActiveClip,
    handleTogglePanelMute,
    handleTogglePanelSolo,
    handleSetPanelAudioTrim,
    handleSetPanelDurationOverride,
    handleSetPanelAudioGainAndFades,
    handleJumpToHealthIssue,
  };
}
