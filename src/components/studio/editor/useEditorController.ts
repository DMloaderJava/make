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
import { getProjectWithImages, saveProject, Project } from '@/lib/storage/db';
import { RENDER_DEFAULTS, type RenderSettings } from '@/components/studio/RenderModePanel';
import { type AudioImportApplyControls } from '@/components/studio/modals/AudioImportModal';
import { migrateProjectSchema } from '@/lib/storage/schemaMigration';
import { recoverInterruptedImport } from '@/lib/storage/resourceIntegrity';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { buildTimeline, DEFAULT_PANEL_GAP, calculateTotalDuration, roundMediaDuration } from '@/lib/pipeline/buildTimeline';
import { ProjectClock } from '@/lib/pipeline/projectClock';
import { type ScenarioLine } from '@/lib/pipeline/scenario';
import type { LastAudioImportSnapshot } from '@/lib/pipeline/audioImport';
import { loadPanelAudios } from '@/lib/pipeline/loadPanelAudio';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { checkCapabilities, BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import { HistoryManager, type NleHistorySnapshot } from '@/lib/pipeline/historyManager';

import { ObjectUrlRegistry } from '@/lib/pipeline/objectUrlRegistry';
import { UnifiedAudioPlayer } from '@/lib/pipeline/audioPlayer';
import {
  inspectProjectHealth,
  type ProjectHealthIssue,
} from '@/lib/pipeline/projectHealth';
import { loadProjectIntroAudio, loadProjectOutroAudio, isOPFSSupported, saveProjectImage } from '@/lib/storage/opfs';
import { estimateTotalCost } from '@/lib/validators';
import { getVoiceButtonState } from '@/lib/pipeline/voiceButtonState';
import { syncProjectSnapshot } from '@/lib/cloud/projectSync';

import { getAudioDuration } from '@/lib/editor/audioUtils';

export function useEditorController(id: string) {

  const [project, setProject] = useState<Project | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadResult, setLoadResult] = useState<{ id: string; attempt: number; error?: string } | null>(null);
  const isProjectLoading = !loadResult || loadResult.id !== id || loadResult.attempt !== loadAttempt;
  const projectLoadError = isProjectLoading ? null : loadResult.error ?? null;
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

  useEffect(() => {
    let cancelled = false;
    const attempt = loadAttempt;

    const loadProject = async () => {
      try {
        if (!id) {
          await Promise.resolve();
          if (!cancelled) setLoadResult({ id, attempt, error: 'Не удалось определить ID проекта.' });
          return;
        }

        const result = await getProjectWithImages(id);
        if (cancelled) return;
        if (!result) {
          setLoadResult({
            id,
            attempt,
            error: `Проект «${id}» не найден в локальном хранилище. Возможно, он был удалён или открыт в другом браузере/профиле.`,
          });
          return;
        }

        const { project: storedProject, imageDataUrls: urls } = result;
        // Явная идемпотентная миграция схемы проекта и таймлайна (Этап 1 п. 5, Этап 8 п. 74)
        const migration = migrateProjectSchema(storedProject);
        const migratedProject = migration.project;

        // Восстановление после незавершённого импорта (ImportJournal, Этап 8 п. 79)
        const journalRecovery = recoverInterruptedImport(migratedProject.id);
        if (journalRecovery.recovered && journalRecovery.message) {
          setNotice(journalRecovery.message);
        }

        const settings = getSettings();
        const storedLLMProvider = getLLMProvider(migratedProject.settings.llmProvider || settings.defaultLLMProvider)
          || getLLMProvider('openrouter')!;
        const safeVisionModel = resolveLLMVisionModel(
          storedLLMProvider,
          migratedProject.settings.visionModel || settings.defaultVisionModel,
        ) || '';
        const loadedProject = safeVisionModel === migratedProject.settings.visionModel
          ? migratedProject
          : { ...migratedProject, settings: { ...migratedProject.settings, visionModel: safeVisionModel } };
        // Аудио панелей — по наличию файла, без фильтра по .sig (импорт без подписи).
        const loadedAudio = await loadPanelAudios({
          projectId: loadedProject.id,
          panels: loadedProject.panels,
          storedDurations: loadedProject.audioDurations,
          decode: getAudioDuration,
          isCancelled: () => cancelled,
        });
        if (!loadedAudio) return;
        const { durations, blobs, full } = loadedAudio;

        let loadedIntroAudio: Blob | null = null;
        let loadedOutroAudio: Blob | null = null;
        let loadedIntroAudioDur: number | null = null;
        let loadedOutroAudioDur: number | null = null;
        try {
          loadedIntroAudio = await loadProjectIntroAudio(loadedProject.id);
          loadedOutroAudio = await loadProjectOutroAudio(loadedProject.id);
          if (loadedIntroAudio) {
            loadedIntroAudioDur = roundMediaDuration(await getAudioDuration(loadedIntroAudio));
          }
          if (loadedOutroAudio) {
            loadedOutroAudioDur = roundMediaDuration(await getAudioDuration(loadedOutroAudio));
          }
        } catch {}

        if (cancelled) return;
        setProject(loadedProject);
        setImages(urls);
        setAudioDurations(durations);
        setAudioBlobs(blobs);
        setAudioFull(full);
        setIntroAudio(loadedIntroAudio);
        setOutroAudio(loadedOutroAudio);
        setIntroAudioDuration(loadedIntroAudioDur);
        setOutroAudioDuration(loadedOutroAudioDur);
        setCurrentPanelIdx(0);
        clockRef.current.reset(0);
        setAudioProgress('');

        if (loadedProject.panels.length > 0) {
          setSelectedId(loadedProject.panels[0].id);
        } else {
          setSelectedId('intro');
        }
        setLoadResult({ id, attempt });
        // Без ключа провайдера vision-анализ не запустится — показываем это
        // баннером (alert/confirm во встроенном превью блокируются). Для
        // явного «Тест сценария» (?scenario=1) баннер не нужен: пользователь
        // уже выбрал сценарный путь, и модалка откроется сама.
        const isScenarioEntry = new URLSearchParams(window.location.search).get('scenario') === '1';
        if (!isScenarioEntry) {
          const keys = getAllKeys();
          const hasLLMKey = !!keys[storedLLMProvider.id] || (storedLLMProvider.id === 'gemini' && !!keys['google-ai']);
          // Только для «голого» проекта: если панели уже есть (ключ удалили
          // после разбора), баннером не спамим.
          if (!hasLLMKey && loadedProject.panels.length === 0) {
            setNotice(`Ключ AI не добавлен — анализ изображений не запустится. Добавьте ключ в «Настройках» или используйте кнопку «Сценарий» — она работает без ключа.`);
          }
        }
        // «Тест сценария» приходит с ?scenario=1 — сразу открываем модалку.
        if (isScenarioEntry) {
          setShowScenario(true);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setLoadResult({ id, attempt, error: `Не удалось загрузить проект: ${message || 'неизвестная ошибка'}` });
        }
      }
    };

    void loadProject();
    void isOPFSSupported()
      .then(supported => { if (!cancelled) setOpfsActive(Boolean(supported)); })
      .catch(() => { if (!cancelled) setOpfsActive(false); });
    void checkCapabilities()
      .then((capabilities) => {
        if (!cancelled) setBackendCaps(capabilities);
      })
      .catch((error) => console.warn('Не удалось проверить возможности экспорта', error));

    return () => {
      cancelled = true;
    };
  }, [id, loadAttempt]);

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

  // Синхронизируем длительность с ProjectClock и ведём воспроизведение через UnifiedAudioPlayer (Задачи 1, 9)
  // в рендере-тайме (и в TDZ) больше не приходится.
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

  const handleAddImages = async (fileList: FileList | File[]) => {
    if (!project) return;
    const files = Array.from(fileList).filter(file => file.type.startsWith('image/'));
    if (files.length === 0) {
      setNotice('Выберите файлы изображений.');
      return;
    }
    setIsUploadingImages(true);
    try {
      const nextImages: string[] = [];
      const nextFiles = [...(project.imageFiles || [])];
      const useOPFS = project.useOPFS && await isOPFSSupported();
      for (const [offset, file] of files.entries()) {
        const index = images.length + offset;
        if (useOPFS) {
          nextFiles.push(await saveProjectImage(project.id, index, file));
        } else {
          nextImages.push(await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error(`Не удалось прочитать ${file.name}`));
            reader.readAsDataURL(file);
          }));
        }
      }
      const combinedImages = useOPFS ? images : [...images, ...nextImages];
      setImages(combinedImages);
      updateProject({
        images: useOPFS ? project.images : [...project.images, ...nextImages],
        imageFiles: useOPFS ? nextFiles : project.imageFiles,
        useOPFS,
      });
      setNotice(`Добавлено изображений: ${files.length}. Всего в проекте: ${combinedImages.length}.`);
    } catch (error) {
      setNotice(`Не удалось добавить изображения: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsUploadingImages(false);
    }
  };

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
  const reloadProject = () => setLoadAttempt((a) => a + 1);

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
    reloadProject,
  };
}
