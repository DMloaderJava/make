"use client";

/**
 * Контроллер редактора (P0-1) — только композиция.
 *
 * Здесь нет ни одной бизнес-операции: состояние живёт в `useEditorState`,
 * производные значения — в `useEditorDerived`, остальное — в тематических хуках
 * (`useEditorProjectLoader`, `useEditorPersistence`, `useEditorAudioOps`, ...).
 * Задача файла — связать их в правильном порядке и отдать представлению один
 * объект `EditorController`. Было 2 326 строк в `page.tsx`, стало 339.
 */

import { useEffect, useMemo } from 'react';
import { useEditorDialogue } from '@/components/studio/editor/useEditorDialogue';
import { useEditorScenario } from '@/components/studio/editor/useEditorScenario';
import { useEditorAudioOps } from '@/components/studio/editor/useEditorAudioOps';
import { useEditorAudioImport } from '@/components/studio/editor/useEditorAudioImport';
import { useEditorExport } from '@/components/studio/editor/useEditorExport';
import { useEditorNle } from '@/components/studio/editor/useEditorNle';
import { useEditorPlayback } from '@/components/studio/editor/useEditorPlayback';
import { useEditorSrtOps } from '@/components/studio/editor/useEditorSrtOps';
import { useEditorProjectLoader } from '@/components/studio/editor/useEditorProjectLoader';
import { useEditorPersistence } from '@/components/studio/editor/useEditorPersistence';
import { useEditorImages } from '@/components/studio/editor/useEditorImages';
import { useEditorState } from '@/components/studio/editor/useEditorState';
import { useEditorDerived } from '@/components/studio/editor/useEditorDerived';

