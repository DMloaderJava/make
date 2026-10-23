"use client";

import { useRef, useState } from 'react';
import type { Project } from '@/lib/storage/db';
import type { LastAudioImportSnapshot } from '@/lib/pipeline/audioImport';
import { ProjectClock } from '@/lib/pipeline/projectClock';
import { HistoryManager } from '@/lib/pipeline/historyManager';
import { ObjectUrlRegistry } from '@/lib/pipeline/objectUrlRegistry';
import { UnifiedAudioPlayer } from '@/lib/pipeline/audioPlayer';
import type { BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import { RENDER_DEFAULTS, type RenderSettings } from '@/components/studio/RenderModePanel';
import { DEFAULT_PANEL_GAP } from '@/lib/pipeline/buildTimeline';

/**
 * Всё изменяемое состояние редактора в одном месте (P0-1).
 *
 * Сам контроллер отвечает только за связи между хуками и за то, что попадает
 * в представление, поэтому 40+ `useState`/`useRef` вынесены сюда: их видно
 * списком, а не вперемешку с бизнес-логикой.
 */
export function useEditorState() {
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

  return {
    project, setProject,
    images, setImages,
    currentPanelIdx, setCurrentPanelIdx,
    renderSettings,
    panelGap,
    currentTime, setCurrentTime,
    currentTimeRef,
    audioDurations, setAudioDurations,
    audioBlobs, setAudioBlobs,
    audioFull, setAudioFull,
    introAudio, setIntroAudio,
    outroAudio, setOutroAudio,
    introAudioDuration, setIntroAudioDuration,
    outroAudioDuration, setOutroAudioDuration,
    isGeneratingAudio, setIsGeneratingAudio,
    audioProgress, setAudioProgress,
    audioWarnings, setAudioWarnings,
    notice, setNotice,
    audioError, setAudioError,
    audioDone, setAudioDone,
    audioTotal, setAudioTotal,
    isGeneratingIntro, setIsGeneratingIntro,
    generatingSEO, setGeneratingSEO,
    isExporting, setIsExporting,
    exportProgress, setExportProgress,
    exportStage, setExportStage,
    exportEta, setExportEta,
    exportAbortController, setExportAbortController,
    exportedFile, setExportedFile,
    clearExportedFile,
    isPlaying, setIsPlaying,
    clockInstance,
    clockRef,
    playerRef,
    selectedId, setSelectedId,
    showVoices, setShowVoices,
    showExport, setShowExport,
    showScenario, setShowScenario,
    showIntroOutro, setShowIntroOutro,
    showAudioImport, setShowAudioImport,
    showHealthModal, setShowHealthModal,
    lastImportUndo, setLastImportUndo,
    opfsActive, setOpfsActive,
    historyRef,
    historyAvail,
    syncHistoryAvail,
    urlRegistryRef,
    isUploadingImages, setIsUploadingImages,
    editorImageInputRef,
    voicingIntroOutro, setVoicingIntroOutro,
    backendCaps, setBackendCaps,
    preferredBackend, setPreferredBackend,
    saveStatus, setSaveStatus,
  };
}
