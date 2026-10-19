"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { getProjectWithImages, saveProject, Project, appendProjectEvent } from '@/lib/storage/db';
import { migrateProjectSchema } from '@/lib/storage/schemaMigration';
import { recoverInterruptedImport } from '@/lib/storage/resourceIntegrity';
import { exportProjectToZip, importProjectFromZip } from '@/lib/storage/projectArchive';
import { Preview } from '@/components/studio/Preview';
import { Timeline } from '@/components/studio/Timeline';
import { ContextPanel } from '@/components/studio/ContextPanel';
import { RenderModePanel, RENDER_DEFAULTS, type RenderSettings } from '@/components/studio/RenderModePanel';
import { VoicesModal } from '@/components/studio/modals/VoicesModal';
import { ExportModal } from '@/components/studio/modals/ExportModal';
import { ScenarioModal } from '@/components/studio/modals/ScenarioModal';
import { IntroOutroModal } from '@/components/studio/modals/IntroOutroModal';
import { AudioImportModal, type AudioImportApplyControls } from '@/components/studio/modals/AudioImportModal';
import { ProjectHealthModal } from '@/components/studio/modals/ProjectHealthModal';
import { Input } from '@/components/ui/input';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { buildTimeline, DEFAULT_PANEL_GAP, calculateTotalDuration, rebuildSrt, roundMediaDuration } from '@/lib/pipeline/buildTimeline';
import { ProjectClock } from '@/lib/pipeline/projectClock';
import { applyScenarioToProject, serializeScenario, SCENARIO_GAP_SECONDS, type ScenarioLine } from '@/lib/pipeline/scenario';
import { translateScenarioLines, isTranslatableLanguage } from '@/lib/pipeline/translateScenario';
import { generateIntro, generateOutro, generateFallbackIntro, generateFallbackOutro, resolveChannelName } from '@/lib/pipeline/generateIntro';
import { formatSEOPackage, generateSEO, generateFallbackSEO } from '@/lib/pipeline/generateSEO';
import { generateAllAudio } from '@/lib/pipeline/generateAudio';
import {
  applyAudioImport,
  createAudioImportUndoSnapshot,
  createImportPersister,
  mergeAppliedAudio,
  settleImportRegeneration,
  undoLastAudioImport,
  type AudioImportPlan,
  type LastAudioImportSnapshot,
} from '@/lib/pipeline/audioImport';
import { loadPanelAudios } from '@/lib/pipeline/loadPanelAudio';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { getTTSProvider } from '@/lib/providers/tts/catalog';
import { concatenateAudioBlobs } from '@/lib/pipeline/assembleVideo';
import { renderVideo, checkCapabilities, BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import { buildTimelineAudioPlacements, type AudioPlacement } from '@/lib/pipeline/audioMix';
import { HistoryManager, type NleHistorySnapshot } from '@/lib/pipeline/historyManager';
import {
  reorderPanelClips,
  setPanelAudioGainAndFades,
  setPanelAudioTrim,
  setPanelDurationOverride,
  splitPanelAudioClip,
  togglePanelMute,
  togglePanelSolo,
  type NleMutationResult,
} from '@/lib/pipeline/nleOperations';
import { ObjectUrlRegistry } from '@/lib/pipeline/objectUrlRegistry';
import { UnifiedAudioPlayer } from '@/lib/pipeline/audioPlayer';
import {
  buildDiagnosticReportJson,
  inspectProjectHealth,
  renderExportAudioMixPreviewWav,
  type ProjectHealthIssue,
} from '@/lib/pipeline/projectHealth';
import { loadProjectAudio, loadProjectIntroAudio, loadProjectOutroAudio, deleteProjectAudio, isOPFSSupported, saveProjectAudio, saveProjectImage, saveProjectIntroAudio, saveProjectOutroAudio } from '@/lib/storage/opfs';
import { estimateTotalCost } from '@/lib/validators';
import { getVoiceButtonState } from '@/lib/pipeline/voiceButtonState';
import { downloadBlob, formatTime } from '@/lib/utils';
import { syncProjectSnapshot } from '@/lib/cloud/projectSync';
import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';

let editorAudioContext: AudioContext | null = null;
function getEditorAudioContext(): AudioContext {
  if (!editorAudioContext || editorAudioContext.state === 'closed') {
    editorAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return editorAudioContext;
}

async function getAudioDuration(blob: Blob): Promise<number> {
  try {
    const ctx = getEditorAudioContext();
    const ab = await blob.arrayBuffer();
    const dec = await ctx.decodeAudioData(ab.slice(0));
    if (isFinite(dec.duration) && dec.duration > 0) return dec.duration;
    return 2;
  } catch {
    return 2;
  }
}

async function getImportedAudioDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const duration = await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(audio.duration);
      audio.onerror = () => reject(new Error('Формат аудио не поддержан браузером или файл повреждён'));
      audio.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность аудио');
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function EditorPage() {
  const params = useParams();
  const id = params.id as string;

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
  // синхронизируем ref в эффекте (объявлен выше playback-эффекта, поэтому
  // к моменту старта воспроизведения значение уже актуально)
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);
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

  // Единая подписка на ProjectClock (Задача 1: единственный вызов setCurrentTime в EditorPage;
  // P1 п. 14: rAF-тики троттлятся для React-дерева EditorPage до ~20 Гц, в то время как Preview
  // читает clock.getTime() напрямую в своём Canvas rAF на полных 60 fps)
  useEffect(() => {
    const clock = clockRef.current;
    const player = new UnifiedAudioPlayer({
      clock,
      registry: urlRegistryRef.current,
      onError: (formatted) => {
        setAudioError(formatted.message);
      },
    });
    playerRef.current = player;

    let lastReactSyncWallMs = 0;
    let lastPlayingState = clock.getIsPlaying();

    const unsubscribe = clock.subscribe((snap) => {
      if (snap.isPlaying !== lastPlayingState) {
        lastPlayingState = snap.isPlaying;
        setIsPlaying(snap.isPlaying);
      }
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (snap.reason === 'raf' && nowMs - lastReactSyncWallMs < 45) {
        return;
      }
      lastReactSyncWallMs = nowMs;
      setCurrentTime(snap.currentTime);
    });

    return () => {
      unsubscribe();
      player.dispose();
      playerRef.current = null;
      urlRegistryRef.current.revokeAll();
    };
  }, []);

  // ЕДИНЫЙ источник времени превью: таймлайн, по которому считаются и
  // длительность (clock), и сегменты Timeline, и траектория скролла ленты.
  // Раньше duration строился ОТДЕЛЬНО (fresh buildTimeline), а tl брал
  // сохранённый project.timeline — при рассинхроне часы и лента разъезжались.
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
  useEffect(() => {
    clockRef.current.setDuration(duration);
  }, [duration]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !project) return;
    if (!isPlaying) {
      player.pause();
      return;
    }
    if (!duration || duration <= 0 || !isFinite(duration)) {
      clockRef.current.pause('pause');
      return;
    }

    const effectiveBlobs = new Map<number, Blob>(audioBlobs);
    for (const p of project.panels) {
      if (!effectiveBlobs.has(p.id) && p.sourceAudioPanelId !== undefined) {
        const parentBlob = audioBlobs.get(p.sourceAudioPanelId);
        if (parentBlob) effectiveBlobs.set(p.id, parentBlob);
      }
    }

    void player.syncPlayback({
      timeline: tl,
      introDuration: project.introDuration,
      outroDuration: project.outroDuration,
      introAudio,
      outroAudio,
      panelBlobs: effectiveBlobs,
    });
  }, [isPlaying, duration, tl, introAudio, outroAudio, audioBlobs, project]);

  // Актуальный handleSave для хоткеев: эффект ниже намеренно без deps,
  // поэтому состояние берём из ref. Ref объявлен до эффекта — читать его
  // в рендере-тайме (и в TDZ) больше не приходится.
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const handleUndoRef = useRef<() => void>(() => {});
  const handleRedoRef = useRef<() => void>(() => {});
  const handleSplitRef = useRef<() => void>(() => {});

  // Hotkeys with input guard (Space, J/K/L, arrows, S for split, Ctrl+Z / Ctrl+Shift+Z, Этап 10 п. 95; Задача 1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (isInput) {
        if (!((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'e'))) return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) handleRedoRef.current();
        else handleUndoRef.current();
        return;
      }
      if (e.code === 'Space' || (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        clockRef.current.togglePlayPause();
      } else if (e.code === 'ArrowLeft' || (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'j')) {
        e.preventDefault();
        clockRef.current.seek(Math.max(0, clockRef.current.getTime() - 5), 'seek');
      } else if (e.code === 'ArrowRight' || (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'l')) {
        e.preventDefault();
        clockRef.current.seek(Math.min(duration, clockRef.current.getTime() + 5), 'seek');
      } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSplitRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSaveRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault();
        setShowExport(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duration]);

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

  const resolveLLMConfig = () => {
    const settings = getSettings();
    const requestedId = project?.settings.llmProvider || settings.defaultLLMProvider || 'openrouter';
    const provider = getLLMProvider(requestedId)
      || getLLMProvider(settings.defaultLLMProvider)
      || getLLMProvider('openrouter')!;
    const llmId = provider.id;
    const customRaw = typeof window !== 'undefined' ? (localStorage.getItem('mvs-info:custom-llm-config') || localStorage.getItem('custom-llm-config')) : null;
    let baseUrl: string | undefined;
    const requestedModel = project?.settings.visionModel || settings.defaultVisionModel;
    let model = resolveLLMVisionModel(provider, requestedModel) || provider.defaultModel;
    if (customRaw && llmId === 'custom') {
      try {
        const cfg = JSON.parse(customRaw);
        baseUrl = cfg.baseUrl || baseUrl;
        model = cfg.model || model;
      } catch {}
    }
    return { provider, llmId, baseUrl, model, accountId: settings.cloudflareAccountId, settings };
  };

  /** Имя канала для fallback-текстов: project.settings.channelName →
   *  настройки приложения → siteName → 'Manga Voice Studio'. */
  const resolveChannel = () => {
    if (!project) return undefined;
    return resolveChannelName(project, getSettings());
  };

  const handleGenerateIntro = async () => {
    if (!project) return;
    const keys = getAllKeys();
    const { provider, llmId, baseUrl, model, accountId } = resolveLLMConfig();
    const apiKey = keys[llmId] || keys[provider?.id || ''] || (llmId === 'gemini' ? keys['google-ai'] : '');
    if (!provider || !apiKey) {
      applyIntroOutroChange({ intro: generateFallbackIntro(project.panels, resolveChannel()) });
      return;
    }
    setIsGeneratingIntro(true);
    try {
      const text = await generateIntro(project.sceneDescription || project.panels.map(p => p.dialogue).join(' '), project.characters.map(c => c.name), provider, { apiKey, model, baseUrl, accountId, temperature: 0.8 });
      applyIntroOutroChange({ intro: text });
    } catch {
      applyIntroOutroChange({ intro: generateFallbackIntro(project.panels, resolveChannel()) });
    } finally {
      setIsGeneratingIntro(false);
    }
  };

  const handleGenerateOutro = async () => {
    if (!project) return;
    const keys = getAllKeys();
    const { provider, llmId, baseUrl, model, accountId, settings } = resolveLLMConfig();
    const apiKey = keys[llmId] || keys[provider?.id || ''] || (llmId === 'gemini' ? keys['google-ai'] : '');
    if (!provider || !apiKey) {
      applyIntroOutroChange({ outro: generateFallbackOutro(project.panels, resolveChannel()) });
      return;
    }
    setIsGeneratingIntro(true);
    try {
      const text = await generateOutro(resolveChannel() || settings.siteName, settings.ctaType, provider, { apiKey, model, baseUrl, accountId });
      applyIntroOutroChange({ outro: text });
    } catch {
      applyIntroOutroChange({ outro: generateFallbackOutro(project.panels, resolveChannel()) });
    } finally {
      setIsGeneratingIntro(false);
    }
  };

  /**
   * Модалка «Интро/Аутро» → «Сгенерировать AI»: оба текста по панелям.
   * Без ключа — без alert: пустые поля заполняются шаблоном (с именем
   * канала), заполненные — notice о причине.
   */
  const handleIntroOutroAI = async () => {
    if (!project) return;
    const keys = getAllKeys();
    const { provider, llmId, baseUrl, model, accountId, settings } = resolveLLMConfig();
    const apiKey = keys[llmId] || keys[provider?.id || ''] || (llmId === 'gemini' ? keys['google-ai'] : '');
    const channel = resolveChannel();
    if (!provider || !apiKey) {
      const patch: { intro?: string; outro?: string } = {};
      if (!project.intro.trim()) { patch.intro = generateFallbackIntro(project.panels, channel); }
      if (!project.outro.trim()) { patch.outro = generateFallbackOutro(project.panels, channel); }
      if (patch.intro || patch.outro) {
        applyIntroOutroChange(patch);
        setNotice('Ключ AI не добавлен — пустым интро/аутро поставлен шаблон. Для генерации по панелям добавьте ключ в «Настройках».');
      } else {
        setNotice('Ключ AI не добавлен — сгенерировать текст интро/аутро нельзя. Добавьте ключ в «Настройках» или введите текст вручную.');
      }
      return;
    }
    setIsGeneratingIntro(true);
    try {
      const [introText, outroText] = await Promise.all([
        generateIntro(project.sceneDescription || project.panels.map(p => p.dialogue).join(' '), project.characters.map(c => c.name), provider, { apiKey, model, baseUrl, accountId, temperature: 0.8 }),
        generateOutro(channel || settings.siteName, settings.ctaType, provider, { apiKey, model, baseUrl, accountId }),
      ]);
      applyIntroOutroChange({ intro: introText, outro: outroText });
    } catch {
      applyIntroOutroChange({
        intro: project.intro.trim() ? project.intro : generateFallbackIntro(project.panels, channel),
        outro: project.outro.trim() ? project.outro : generateFallbackOutro(project.panels, channel),
      });
      setNotice('Не удалось сгенерировать текст интро/аутро — пустым полям поставлен шаблон.');
    } finally {
      setIsGeneratingIntro(false);
    }
  };

  /** Модалка «Интро/Аутро» → «Озвучить»: TTS только для intro/outro. */
  const handleVoiceIntroOutro = async () => {
    if (!project) return;
    if (!project.intro.trim() && !project.outro.trim()) {
      setNotice('Озвучивать нечего: тексты интро и аутро пустые.');
      return;
    }
    const ttsId = resolveTTSProviderId(project.settings.ttsProvider, getSettings().defaultTTSProvider);
    if (!ttsId) {
      setNotice('Не выбран TTS-провайдер. Откройте «Голоса» и выберите его.');
      return;
    }
    setVoicingIntroOutro(true);
    setAudioProgress('Озвучка интро/аутро…');
    try {
      const result = await generateAllAudio({
        projectId: project.id,
        panels: [],
        voiceAssignments: project.voiceAssignments,
        intro: project.intro,
        outro: project.outro,
        ttsProviderId: ttsId,
        model: project.settings.ttsModel || undefined,
        language: project.settings.ttsLanguage || 'ru',
        speed: project.settings.ttsSpeed,
        previousTexts: {},
      });
      const durationPatch: { introDuration?: number; outroDuration?: number } = {};
      if (result.introAudio) {
        setIntroAudio(result.introAudio);
        const dur = roundMediaDuration(await getAudioDuration(result.introAudio));
        setIntroAudioDuration(dur);
        durationPatch.introDuration = dur;
      }
      if (result.outroAudio) {
        setOutroAudio(result.outroAudio);
        const dur = roundMediaDuration(await getAudioDuration(result.outroAudio));
        setOutroAudioDuration(dur);
        durationPatch.outroDuration = dur;
      }
      if (Object.keys(durationPatch).length > 0) {
        applyIntroOutroChange(durationPatch);
      }
      if (result.errors.length > 0) {
        setAudioError(result.errors[0] + (result.errors.length > 1 ? `\nЕщё ошибок: ${result.errors.length - 1}.` : ''));
      } else {
        setAudioProgress('Интро/аутро озвучены, сохранено в OPFS.');
        setTimeout(() => setAudioProgress(''), 3000);
      }
    } catch (e: unknown) {
      setAudioError(e instanceof Error ? e.message : String(e));
    } finally {
      setVoicingIntroOutro(false);
    }
  };

  /** Модалка «Интро/Аутро» → «Очистить»: тексты в ноль, длительности — дефолт. */
  const handleClearIntroOutro = () => {
    applyIntroOutroChange({ intro: '', outro: '', introDuration: 8, outroDuration: 5 });
  };
  const handleImportIntroAudio = async (file: File) => {
    if (!project) return;
    const rawDuration = await getImportedAudioDuration(file);
    const duration = roundMediaDuration(rawDuration);
    await saveProjectIntroAudio(project.id, file);
    setIntroAudio(file);
    setIntroAudioDuration(duration);
    applyIntroOutroChange({ introDuration: duration });
    setNotice(`Аудио интро загружено: ${duration.toFixed(2)} с.`);
  };
  const handleImportOutroAudio = async (file: File) => {
    if (!project) return;
    const rawDuration = await getImportedAudioDuration(file);
    const duration = roundMediaDuration(rawDuration);
    await saveProjectOutroAudio(project.id, file);
    setOutroAudio(file);
    setOutroAudioDuration(duration);
    applyIntroOutroChange({ outroDuration: duration });
    setNotice(`Аудио аутро загружено: ${duration.toFixed(2)} с.`);
  };
  const handleClearIntroAudio = async () => {
    if (!project) return;
    await deleteProjectAudio(project.id, 'intro');
    setIntroAudio(null);
    setIntroAudioDuration(null);
    setNotice('Аудио интро удалено.');
  };
  const handleClearOutroAudio = async () => {
    if (!project) return;
    await deleteProjectAudio(project.id, 'outro');
    setOutroAudio(null);
    setOutroAudioDuration(null);
    setNotice('Аудио аутро удалено.');
  };

  /**
   * Снимок текстов для мягкой миграции. Панели, которые сейчас переозвучиваются,
   * исключаем, чтобы «Переозвучить» не вернуло старый файл без подписи.
   */
  const targetPreviousTexts = (excludeIds?: number[]): Record<number, string> | undefined => {
    if (!project) return undefined;
    const snapshot = project.audioTexts;
    if (!snapshot) return undefined;
    if (!excludeIds?.length) return snapshot;
    const filtered: Record<number, string> = {};
    for (const [id, text] of Object.entries(snapshot)) {
      if (!excludeIds.includes(Number(id))) filtered[Number(id)] = text;
    }
    return filtered;
  };

  /** Общий путь: генерация (всех панелей или только выбранных) + обновление таймлайна. */
  const runAudioGeneration = async (
    onlyPanelIds?: number[],
    options?: { forceRegenerate?: boolean; providerId?: string }
  ) => {
    if (!project) return;
    setAudioError(null);
    const ttsId = resolveTTSProviderId(
      project.settings.ttsProvider,
      getSettings().defaultTTSProvider,
      options?.providerId
    );
    if (!ttsId) {
      setAudioError('Не выбран TTS-провайдер. Откройте «Голоса» и выберите его.');
      return;
    }
    const panels = onlyPanelIds
      ? project.panels.filter(p => onlyPanelIds.includes(p.id))
      : project.panels;

    setIsGeneratingAudio(true);
    setAudioDone(0);
    setAudioTotal(panels.length || project.panels.length);
    setAudioProgress('0/' + (panels.length || project.panels.length));

    try {
      const result = await generateAllAudio({
        projectId: project.id,
        panels: project.panels,
        voiceAssignments: project.voiceAssignments,
        intro: onlyPanelIds ? undefined : project.intro,
        outro: onlyPanelIds ? undefined : project.outro,
        ttsProviderId: ttsId,
        model: project.settings.ttsModel || undefined,
        language: project.settings.ttsLanguage || 'ru',
        speed: project.settings.ttsSpeed,
        onlyPanelIds,
        // Явная переозвучка игнорирует и OPFS-файл, и общий TTS-кэш.
        forceRegenerate: options?.forceRegenerate,
        // Снимок текстов прошлой генерации: аудио без .sig используется, только
        // если текст не менялся. Для переозвучиваемых панелей снимок не даём —
        // иначе «Переозвучить» вернуло бы старый файл из кэша.
        previousTexts: targetPreviousTexts(onlyPanelIds),
        onProgress: (c, t) => {
          setAudioDone(c);
          setAudioTotal(t);
          setAudioProgress(`${c}/${t}`);
        }
      });

      // Мержим с уже имеющимся аудио, чтобы точечная переозвучка не стирала остальное
      const blobsOnly = new Map<number, Blob>(audioBlobs);
      const fullMap = new Map<number, { blob: Blob; duration: number }>(audioFull);
      const newDur = new Map<number, number>(audioDurations);
      result.panelAudios.forEach((v, k) => {
        blobsOnly.set(k, v.blob);
        fullMap.set(k, v);
        newDur.set(k, v.duration);
      });
      result.durations.forEach((v, k) => { if (!newDur.has(k)) newDur.set(k, v); });

      setAudioBlobs(blobsOnly);
      setAudioFull(fullMap);
      setAudioDurations(newDur);
      let nextIntroDuration = project.introDuration;
      let nextOutroDuration = project.outroDuration;
      if (result.introAudio) {
        setIntroAudio(result.introAudio);
        const introDur = roundMediaDuration(await getAudioDuration(result.introAudio));
        setIntroAudioDuration(introDur);
        nextIntroDuration = introDur;
      }
      if (result.outroAudio) {
        setOutroAudio(result.outroAudio);
        const outroDur = roundMediaDuration(await getAudioDuration(result.outroAudio));
        setOutroAudioDuration(outroDur);
        nextOutroDuration = outroDur;
      }

      const obj: Record<number, number> = {};
      newDur.forEach((v, k) => obj[k] = v);
      // Финальный SRT: реальные длительности озвучки + интро/аутро проекта (Задача 12).
      const rebuilt = rebuildSrt({
        panels: project.panels,
        audioDurations: newDur,
        voiceAssignments: project.voiceAssignments,
        intro: project.intro,
        outro: project.outro,
        introDuration: nextIntroDuration,
        outroDuration: nextOutroDuration,
        panelGap,
        realDurations: obj,
      });
      const tl = rebuilt.timeline;
      const srt = rebuilt.srt;
      // Обновляем снимок текстов для всех озвученных панелей (включая старые,
      // которые остались в кэше) — это база для следующей мягкой миграции.
      const audioTexts: Record<number, string> = { ...(project.audioTexts || {}) };
      for (const panel of project.panels) audioTexts[panel.id] = panel.dialogue;
      // Явная переозвучка (forceRegenerate): отметка «импорт» снимается только
      // там, где TTS записал новый файл. Импортированный файл заранее не
      // удаляется (см. handleRegeneratePanel), так что при упавшем синтезе он
      // цел — и сообщение об ошибке это говорит. Панели, до которых синтез не
      // дошёл, и упавшие неотличимы для отметки: обе остаются «импортом».
      const regeneratedIds = options?.forceRegenerate ? (onlyPanelIds ?? project.panels.map(p => p.id)) : [];
      const settled = settleImportRegeneration({
        panels: project.panels,
        regeneratedIds,
        succeededIds: result.panelAudios.keys(),
        errors: result.errors,
      });
      const panelsAfter = settled.panels;
      updateProject({
        timeline: tl,
        srt,
        introDuration: nextIntroDuration,
        outroDuration: nextOutroDuration,
        audioDurations: obj,
        audioTexts,
        timelineVersion: (project.timelineVersion ?? 2) + 1,
        ...(panelsAfter !== project.panels ? { panels: panelsAfter } : {}),
      });

      if (settled.errors.length > 0) {
        const [firstError, ...otherErrors] = settled.errors;
        setAudioError(otherErrors.length > 0
          ? `${firstError}\nЕщё ошибок: ${otherErrors.length}.`
          : firstError);
      }
      setAudioProgress('Готово! Сохранено в OPFS.');
      setTimeout(() => setAudioProgress(''), 3000);
    } catch (e: unknown) {
      setAudioError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  const handleGenerateAudio = async () => {
    if (!project) return;
    const ttsId = resolveTTSProviderId(project.settings.ttsProvider, getSettings().defaultTTSProvider);
    if (!ttsId) {
      setAudioError('Не выбран TTS-провайдер. Откройте «Голоса» и выберите его.');
      return;
    }
    // Импортированные панели TTS не трогает (generateAllAudio их пропускает) —
    // и в стоимость они не входят.
    const ttsPanels = project.panels.filter(p => p.audioSource !== 'import');
    const importedCount = project.panels.length - ttsPanels.length;
    const cost = estimateTotalCost(ttsPanels, project.intro, project.outro, ttsId);
    const providerName = getTTSProvider(ttsId)?.name || ttsId;
    // Первая строка диалога — та же, что на кнопке: «Озвучить все N панелей»,
    // «Озвучить оставшиеся N» или «Переозвучить всё».
    const importedNote = importedCount > 0
      ? `\nИмпортированное аудио (${importedCount}) не трогается — переозвучить его можно кнопкой «↻» у панели.`
      : '';
    const confirmed = confirm(
      `${voiceButton.label}?\nПровайдер: ${providerName} (${ttsId})\nСимволов: ${cost.characters}\nСтоимость: ${cost.estimatedCost}${importedNote}\n\nOPFS кэш — повтор бесплатно. Изменённый текст/голос озвучивается заново.`
    );
    if (!confirmed) return;

    try {
      const saved = await saveProject(project, { allowStale: true });
      project.revision = saved.revision;
      setSaveStatus('saved');
    } catch (error) {
      setSaveStatus('unsaved');
      setAudioError(`Не удалось сохранить настройки проекта перед озвучкой: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await runAudioGeneration(undefined, { providerId: ttsId });
  };

  /**
   * Генерация SEO-пакета (раньше кнопки не было вообще, а generateSEO нигде не вызывался).
   * Если LLM недоступна — кладём шаблонный фолбэк, чтобы экспорт не был пустым.
   */
  const handleGenerateSEO = async () => {
    if (!project) return;
    const { provider, llmId, baseUrl, model, accountId } = resolveLLMConfig();
    const keys = getAllKeys();
    const apiKey = keys[llmId] || (provider ? keys[provider.id] : '') || (llmId === 'gemini' ? keys['google-ai'] : '');
    const scene = project.sceneDescription || project.panels.map(p => p.dialogue).join(' ');

    setGeneratingSEO(true);
    try {
      if (!provider || !apiKey) {
        updateProject({ seoPackage: generateFallbackSEO(scene, project.characters.map(c => c.name), duration) });
        return;
      }
      const seo = await generateSEO(scene, project.characters.map(c => c.name), duration, provider, {
        apiKey,
        model: model || provider.defaultModel,
        baseUrl,
        accountId,
        temperature: 0.7,
      });
      updateProject({ seoPackage: seo });
    } catch (e) {
      console.warn('SEO generation failed, using fallback', e);
      updateProject({ seoPackage: generateFallbackSEO(scene, project.characters.map(c => c.name), duration) });
    } finally {
      setGeneratingSEO(false);
    }
  };

  /** id панелей, у которых сейчас есть аудио — «уже есть» для плана импорта. */
  const existingAudioIds = useMemo(() => [...audioBlobs.keys()], [audioBlobs]);

  /**
   * Импорт аудио (v1.3.18): applyAudioImport пишет файлы в OPFS по ключам
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

  /**
   * Точечная переозвучка одной панели: чистим OPFS-аудио и синтезируем заново.
   * Импортированное аудио — только с подтверждением из карточки панели
   * (двойной клик по кнопке, не confirm(): в iframe-превью он молча false).
   */
  const handleRegeneratePanel = async (panelId: number, opts?: { confirmedImportOverwrite?: boolean }) => {
    if (!project || isGeneratingAudio) return;
    const panel = project.panels.find(p => p.id === panelId);
    const imported = panel?.audioSource === 'import';
    if (imported && !opts?.confirmedImportOverwrite) return;
    // Импортированный файл заранее не удаляем: forceRegenerate его не читает,
    // успешный синтез перезапишет, а упавший оставит запись пользователя целой.
    if (!imported) {
      try {
        const { deleteProjectAudio } = await import('@/lib/storage/opfs');
        await deleteProjectAudio(project.id, panelId);
      } catch {}
      setAudioBlobs(prev => {
        const next = new Map(prev);
        next.delete(panelId);
        return next;
      });
    }
    // forceRegenerate: без него при неизменном тексте и голосе генерация
    // возвращала тот же файл из общего TTS-кэша — кнопка «Переозвучить» врала.
    await runAudioGeneration([panelId], { forceRegenerate: true });
  };

  /**
   * Сценарий, правило 2: реплики переводятся на язык озвучки проекта.
   * Бросает ошибку, если провайдер/ключ недоступны — модалка применит
   * сценарий без перевода и покажет причину баннером.
   */
  const handleTranslateScenario = async (texts: string[]): Promise<string[]> => {
    if (!project) throw new Error('Проект не загружен');
    const { provider, llmId, baseUrl, model, accountId } = resolveLLMConfig();
    const keys = getAllKeys();
    const apiKey = keys[llmId] || (provider ? keys[provider.id] : '') || (llmId === 'gemini' ? keys['google-ai'] : '');
    if (!provider || !apiKey) {
      throw new Error(`Провайдер «${provider?.name || llmId}» не настроен: добавьте его ключ в «Настройки → Провайдеры»`);
    }
    const language = project.settings.ttsLanguage || 'ru';
    if (!isTranslatableLanguage(language)) {
      throw new Error(`Перевод недоступен для языка «${language}» — выберите конкретный язык озвучки в «Голоса».`);
    }
    // Приоритет: модель, выбранная в модалке «Сценарий» (chatModel),
    // затем дефолт провайдера, и лишь потом vision-модель из resolveLLMConfig.
    const chatModel = project.settings.chatModel || provider.defaultModel || model;
    return translateScenarioLines(texts, language, provider, { apiKey, model: chatModel, baseUrl, accountId });
  };

  /**
   * Применение сценария к проекту:
   * — каждая реплика становится панелью на своём изображении («Изображение N»);
   * — пол (Жен.)/(Муж.) сохраняется на персонаже и используется для автоподбора голоса;
   * — пауза между репликами = 0,6 с (правило 3): после чтения — переход к следующему изображению;
   * — без лишнего текста (правило 5): сценарий управляет только панелями,
   *   интро/аутро проекта СОХРАНЯЮТСЯ (v1.3.16) — это отдельные сущности.
   * Старое аудио панелей удаляется — иначе в экспорт попала бы чужая озвучка.
   */
  const handleApplyScenario = async (lines: ScenarioLine[], translatedTexts: string[] | null, notice?: string) => {
    if (!project) return;
    // Без изображений индекс изображения некуда класть: clamp в
    // scenarioToPanels не сработает, а Preview упадёт на images[-1].
    if (images.length === 0) {
      setNotice('Сначала загрузите хотя бы одно изображение — без картинки сценарий применить нельзя (нечему сопоставлять реплики).');
      return;
    }
    const appliedLines = lines.map((line, i) =>
      translatedTexts?.[i] ? { ...line, text: translatedTexts[i] } : line
    );

    // Голоса: у персонажа с известным полом и без назначенного голоса подбираем по полу.
    // Персонажи берём из чистого слияния (applyScenarioToProject) — там же
    // считается остальное; вызов дешёвый, второй проход ниже — с финальными голосами.
    const prePatch = applyScenarioToProject(project, appliedLines, {
      imagesCount: images.length,
      panelGap: SCENARIO_GAP_SECONDS,
      voiceAssignments: project.voiceAssignments,
    });
    const voiceAssignments = { ...project.voiceAssignments };
    try {
      const ttsId = resolveTTSProviderId(project.settings.ttsProvider, getSettings().defaultTTSProvider);
      const provider = ttsId ? getTTSProvider(ttsId) : undefined;
      const keys = getAllKeys();
      if (provider && keys[ttsId]) {
        const voices = await provider.getVoices(keys[ttsId]);
        for (const char of prePatch.characters) {
          if (!char.gender || voiceAssignments[char.name]) continue;
          const match = voices.find(v => v.gender === char.gender) || voices.find(v => v.gender === 'neutral');
          if (match) voiceAssignments[char.name] = match.id;
        }
      }
    } catch (error) {
      console.warn('Не удалось подобрать голоса по полу', error);
    }

    // Старое аудио больше не соответствует тексту — удаляем (OPFS + память)
    for (const panel of project.panels) {
      try {
        await deleteProjectAudio(project.id, panel.id);
      } catch {}
    }
    setAudioBlobs(new Map());
    setAudioFull(new Map());
    setAudioDurations(new Map());

    // Итоговое обновление: панели + таймлайн/SRT из ТЕКУЩИХ интро/аутро
    // проекта (они не очищаются).
    const patch = applyScenarioToProject(project, appliedLines, {
      imagesCount: images.length,
      panelGap: SCENARIO_GAP_SECONDS,
      voiceAssignments,
    });
    const settings = { ...project.settings, panelGap: SCENARIO_GAP_SECONDS };

    updateProject({
      panels: patch.panels,
      characters: patch.characters,
      voiceAssignments,
      settings,
      timeline: patch.timeline,
      srt: patch.srt,
      timelineVersion: patch.timelineVersion,
      audioDurations: {},
      audioTexts: {},
    });
    if (patch.panels.length > 0) {
      setSelectedId(patch.panels[0].id);
      setCurrentPanelIdx(0);
    }
    setShowScenario(false);
    // Без alert: в встроенном превью диалоги могут быть запрещены браузером.
    const messages = [notice, ...patch.warnings].filter(Boolean);
    // Связка «сценарий → озвучка»: аудио удалено, следующий шаг — «Озвучить всё»
    // (кнопка при этом подсвечена и показывает «Озвучить все N панелей»).
    if (patch.panels.length > 0) {
      messages.push('Аудио удалено. Нажмите «Озвучить всё» — сгенерируется озвучка, SRT станет финальным.');
    }
    const noticeText = messages.join('\n');
    if (noticeText) setNotice(noticeText);
  };

  const handleExport = async (type: 'mp4' | 'mp3' | 'srt' | 'seo' | 'all') => {
    if (!project) return;
    setIsExporting(true);
    try {
      if (type === 'srt' || type === 'all') {
        if (project.srt) downloadBlob(new Blob([project.srt], { type: 'text/plain' }), `${project.name}.srt`);
        else if (type === 'srt') alert('Нет SRT, сначала озвучь');
      }
      if (type === 'seo' || type === 'all') {
        if (project.seoPackage) downloadBlob(new Blob([formatSEOPackage(project.seoPackage)], { type: 'text/plain' }), `${project.name}-SEO.txt`);
        else if (type === 'seo') alert('Нет SEO пакета');
      }
      if (type === 'mp3' || type === 'all') {
        const all: Blob[] = [];
        if (introAudio) all.push(introAudio);
        for (const p of project.panels) {
          const b = audioBlobs.get(p.id) || await loadProjectAudio(project.id, p.id);
          if (b) all.push(b);
        }
        if (outroAudio) all.push(outroAudio);
        if (all.length > 0) {
          // concatenateAudioBlobs всегда отдаёт WAV — раньше файл всё равно назывался .mp3
          const merged = await concatenateAudioBlobs(all);
          const ext = merged.type.includes('wav') ? 'wav' : merged.type.includes('mpeg') ? 'mp3' : 'bin';
          downloadBlob(merged, `${project.name}.${ext}`);
        } else if (type === 'mp3') alert('Сначала озвучь');
      }
      if (type === 'mp4') {
        if (images.length === 0) {
          alert('Нет изображений для видео');
          return;
        }
        const tl = project.timeline.length > 0 ? project.timeline : buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, panelGap);

        // Точные позиции аудио на таймлайне с учётом trimIn/trimOut, gain, fadeIn/fadeOut и mute/solo (Этап 9 п. 82, 83)
        const resolvedPanelBlobs = new Map<number, Blob>(audioBlobs);
        for (const p of project.panels) {
          if (!resolvedPanelBlobs.has(p.id)) {
            const fromOpfs = await loadProjectAudio(project.id, p.id);
            if (fromOpfs) resolvedPanelBlobs.set(p.id, fromOpfs);
          }
        }
        const audioPlacements: AudioPlacement[] = buildTimelineAudioPlacements({
          timeline: tl,
          panels: project.panels,
          panelBlobs: resolvedPanelBlobs,
          introAudio,
          outroAudio,
          introDuration: project.introDuration,
          outroDuration: project.outroDuration,
        });

        if (audioPlacements.length === 0) {
          alert('Сначала озвучь — нет аудио для видео. Экспортирую без звука.');
        }

        const { blob, mimeType } = await renderVideo({
          images,
          audioBlobs: audioPlacements.map(a => a.blob),
          audioPlacements,
          timeline: tl,
          introText: project.intro,
          outroText: project.outro,
          introDuration: project.introDuration,
          outroDuration: project.outroDuration,
          introAudioDuration,
          outroAudioDuration,
          srtContent: project.srt,
          width: 1920,
          height: 1080,
          fps: 30,
          renderMode: renderSettings.renderMode,
          stripViewport: renderSettings.stripViewport,
          stripGap: renderSettings.stripGap,
          panels: project.panels.map(p => ({ id: p.id, imageIndex: p.imageIndex, bbox: p.bbox, fullFrame: p.fullFrame })),
          onAudioTrimmed: (messages) => setAudioWarnings(messages),
          preferredBackend: preferredBackend === 'auto' ? undefined : preferredBackend
        });

        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        downloadBlob(blob, `${project.name}.${ext}`);
        setShowExport(false);
      }
    } catch (e: any) {
      alert(`Ошибка экспорта: ${e.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  /** Предпрослушивание финального аудиомикса перед экспортом видео (Этап 9 п. 87). */
  const handlePreviewAudioMix = async (): Promise<string | null> => {
    if (!project) return null;
    const resolvedPanelBlobs = new Map<number, Blob>(audioBlobs);
    for (const p of project.panels) {
      if (!resolvedPanelBlobs.has(p.id)) {
        const fromOpfs = await loadProjectAudio(project.id, p.id);
        if (fromOpfs) resolvedPanelBlobs.set(p.id, fromOpfs);
      }
    }
    const placements = buildTimelineAudioPlacements({
      timeline: tl,
      panels: project.panels,
      panelBlobs: resolvedPanelBlobs,
      introAudio,
      outroAudio,
      introDuration: project.introDuration,
    });
    const wavBlob = await renderExportAudioMixPreviewWav(placements, duration);
    if (!wavBlob) return null;
    return urlRegistryRef.current.acquire('export:mix-preview', wavBlob).url;
  };

  /** Скачивание диагностического JSON-отчёта о проекте и синхронизации (Этап 9 п. 88). */
  const handleDownloadDiagnosticJson = () => {
    if (!project || !healthReport) return;
    const json = buildDiagnosticReportJson(project, healthReport);
    downloadBlob(
      new Blob([json], { type: 'application/json;charset=utf-8' }),
      `${project.name || project.id}-diagnostics.json`
    );
  };

  /** Полный экспорт проекта в .zip с проверкой контрольных сумм (Этап 8 п. 76). */
  const handleExportProjectZip = async () => {
    if (!project) return;
    try {
      const audioMap = new Map<number | 'intro' | 'outro', Blob>();
      for (const [idKey, blob] of audioBlobs.entries()) audioMap.set(idKey, blob);
      if (introAudio) audioMap.set('intro', introAudio);
      if (outroAudio) audioMap.set('outro', outroAudio);
      const { blob } = await exportProjectToZip(project, {
        images,
        audio: audioMap,
      });
      downloadBlob(blob, `${project.name || project.id}.zip`);
    } catch (e) {
      setNotice(`Не удалось экспортировать архив проекта: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Восстановление проекта из .zip с верификацией SHA-256 (Этап 8 п. 77). */
  const handleImportProjectZip = async (file: File) => {
    try {
      const restored = await importProjectFromZip(file);
      const nextBlobs = new Map<number, Blob>();
      const nextDurations = new Map<number, number>();
      for (const [slotKey, blob] of restored.audio.entries()) {
        if (slotKey === 'intro') {
          setIntroAudio(blob);
          try { await saveProjectIntroAudio(restored.project.id, blob); } catch {}
        } else if (slotKey === 'outro') {
          setOutroAudio(blob);
          try { await saveProjectOutroAudio(restored.project.id, blob); } catch {}
        } else {
          nextBlobs.set(slotKey, blob);
          try { await saveProjectAudio(restored.project.id, slotKey, blob); } catch {}
        }
      }
      for (const [k, v] of Object.entries(restored.project.audioDurations ?? {})) {
        nextDurations.set(Number(k), v);
      }
      setProject(restored.project);
      setImages(restored.imageDataUrls);
      setAudioBlobs(nextBlobs);
      setAudioDurations(nextDurations);
      setShowHealthModal(false);
      setNotice(`Проект успешно восстановлен из архива (проверено ресурсов: ${restored.verifiedCount}).`);
    } catch (e) {
      setNotice(`Ошибка восстановления из архива: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Memoize timeline to avoid recalculating on every render (perf fix for 30+ panels)
  /** Сценарий текущего проекта текстом: модалка открывается с этим содержимым. */
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

  useEffect(() => {
    handleUndoRef.current = handleUndo;
    handleRedoRef.current = handleRedo;
    handleSplitRef.current = handleSplitActiveClip;
  });

  const handleSeek = useCallback((t: number) => {
    if (!isFinite(t)) return;
    playerRef.current?.pause();
    clockRef.current.pause('pause');
    clockRef.current.seek(t, 'seek');
    if (!project) return;
    const seg = tl.find(s => t >= s.audioStart && t < s.audioEnd);
    if (seg) {
      const idx = project.panels.findIndex(p => p.id === seg.panelId);
      if (idx !== -1) {
        setCurrentPanelIdx(idx);
        setSelectedId(seg.panelId);
      }
    }
  }, [project, tl]);

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

  if (isProjectLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-[#0B0B0C] text-[#8A8A93]" role="status" aria-live="polite">
        <Loader2 className="w-6 h-6 animate-spin" />
        <span className="text-sm">Загрузка проекта...</span>
      </div>
    );
  }

  if (projectLoadError || !project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0B0B0C] px-4">
        <div className="w-full max-w-lg rounded-[16px] border border-[#26262C] bg-[#16161A] p-6 text-center" role="alert">
          <h1 className="text-lg font-medium">Не удалось открыть проект</h1>
          <p className="mt-2 text-sm text-[#A1A1AA]">{projectLoadError || 'Проект не найден в локальном хранилище.'}</p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setLoadAttempt(attempt => attempt + 1)}
              className="h-9 rounded-[6px] bg-[#E8B44C] px-4 text-sm font-medium text-[#0B0B0C] hover:bg-[#B88A2E] transition-colors"
            >
              Повторить
            </button>
            <Link href="/" className="h-9 rounded-[6px] border border-[#26262C] px-4 text-sm text-[#F5F5F7] hover:bg-[#1E1E23] transition-colors flex items-center">
              К проектам
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="editor-root"
      data-timeline-version={project.timelineVersion ?? 2}
      data-total-duration={duration.toFixed(3)}
      className="flex-1 bg-[#0B0B0C] flex flex-col min-h-0"
    >
      <div className="h-14 px-4 flex items-center justify-between border-b border-[#26262C] bg-[#0B0B0C]/80 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="w-8 h-8 rounded-[6px] bg-[#16161A] border border-[#26262C] flex items-center justify-center hover:bg-[#1E1E23] transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Input value={project.name} onChange={(e) => updateProject({ name: e.target.value })} className="h-8 bg-transparent border-transparent hover:border-[#26262C] focus:border-[#26262C] text-[14px] font-medium px-2 max-w-[240px]" />
          <span className={`text-[11px] font-mono ${saveStatus === 'saved' ? 'text-[#8A8A93]' : saveStatus === 'saving' ? 'text-[#E8B44C]' : 'text-[#F87171]'}`}>
            {saveStatus === 'saved' ? 'сохранено' : saveStatus === 'saving' ? 'сохранение...' : 'не сохранено'}
          </span>
          {/* Индикатор готовности проекта в шапке редактора (Этап 10 п. 91, 93) */}
          {healthReport && (
            <button
              type="button"
              onClick={() => setShowHealthModal(true)}
              className={`h-6 px-2 rounded-full border text-[10px] font-mono hidden sm:flex items-center gap-1.5 transition-colors ${
                healthReport.status === 'ready'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                  : healthReport.status === 'errors'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                  : 'border-[#594615] bg-[#2A2416] text-[#E8B44C] hover:bg-[#3A311D]'
              }`}
              title="Открыть «Проверку проекта», журнал событий и архивацию (.zip)"
            >
              <span>●</span>
              <span>{healthReport.badgeLabel}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="open-health-btn"
            onClick={() => setShowHealthModal(true)}
            className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap"
            title="Проверка проекта, диагностика синхронизации и экспорт/импорт .zip"
          >
            Проверка
          </button>
          <button data-testid="open-scenario-btn" onClick={() => setShowScenario(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap">
            Сценарий
          </button>
          <button
            onClick={() => editorImageInputRef.current?.click()}
            disabled={isUploadingImages || isGeneratingAudio}
            className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap disabled:opacity-40"
          >
            {isUploadingImages ? 'Загрузка...' : 'Добавить изображения'}
          </button>
          <input
            ref={editorImageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) void handleAddImages(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            data-testid="open-audio-import-btn"
            onClick={() => setShowAudioImport(true)}
            disabled={isGeneratingAudio || project.panels.length === 0}
            title={project.panels.length === 0 ? 'Сначала создайте панели (сценарий или анализ изображений)' : 'Свои аудиофайлы на панели — по манифесту, якорю в имени, номеру или порядку'}
            className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap disabled:opacity-40 disabled:hover:bg-[#16161A]"
          >
            Импорт аудио
          </button>
          <button data-testid="open-intro-outro-btn" onClick={() => setShowIntroOutro(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Интро/Аутро
          </button>
          <button onClick={() => setShowVoices(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Голоса
          </button>
          <button data-testid="open-export-btn" onClick={() => setShowExport(true)} className="h-8 px-3 rounded-[6px] bg-[#E8B44C] text-[#0B0B0C] text-xs font-medium hover:bg-[#B88A2E] transition-colors">
            Экспорт
          </button>
        </div>
      </div>

      {isGeneratingAudio && (
        <div className="h-0.5 w-full bg-[#16161A]" role="progressbar" aria-label="Озвучка">
          {/* раньше считалось от audioBlobs.size (обновлялся один раз в конце) — полоса стояла на 0% */}
          <div className="h-full bg-[#E8B44C] transition-all duration-300" style={{ width: `${(audioDone / Math.max(1, audioTotal || project.panels.length)) * 100}%` }} />
        </div>
      )}

      {audioError && (
        <div className="border-b border-[#3A1414] bg-[#1E1010] px-4 py-2" role="alert" aria-live="assertive">
          <div className="max-w-[960px] mx-auto flex items-start gap-3">
            <span className="text-[13px] leading-5 text-[#E86C4C]" aria-hidden="true">⚠</span>
            <div className="flex-1 space-y-0.5">
              <p className="text-[12px] font-medium text-[#E86C4C]">Озвучка не удалась</p>
              <p className="text-[11px] leading-4 text-[#C97A66] break-words whitespace-pre-wrap">{audioError}</p>
            </div>
            <button
              onClick={() => setAudioError(null)}
              className="h-6 px-2 rounded-[6px] border border-[#3A1414] text-[11px] text-[#C97A66] hover:bg-[#262010] transition-colors"
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      {audioWarnings.length > 0 && (
        <div className="border-b border-[#3A2E14] bg-[#1E1A10] px-4 py-2">
          <div className="max-w-[960px] mx-auto flex items-start gap-3">
            <span className="text-[13px] leading-5 text-[#E8B44C]">⚠</span>
            <div className="flex-1 space-y-0.5">
              <p className="text-[12px] font-medium text-[#E8B44C]">Аудио подогнано под таймлайн</p>
              {audioWarnings.map((line, i) => (
                <p key={i} className="text-[11px] leading-4 text-[#C9B27A]">{line}</p>
              ))}
              <p className="text-[11px] leading-4 text-[#8A8A93]">
                Проверьте длину реплик или сдвиньте паузы — иначе конец фразы может не прозвучать.
              </p>
            </div>
            <button
              onClick={() => setAudioWarnings([])}
              className="h-6 px-2 rounded-[6px] border border-[#3A2E14] text-[11px] text-[#C9B27A] hover:bg-[#262010] transition-colors"
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className="border-b border-[#3A2E14] bg-[#1E1A10] px-4 py-2" role="status" aria-live="polite">
          <div className="max-w-[960px] mx-auto flex items-start gap-3">
            <span className="text-[13px] leading-5 text-[#E8B44C]" aria-hidden="true">ℹ</span>
            <p className="flex-1 text-[11px] leading-4 text-[#C9B27A] break-words whitespace-pre-wrap">{notice}</p>
            <button
              onClick={() => setNotice(null)}
              className="h-6 px-2 rounded-[6px] border border-[#3A2E14] text-[11px] text-[#C9B27A] hover:bg-[#262010] transition-colors"
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto" data-scroll-area>
        <div className="max-w-[1180px] mx-auto p-3 sm:p-4 md:p-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
            <div className="min-w-0 space-y-5">
              <Preview
                images={images}
                panels={project.panels}
                currentPanelIndex={currentPanelIdx}
                timeline={tl}
                currentTime={currentTime}
                duration={duration}
                isPlaying={isPlaying}
                onPlayPause={() => clockRef.current.togglePlayPause()}
                clock={clockInstance}
                renderMode={renderSettings.renderMode}
                stripViewport={renderSettings.stripViewport}
                stripGap={renderSettings.stripGap}
                onSeek={handleSeek}
                onSelectPanel={(panelId) => {
                  setSelectedId(panelId);
                  const idx = project.panels.findIndex(p => p.id === panelId);
                  if (idx !== -1) setCurrentPanelIdx(idx);
                }}
                selectedPanelId={typeof selectedId === 'number' ? selectedId : null}
                audioPanelIds={existingAudioIds}
                introText={project.intro}
                outroText={project.outro}
                introDuration={project.introDuration}
                outroDuration={project.outroDuration}
                introAudioDuration={introAudioDuration}
                outroAudioDuration={outroAudioDuration}
                debugOverlay={project.settings.debugOverlay}
                onToggleDebugOverlay={(next) =>
                  updateProject({ settings: { ...project.settings, debugOverlay: next } })
                }
              />

              <RenderModePanel
                {...renderSettings}
                onChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
              />

              <Timeline
                images={images}
                timeline={tl}
                panels={project.panels}
                currentTime={currentTime}
                duration={duration}
                onSeek={handleSeek}
                onSelectPanel={(id) => {
                  setSelectedId(id);
                  const idx = project.panels.findIndex(p => p.id === id);
                  if (idx !== -1) setCurrentPanelIdx(idx);
                }}
                onSelectIntro={() => setSelectedId('intro')}
                onSelectOutro={() => setSelectedId('outro')}
                selectedId={selectedId}
                introDuration={project.introDuration}
                outroDuration={project.outroDuration}
                panelGap={panelGap}
                onGapChange={handleGapChange}
                audioPanelIds={existingAudioIds}
                isPlaying={isPlaying}
                onSplitActiveClip={handleSplitActiveClip}
                onMoveActiveClipLeft={() => handleMoveActiveClip(-1)}
                onMoveActiveClipRight={() => handleMoveActiveClip(1)}
                onReorderPanel={handleReorderClip}
                onReorderClip={(fromIdx, toIdx) => {
                  const sorted = [...project.panels].sort((a, b) => a.order - b.order || a.id - b.id);
                  const moved = sorted[fromIdx];
                  if (moved) handleReorderClip(moved.id, toIdx);
                }}
                onTrimPanel={handleSetPanelAudioTrim}
                onSetPanelTrim={handleSetPanelAudioTrim}
                onTogglePanelMute={handleTogglePanelMute}
                onTogglePanelSolo={handleTogglePanelSolo}
                canUndo={historyAvail.canUndo}
                canRedo={historyAvail.canRedo}
                onUndo={handleUndo}
                onRedo={handleRedo}
              />

              <div className="pt-2">
                {/* needsAttention: панели появились или аудио удалено/устарело —
                    подсвечиваем кнопку, пока всё не озвучено (связка с остальным UI) */}
                <button
                  onClick={handleGenerateAudio}
                  disabled={isGeneratingAudio}
                  className={`w-full h-11 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[14px] hover:bg-[#B88A2E] transition-colors duration-[150ms] disabled:opacity-50 flex items-center justify-center gap-2 ${voiceButton.needsAttention && !isGeneratingAudio ? 'shadow-[0_0_18px_rgba(232,180,76,0.35)]' : ''}`}
                >
                  {isGeneratingAudio ? <><Loader2 className="w-4 h-4 animate-spin" /> {audioProgress}</> : voiceButton.label}
                </button>
                {costEstimate && !isGeneratingAudio && (
                  <p className="text-center font-mono text-[11px] text-[#8A8A93] mt-2">{costEstimate.characters} симв. · {costEstimate.cost} · OPFS кэш — повтор бесплатно</p>
                )}
                {voiceButton.hint && !isGeneratingAudio && (
                  <p className="text-center text-[11px] text-[#E8B44C] mt-1">{voiceButton.hint}</p>
                )}
                {project.panels.length === 0 && (
                  <div className="mt-6 p-8 rounded-[16px] border border-dashed border-[#26262C] bg-[#16161A]/50 text-center">
                    <p className="text-[14px] font-medium">Проект пустой</p>
                    <p className="text-xs text-[#8A8A93] mt-1">Добавь изображения на главной или нажми «Озвучить» чтобы услышать интро/аутро</p>
                  </div>
                )}
              </div>
            </div>

            <aside className="min-w-0 lg:sticky lg:top-20">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[12px] uppercase tracking-[0.14em] text-[#8A8A93]">Инспектор панели</h2>
                <span className="text-[10px] text-[#8A8A93]">выберите сегмент</span>
              </div>
              <ContextPanel
                selected={contextValue as any}
                onUpdatePanel={(id, updates) => {
                  if (
                    updates.trimIn !== undefined ||
                    updates.trimOut !== undefined
                  ) {
                    const p = project.panels.find(item => item.id === id);
                    handleSetPanelAudioTrim(
                      id,
                      updates.trimIn ?? p?.trimIn ?? 0,
                      updates.trimOut ?? p?.trimOut ?? 0
                    );
                    if (Object.keys(updates).every(k => k === 'trimIn' || k === 'trimOut')) return;
                  }
                  if ('durationOverride' in updates) {
                    handleSetPanelDurationOverride(id, updates.durationOverride);
                    if (Object.keys(updates).every(k => k === 'durationOverride')) return;
                  }
                  if (
                    updates.gain !== undefined ||
                    updates.fadeIn !== undefined ||
                    updates.fadeOut !== undefined
                  ) {
                    handleSetPanelAudioGainAndFades(id, {
                      gain: updates.gain,
                      fadeIn: updates.fadeIn,
                      fadeOut: updates.fadeOut,
                    });
                    if (Object.keys(updates).every(k => k === 'gain' || k === 'fadeIn' || k === 'fadeOut')) return;
                  }
                  const snap = buildCurrentHistorySnapshot(`Правка панели #${id}`);
                  if (snap) historyRef.current.record(snap);
                  const newPanels = project.panels.map(p => p.id === id ? { ...p, ...updates } : p);
                  // Любое изменение панели немедленно инвалидирует и пересобирает устаревший таймлайн + SRT (Этап 1 п. 9)
                  const rebuilt = rebuildSrt({
                    panels: newPanels,
                    audioDurations,
                    voiceAssignments: project.voiceAssignments,
                    intro: project.intro,
                    outro: project.outro,
                    introDuration: project.introDuration,
                    outroDuration: project.outroDuration,
                    panelGap,
                    realDurations: project.audioDurations,
                  });
                  updateProject({
                    panels: newPanels,
                    timeline: rebuilt.timeline,
                    srt: rebuilt.srt,
                    timelineVersion: (project.timelineVersion ?? 2) + 1,
                  });
                  syncHistoryAvail();
                }}
                onUpdateIntro={(text, dur) => applyIntroOutroChange({ intro: text, introDuration: dur })}
                onUpdateOutro={(text, dur) => applyIntroOutroChange({ outro: text, outroDuration: dur })}
                voiceAssignments={project.voiceAssignments}
                onVoiceChange={(char, voiceId) => updateProject({ voiceAssignments: { ...project.voiceAssignments, [char]: voiceId } })}
                onGenerateIntro={handleGenerateIntro}
                onGenerateOutro={handleGenerateOutro}
                generating={isGeneratingIntro}
                onRegeneratePanel={handleRegeneratePanel}
                regenerating={isGeneratingAudio}
              />
            </aside>
          </div>

          <div className="pt-8 pb-4 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[#8A8A93]/60">
            <span>
              {project.useOPFS && opfsActive ? 'OPFS + IDB' : 'IDB fallback'} · {images.length} изобр. · {formatTime(duration)}
            </span>
            <span className="flex flex-wrap gap-3">
              <span>Space / K play</span>
              <span>J / L / ←→ ±5s</span>
              <span>S split</span>
              <span>⌘Z / ⇧⌘Z undo/redo</span>
              <span>⌘S save</span>
              <span>⌘E export</span>
            </span>
          </div>
        </div>
      </div>

      <ScenarioModal
        open={showScenario}
        onClose={() => setShowScenario(false)}
        imagesCount={images.length}
        existingPanels={project.panels.length}
        ttsLanguage={project.settings.ttsLanguage || 'ru'}
        currentScenario={currentScenarioText}
        llmProviderId={project.settings.llmProvider || getSettings().defaultLLMProvider || 'openrouter'}
        chatModel={project.settings.chatModel}
        onSettingsChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
        onApply={handleApplyScenario}
        onTranslate={handleTranslateScenario}
      />

      {showAudioImport && <AudioImportModal
        open
        onClose={() => setShowAudioImport(false)}
        panels={project.panels}
        existingAudio={existingAudioIds}
        onApply={handleImportAudio}
        canUndoLastImport={Boolean(lastImportUndo)}
        onUndoLastImport={() => void handleUndoLastAudioImport()}
      />}

      <IntroOutroModal
        open={showIntroOutro}
        onClose={() => setShowIntroOutro(false)}
        intro={project.intro}
        outro={project.outro}
        introDuration={project.introDuration}
        outroDuration={project.outroDuration}
        introAudio={introAudio}
        outroAudio={outroAudio}
        onIntroAudioUpload={handleImportIntroAudio}
        onOutroAudioUpload={handleImportOutroAudio}
        onClearIntroAudio={handleClearIntroAudio}
        onClearOutroAudio={handleClearOutroAudio}
        onApply={(patch) => { applyIntroOutroChange(patch); setShowIntroOutro(false); }}
        onGenerateAI={() => void handleIntroOutroAI()}
        onVoice={() => void handleVoiceIntroOutro()}
        onClear={handleClearIntroOutro}
        generating={isGeneratingIntro}
        voicing={voicingIntroOutro}
      />

      <VoicesModal
        open={showVoices}
        onClose={() => setShowVoices(false)}
        characters={project.characters}
        assignments={project.voiceAssignments}
        onChange={(a) => updateProject({ voiceAssignments: a })}
        onCharactersChange={(chars) => updateProject({ characters: chars as any })}
        settings={project.settings}
        onSettingsChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
        onPanelsRename={(renameMap) => {
          if (!project) return;
          const newPanels = project.panels.map(p => renameMap[p.character] ? { ...p, character: renameMap[p.character] } : p);
          const newAssignments: Record<string, string> = {};
          for (const [oldName, newName] of Object.entries(renameMap)) {
            if (project.voiceAssignments[oldName] && !newAssignments[newName]) newAssignments[newName] = project.voiceAssignments[oldName];
          }
          const mergedAssignments = { ...project.voiceAssignments, ...newAssignments };
          // Clean old keys that were merged away
          for (const oldName of Object.keys(renameMap)) {
            if (renameMap[oldName] !== oldName) delete (mergedAssignments as any)[oldName];
          }
          updateProject({ panels: newPanels, voiceAssignments: mergedAssignments });
        }}
      />

      <ExportModal
        open={showExport}
        onClose={() => setShowExport(false)}
        onExport={handleExport}
        hasAudio={audioBlobs.size > 0 || !!introAudio}
        hasSRT={!!project.srt}
        srtDraft={srtDraft}
        hasSEO={!!project.seoPackage}
        duration={duration}
        backendCaps={backendCaps}
        preferredBackend={preferredBackend}
        onBackendChange={setPreferredBackend}
        isExporting={isExporting}
        costEstimate={costEstimate}
        onGenerateSEO={handleGenerateSEO}
        generatingSEO={generatingSEO}
        healthReport={healthReport ?? undefined}
        onPreviewAudioMix={handlePreviewAudioMix}
        onDownloadDiagnosticJson={handleDownloadDiagnosticJson}
      />

      {showHealthModal && healthReport && (
        <ProjectHealthModal
          healthReport={healthReport}
          eventLog={project.eventLog ?? []}
          storageBackendLabel={project.useOPFS && opfsActive ? 'OPFS + IDB' : 'IDB fallback'}
          onClose={() => setShowHealthModal(false)}
          onJumpToIssue={handleJumpToHealthIssue}
          onDownloadDiagnosticJson={handleDownloadDiagnosticJson}
          onExportProjectZip={() => void handleExportProjectZip()}
          onImportProjectZip={(file) => void handleImportProjectZip(file)}
        />
      )}
    </div>
  );
}