export function useEditorController(id: string) {

  const state = useEditorState();
  const {
    audioBlobs,
    audioDurations,
    audioFull,
    clearExportedFile,
    clockRef,
    currentTime,
    currentTimeRef,
    historyRef,
    images,
    introAudio,
    introAudioDuration,
    isGeneratingAudio,
    isPlaying,
    lastImportUndo,
    outroAudio,
    outroAudioDuration,
    panelGap,
    playerRef,
    preferredBackend,
    project,
    renderSettings,
    selectedId,
    setAudioBlobs,
    setAudioDone,
    setAudioDurations,
    setAudioError,
    setAudioFull,
    setAudioProgress,
    setAudioTotal,
    setAudioWarnings,
    setCurrentPanelIdx,
    setCurrentTime,
    setExportAbortController,
    setExportEta,
    setExportProgress,
    setExportStage,
    setExportedFile,
    setGeneratingSEO,
    setImages,
    setIntroAudio,
    setIntroAudioDuration,
    setIsExporting,
    setIsGeneratingAudio,
    setIsGeneratingIntro,
    setIsPlaying,
    setIsUploadingImages,
    setLastImportUndo,
    setNotice,
    setOutroAudio,
    setOutroAudioDuration,
    setProject,
    setSaveStatus,
    setSelectedId,
    setShowExport,
    setShowHealthModal,
    setShowScenario,
    setVoicingIntroOutro,
    syncHistoryAvail,
    urlRegistryRef,
    setOpfsActive,
    setBackendCaps,
  } = state;

  const loader = useEditorProjectLoader({
    id,
    clockRef,
    setProject,
    setImages,
    setCurrentPanelIdx,
    setSelectedId,
    setAudioDurations,
    setAudioBlobs,
    setAudioFull,
    setIntroAudio,
    setOutroAudio,
    setIntroAudioDuration,
    setOutroAudioDuration,
    setNotice,
    setShowScenario,
    setAudioProgress,
    setOpfsActive,
    setBackendCaps,
  });

  const derived = useEditorDerived({ project, images, audioBlobs, audioDurations, panelGap });
  const { tl, duration, voiceButton, healthReport } = derived;

  const playback = useEditorPlayback({
    project,
    tl,
    duration,
    audioBlobs,
    introAudio,
    outroAudio,
    isPlaying,
    currentTime,
    currentTimeRef,
    clockRef,
    playerRef,
    urlRegistryRef,
    setCurrentTime,
    setIsPlaying,
    setAudioError,
    setShowExport,
    setCurrentPanelIdx,
    setSelectedId,
  });
  const { handleSeek, handleSaveRef, handleUndoRef, handleRedoRef, handleSplitRef } = playback;

  const persistence = useEditorPersistence({
    project,
    audioDurations,
    handleSaveRef,
    setProject,
    setSaveStatus,
  });
  const { updateProject } = persistence;

  const imagesHook = useEditorImages({
    project,
    images,
    updateProject,
    setImages,
    setNotice,
    setIsUploadingImages,
  });

  const srtOps = useEditorSrtOps({
    project,
    audioDurations,
    updateProject,
  });
  const { applyIntroOutroChange } = srtOps;

  const dialogue = useEditorDialogue({
    project,
    applyIntroOutroChange,
    setNotice,
    setAudioError,
    setAudioProgress,
    setIsGeneratingIntro,
    setVoicingIntroOutro,
    setIntroAudio,
    setIntroAudioDuration,
    setOutroAudio,
    setOutroAudioDuration,
  });
  const { resolveLLMConfig, targetPreviousTexts } = dialogue;

  const audioOps = useEditorAudioOps({
    project,
    audioBlobs,
    audioFull,
    audioDurations,
    panelGap,
    duration,
    voiceButton,
    isGeneratingAudio,
    setGeneratingSEO,
    updateProject,
    resolveLLMConfig,
    targetPreviousTexts,
    setAudioBlobs,
    setAudioFull,
    setAudioDurations,
    setIntroAudio,
    setIntroAudioDuration,
    setOutroAudio,
    setOutroAudioDuration,
    setIsGeneratingAudio,
    setAudioDone,
    setAudioTotal,
    setAudioProgress,
    setAudioError,
    setSaveStatus,
  });

  const audioImport = useEditorAudioImport({
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
  });

  const scenario = useEditorScenario({
    project,
    images,
    updateProject,
    resolveLLMConfig,
    setNotice,
    setAudioBlobs,
    setAudioFull,
    setAudioDurations,
    setSelectedId,
    setCurrentPanelIdx,
    setShowScenario,
  });


  const exportHook = useEditorExport({
    project,
    audioDurations,
    audioBlobs,
    introAudio,
    outroAudio,
    images,
    panelGap,
    tl,
    duration,
    renderSettings,
    introAudioDuration,
    outroAudioDuration,
    healthReport,
    preferredBackend,
    clearExportedFile,
    urlRegistryRef,
    setProject,
    setImages,
    setNotice,
    setAudioWarnings,
    setIsExporting,
    setExportProgress,
    setExportStage,
    setExportEta,
    setExportAbortController,
    setExportedFile,
    setIntroAudio,
    setOutroAudio,
    setAudioBlobs,
    setAudioDurations,
    setShowHealthModal,
  });

  const nle = useEditorNle({
    project,
    tl,
    panelGap,
    audioDurations,
    selectedId,
    clockRef,
    updateProject,
    handleSeek,
    historyRef,
    syncHistoryAvail,
    setSelectedId,
    setCurrentPanelIdx,
    setAudioDurations,
    setShowHealthModal,
    setNotice,
  });
  const { handleUndo, handleRedo, handleSplitActiveClip } = nle;

  useEffect(() => {
    handleUndoRef.current = handleUndo;
    handleRedoRef.current = handleRedo;
    handleSplitRef.current = handleSplitActiveClip;
  });
  const selectedPanel = project && selectedId !== null && typeof selectedId === 'number'
    ? project.panels.find(p => p.id === selectedId) ?? null
    : null;
  const selectedIndex = project && selectedPanel
    ? project.panels.findIndex(p => p.id === selectedPanel.id)
    : -1;

  // Keep this hook unconditional: the page renders once before the async project load completes.
  const contextValue = useMemo(() => {
    if (!project) return null;
    return selectedId === 'intro' ? { type: 'intro' as const, text: project.intro, duration: project.introDuration }
      : selectedId === 'outro' ? { type: 'outro' as const, text: project.outro, duration: project.outroDuration }
      : selectedPanel ? { type: 'panel' as const, data: selectedPanel, index: selectedIndex }
      : null;
  }, [project, selectedId, selectedPanel, selectedIndex]);
  return {
    // состояние, производные значения и результат каждого хука — без ручного
    // перечисления 120 полей: добавил значение в хук, оно само попало в контроллер.
    ...state,
    ...derived,
    ...loader,
    ...playback,
    ...persistence,
    ...imagesHook,
    ...srtOps,
    ...dialogue,
    ...audioOps,
    ...audioImport,
    ...scenario,
    ...exportHook,
    ...nle,
    // то, что считается прямо в контроллере
    contextValue,
    selectedPanel,
    selectedIndex,
  };
}
