"use client";

/**
 * Контроллер редактора (P0-1): состояние проекта, воспроизведение, NLE,
 * озвучка и экспорт.
 *
 * Вынесен из page.tsx, чтобы страница осталась тонкой композицией
 * «контроллер → разметка», а логику можно было читать и менять отдельно от JSX.
 */

import { useEffect, useState, useMemo, useRef } from 'react';
import { useEditorDialogue } from '@/components/studio/editor/useEditorDialogue';
import { useEditorScenario } from '@/components/studio/editor/useEditorScenario';
import { useEditorAudioOps } from '@/components/studio/editor/useEditorAudioOps';
import { useEditorExport } from '@/components/studio/editor/useEditorExport';
import { useEditorNle } from '@/components/studio/editor/useEditorNle';
import { useEditorPlayback } from '@/components/studio/editor/useEditorPlayback';
import { useEditorSrtOps } from '@/components/studio/editor/useEditorSrtOps';
import { RENDER_DEFAULTS, type RenderSettings } from '@/components/studio/RenderModePanel';
import { buildTimeline, DEFAULT_PANEL_GAP, calculateTotalDuration } from '@/lib/pipeline/buildTimeline';
import type { Project } from '@/lib/storage/db';
import type { BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import { getSettings } from '@/lib/storage/local';
import { ProjectClock } from '@/lib/pipeline/projectClock';
import type { LastAudioImportSnapshot } from '@/lib/pipeline/audioImport';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { HistoryManager } from '@/lib/pipeline/historyManager';
import { inspectProjectHealth } from '@/lib/pipeline/projectHealth';

import { ObjectUrlRegistry } from '@/lib/pipeline/objectUrlRegistry';
import { UnifiedAudioPlayer } from '@/lib/pipeline/audioPlayer';

import { estimateTotalCost } from '@/lib/validators';
import { getVoiceButtonState } from '@/lib/pipeline/voiceButtonState';

import { useEditorProjectLoader } from '@/components/studio/editor/useEditorProjectLoader';
import { useEditorPersistence } from '@/components/studio/editor/useEditorPersistence';
import { useEditorImages } from '@/components/studio/editor/useEditorImages';

export function useEditorController(id: string) {

  const [project, setProject] = useState<Project | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [currentPanelIdx, setCurrentPanelIdx] = useState(0);
  // Настройки режима рендера хранятся в проекте; значения по умолчанию — панели.
  const renderSettings: RenderSettings = {
    renderMode: project?.settings.renderMode ?? RENDER_DEFAULTS.renderMode,
    stripViewport: project?.settings.stripViewport ?? RENDER_DEFAULTS.stripViewport,
    stripGap: project?.settings.stripGap ?? RENDER_DEFAULTS.stripGap,
  };
  // Пауза между репликами (сек): формат сценария задаёт 0,6 (правило 3),
  // иначе — дефолт 0,3.
  const panelGap = project?.settings.panelGap ?? DEFAULT_PANEL_GAP;

  const [currentTime, setCurrentTime] = useState(0);
  const currentTimeRef = useRef(0);
  const [audioDurations, setAudioDurations] = useState<Map<number, number>>(new Map());
  const [audioBlobs, setAudioBlobs] = useState<Map<number, Blob>>(new Map());
  const [audioFull, setAudioFull] = useState<Map<number, { blob: Blob; duration: number }>>(new Map());
  const [introAudio, setIntroAudio] = useState<Blob | null>(null);
  const [outroAudio, setOutroAudio] = useState<Blob | null>(null);
  const [introAudioDuration, setIntroAudioDuration] = useState<number | null>(null);
  const [outroAudioDuration, setOutroAudioDuration] = useState<number | null>(null);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [audioProgress, setAudioProgress] = useState('');
  // Обрезанные реплики/сдвиги аудио при экспорте — то, что нельзя показывать только в консоли.
  const [audioWarnings, setAudioWarnings] = useState<string[]>([]);
  // Служебное уведомление (сценарий: почему не переведено, куда клампилось изображение).
  const [notice, setNotice] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [audioDone, setAudioDone] = useState(0);
  // Число панелей в текущем прогоне: при точечной переозвучке это НЕ project.panels.length,
  // иначе полоса показывала 2% вместо 20%.
  const [audioTotal, setAudioTotal] = useState(0);
  const [isGeneratingIntro, setIsGeneratingIntro] = useState(false);
  const [generatingSEO, setGeneratingSEO] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStage, setExportStage] = useState<string>('');
  const [exportEta, setExportEta] = useState<number | null>(null);
  const [exportAbortController, setExportAbortController] = useState<AbortController | null>(null);
  const [exportedFile, setExportedFile] = useState<{ blob: Blob; filename: string; url: string } | null>(null);
  const clearExportedFile = () => {
    setExportedFile((prev) => {
      if (prev?.url) {
        try { URL.revokeObjectURL(prev.url); } catch {}
      }
      return null;
    });
  };
  const [isPlaying, setIsPlaying] = useState(false);
  const [clockInstance] = useState<ProjectClock>(() => new ProjectClock());
  const clockRef = useRef<ProjectClock>(clockInstance);
  const playerRef = useRef<UnifiedAudioPlayer | null>(null);
  const [selectedId, setSelectedId] = useState<number | 'intro' | 'outro' | null>(null);
  const [showVoices, setShowVoices] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [showIntroOutro, setShowIntroOutro] = useState(false);
  const [showAudioImport, setShowAudioImport] = useState(false);
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [lastImportUndo, setLastImportUndo] = useState<LastAudioImportSnapshot | null>(null);
  const [opfsActive, setOpfsActive] = useState<boolean>(true);
  const historyRef = useRef<HistoryManager>(new HistoryManager(50));
  const [historyAvail, setHistoryAvail] = useState({ canUndo: false, canRedo: false });
  const syncHistoryAvail = () =>
    setHistoryAvail({ canUndo: historyRef.current.canUndo(), canRedo: historyRef.current.canRedo() });
  const urlRegistryRef = useRef<ObjectUrlRegistry>(new ObjectUrlRegistry());
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const editorImageInputRef = useRef<HTMLInputElement | null>(null);
  const [voicingIntroOutro, setVoicingIntroOutro] = useState(false);
  const [backendCaps, setBackendCaps] = useState<BackendCapabilities | null>(null);
  const [preferredBackend, setPreferredBackend] = useState<'auto' | 'webcodecs' | 'canvas'>('auto');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');

  const { isProjectLoading, projectLoadError, reloadProject } = useEditorProjectLoader({
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


  const {
    handleSeek,
    handleSaveRef,
    handleUndoRef,
    handleRedoRef,
    handleSplitRef,
  } = useEditorPlayback({
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

  const { updateProject } = useEditorPersistence({
    project,
    audioDurations,
    handleSaveRef,
    setProject,
    setSaveStatus,
  });

  const { handleAddImages } = useEditorImages({
    project,
    images,
    updateProject,
    setImages,
    setNotice,
    setIsUploadingImages,
  });

  const { currentScenarioText, handleGapChange, applyIntroOutroChange } = useEditorSrtOps({
    project,
    audioDurations,
    updateProject,
  });

  const {
    resolveLLMConfig,
    targetPreviousTexts,
    handleGenerateIntro,
    handleGenerateOutro,
    handleIntroOutroAI,
    handleVoiceIntroOutro,
    handleClearIntroOutro,
    handleImportIntroAudio,
    handleImportOutroAudio,
    handleClearIntroAudio,
    handleClearOutroAudio,
  } = useEditorDialogue({
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

  const {
    handleGenerateAudio,
    handleGenerateSEO,
    existingAudioIds,
    handleImportAudio,
    handleUndoLastAudioImport,
    handleRegeneratePanel,
  } = useEditorAudioOps({
    project,
    audioBlobs,
    audioFull,
    audioDurations,
    panelGap,
    duration,
    voiceButton,
    tl,
    lastImportUndo,
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
    setNotice,
    setSaveStatus,
    setLastImportUndo,
  });

  const { handleTranslateScenario, handleApplyScenario } = useEditorScenario({
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


  const {
    handleExport,
    handlePreviewAudioMix,
    handleDownloadDiagnosticJson,
    handleExportProjectZip,
    handleImportProjectZip,
  } = useEditorExport({
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

  const {
    buildCurrentHistorySnapshot,
    handleUndo,
    handleRedo,
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
    handleToggleTrackLock,
  } = useEditorNle({
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
  });

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
    applyIntroOutroChange,
    audioBlobs,
    audioDone,
    audioDurations,
    audioError,
    audioProgress,
    audioTotal,
    audioWarnings,
    backendCaps,
    buildCurrentHistorySnapshot,
    clockRef,
    contextValue,
    costEstimate,
    currentPanelIdx,
    currentScenarioText,
    currentTime,
    duration,
    editorImageInputRef,
    existingAudioIds,
    exportAbortController,
    exportEta,
    exportProgress,
    exportStage,
    exportedFile,
    generatingSEO,
    handleAddImages,
    handleApplyScenario,
    handleClearIntroAudio,
    handleClearIntroOutro,
    handleClearOutroAudio,
    handleDeleteActiveClip,
    handleDownloadDiagnosticJson,
    handleDuplicateActiveClip,
    handleExport,
    handleExportProjectZip,
    handleGapChange,
    handleGenerateAudio,
    handleGenerateIntro,
    handleGenerateOutro,
    handleGenerateSEO,
    handleImportAudio,
    handleImportIntroAudio,
    handleImportOutroAudio,
    handleImportProjectZip,
    handleIntroOutroAI,
    handleJumpToHealthIssue,
    handleMoveActiveClip,
    handlePreviewAudioMix,
    handleRedo,
    handleRegeneratePanel,
    handleReorderClip,
    handleSeek,
    handleSetPanelAudioGainAndFades,
    handleSetPanelAudioTrim,
    handleSetPanelDurationOverride,
    handleSplitActiveClip,
    handleTogglePanelMute,
    handleTogglePanelSolo,
    handleTranslateScenario,
    handleUndo,
    handleUndoLastAudioImport,
    handleVoiceIntroOutro,
    healthReport,
    historyAvail,
    historyRef,
    images,
    introAudio,
    introAudioDuration,
    isExporting,
    isGeneratingAudio,
    isGeneratingIntro,
    isPlaying,
    clockInstance,
    renderSettings,
    isUploadingImages,
    lastImportUndo,
    notice,
    opfsActive,
    outroAudio,
    outroAudioDuration,
    panelGap,
    preferredBackend,
    project,
    projectLoadError,
    saveStatus,
    selectedId,
    setAudioError,
    setAudioWarnings,
    setCurrentPanelIdx,
    setExportedFile,
    setNotice,
    setPreferredBackend,
    setSelectedId,
    setShowAudioImport,
    setShowExport,
    setShowHealthModal,
    setShowIntroOutro,
    setShowScenario,
    setShowVoices,
    showAudioImport,
    showExport,
    showHealthModal,
    showIntroOutro,
    showScenario,
    showVoices,
    srtDraft,
    syncHistoryAvail,
    tl,
    updateProject,
    voiceButton,
    voicingIntroOutro,
    isProjectLoading,
    handleToggleTrackLock,
    reloadProject,
  };
}
