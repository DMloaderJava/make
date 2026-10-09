"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { getProjectWithImages, saveProject, Project } from '@/lib/storage/db';
import { Preview } from '@/components/studio/Preview';
import { Timeline } from '@/components/studio/Timeline';
import { ContextPanel } from '@/components/studio/ContextPanel';
import { RenderModePanel, RENDER_DEFAULTS, type RenderSettings } from '@/components/studio/RenderModePanel';
import { VoicesModal } from '@/components/studio/modals/VoicesModal';
import { ExportModal } from '@/components/studio/modals/ExportModal';
import { ScenarioModal } from '@/components/studio/modals/ScenarioModal';
import { IntroOutroModal } from '@/components/studio/modals/IntroOutroModal';
import { Input } from '@/components/ui/input';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { buildTimeline, DEFAULT_PANEL_GAP, estimateDuration, calculateTotalDuration, rebuildSrt } from '@/lib/pipeline/buildTimeline';
import { applyScenarioToProject, serializeScenario, SCENARIO_GAP_SECONDS, type ScenarioLine } from '@/lib/pipeline/scenario';
import { translateScenarioLines, isTranslatableLanguage } from '@/lib/pipeline/translateScenario';
import { generateIntro, generateOutro, generateFallbackIntro, generateFallbackOutro, resolveChannelName } from '@/lib/pipeline/generateIntro';
import { formatSEOPackage, generateSEO, generateFallbackSEO } from '@/lib/pipeline/generateSEO';
import { generateAllAudio } from '@/lib/pipeline/generateAudio';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { getTTSProvider } from '@/lib/providers/tts/catalog';
import { concatenateAudioBlobs } from '@/lib/pipeline/assembleVideo';
import { renderVideo, checkCapabilities, BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import type { AudioPlacement } from '@/lib/pipeline/audioMix';
import { loadProjectAudio, loadProjectIntroAudio, loadProjectOutroAudio, deleteProjectAudio, isOPFSSupported } from '@/lib/storage/opfs';
import { estimateTotalCost } from '@/lib/validators';
import { getVoiceButtonState } from '@/lib/pipeline/voiceButtonState';
import { downloadBlob, formatTime } from '@/lib/utils';
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
  const [selectedId, setSelectedId] = useState<number | 'intro' | 'outro' | null>(null);
  const [showVoices, setShowVoices] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showScenario, setShowScenario] = useState(false);
  const [showIntroOutro, setShowIntroOutro] = useState(false);
  const [voicingIntroOutro, setVoicingIntroOutro] = useState(false);
  const [backendCaps, setBackendCaps] = useState<BackendCapabilities | null>(null);
  const [preferredBackend, setPreferredBackend] = useState<'auto' | 'webcodecs' | 'canvas'>('auto');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');

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
        const settings = getSettings();
        const storedLLMProvider = getLLMProvider(storedProject.settings.llmProvider || settings.defaultLLMProvider)
          || getLLMProvider('openrouter')!;
        const safeVisionModel = resolveLLMVisionModel(
          storedLLMProvider,
          storedProject.settings.visionModel || settings.defaultVisionModel,
        ) || '';
        const loadedProject = safeVisionModel === storedProject.settings.visionModel
          ? storedProject
          : { ...storedProject, settings: { ...storedProject.settings, visionModel: safeVisionModel } };
        const durations = new Map<number, number>();
        const blobs = new Map<number, Blob>();
        const full = new Map<number, { blob: Blob; duration: number }>();

        for (const panel of loadedProject.panels) {
          if (cancelled) return;
          try {
            const blob = await loadProjectAudio(loadedProject.id, panel.id);
            if (blob) {
              const duration = await getAudioDuration(blob);
              durations.set(panel.id, duration);
              blobs.set(panel.id, blob);
              full.set(panel.id, { blob, duration });
            } else {
              durations.set(panel.id, loadedProject.audioDurations?.[panel.id] || estimateDuration(panel.dialogue));
            }
          } catch {
            durations.set(panel.id, loadedProject.audioDurations?.[panel.id] || estimateDuration(panel.dialogue));
          }
        }

        let loadedIntroAudio: Blob | null = null;
        let loadedOutroAudio: Blob | null = null;
        try {
          loadedIntroAudio = await loadProjectIntroAudio(loadedProject.id);
          loadedOutroAudio = await loadProjectOutroAudio(loadedProject.id);
        } catch {}

        if (cancelled) return;
        setProject(loadedProject);
        setImages(urls);
        setAudioDurations(durations);
        setAudioBlobs(blobs);
        setAudioFull(full);
        setIntroAudio(loadedIntroAudio);
        setOutroAudio(loadedOutroAudio);
        setCurrentPanelIdx(0);
        setCurrentTime(0);
        setIsPlaying(false);
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
    void isOPFSSupported().catch(() => {});
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

  // Playback timer.
  // Дельта-тик: каждый кадр прибавляем время с прошлого кадра, а смещение
  // читаем из ref на КАЖДОМ тике. Раньше startOffset захватывался один раз при
  // старте эффекта — и перемотка во время проигрывания (таймлайн, колесо ленты,
  // стрелки) откатывалась на следующем кадре: лента и часы «резали» seek.
  useEffect(() => {
    if (!isPlaying) return;
    if (!duration || duration <= 0 || !isFinite(duration)) {
      setIsPlaying(false);
      return;
    }
    let lastWall = performance.now();
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const dt = (now - lastWall) / 1000;
      lastWall = now;
      const next = currentTimeRef.current + dt;
      if (next >= duration) {
        currentTimeRef.current = duration;
        setCurrentTime(duration);
        setIsPlaying(false);
        return;
      }
      currentTimeRef.current = next;
      setCurrentTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, duration]);

  // Актуальный handleSave для хоткеев: эффект ниже намеренно без deps,
  // поэтому состояние берём из ref. Ref объявлен до эффекта — читать его
  // в рендере-тайме (и в TDZ) больше не приходится.
  const handleSaveRef = useRef<() => Promise<void>>(async () => {});

  // Hotkeys with input guard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (isInput) {
        if (!((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'e'))) return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying(p => !p);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        setCurrentTime(t => Math.max(0, t - 5));
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        setCurrentTime(t => Math.min(duration, t + 5));
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
    // durationRef/currentTimeRef читаются внутри, чтобы не перевешивать
    // слушатель 30 раз в секунду (currentTime меняется на каждом кадре).
  }, [duration]);

  const handleSave = async () => {
    if (!project) return;
    setSaveStatus('saving');
    const obj: Record<number, number> = {};
    audioDurations.forEach((v, k) => obj[k] = v);
    await saveProject({ ...project, audioDurations: obj });
    setSaveStatus('saved');
  };

  // Хоткеи живут в эффекте без deps — держим актуальный handleSave в ref,
  // иначе Ctrl+S сохраняет устаревший снимок проекта.
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  const updateProject = (updates: Partial<Project>) => {
    if (!project) return;
    setProject({ ...project, ...updates, updatedAt: Date.now() });
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
      if (result.introAudio) setIntroAudio(result.introAudio);
      if (result.outroAudio) setOutroAudio(result.outroAudio);
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
      if (result.introAudio) setIntroAudio(result.introAudio);
      if (result.outroAudio) setOutroAudio(result.outroAudio);

      const obj: Record<number, number> = {};
      newDur.forEach((v, k) => obj[k] = v);
      // Финальный SRT: реальные длительности озвучки + интро/аутро проекта.
      const rebuilt = rebuildSrt({
        panels: project.panels,
        audioDurations: newDur,
        voiceAssignments: project.voiceAssignments,
        intro: project.intro,
        outro: project.outro,
        introDuration: project.introDuration,
        outroDuration: project.outroDuration,
        panelGap,
        realDurations: obj,
      });
      const tl = rebuilt.timeline;
      const srt = rebuilt.srt;
      // Обновляем снимок текстов для всех озвученных панелей (включая старые,
      // которые остались в кэше) — это база для следующей мягкой миграции.
      const audioTexts: Record<number, string> = { ...(project.audioTexts || {}) };
      for (const panel of project.panels) audioTexts[panel.id] = panel.dialogue;
      updateProject({ timeline: tl, srt, audioDurations: obj, audioTexts });

      if (result.errors.length > 0) {
        const [firstError, ...otherErrors] = result.errors;
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
    const cost = estimateTotalCost(project.panels, project.intro, project.outro, ttsId);
    const providerName = getTTSProvider(ttsId)?.name || ttsId;
    // Первая строка диалога — та же, что на кнопке: «Озвучить все N панелей»,
    // «Озвучить оставшиеся N» или «Переозвучить всё».
    const confirmed = confirm(
      `${voiceButton.label}?\nПровайдер: ${providerName} (${ttsId})\nСимволов: ${cost.characters}\nСтоимость: ${cost.estimatedCost}\n\nOPFS кэш — повтор бесплатно. Изменённый текст/голос озвучивается заново.`
    );
    if (!confirmed) return;

    try {
      await saveProject(project);
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

  /** Точечная переозвучка одной панели: чистим OPFS-аудио и синтезируем заново. */
  const handleRegeneratePanel = async (panelId: number) => {
    if (!project || isGeneratingAudio) return;
    try {
      const { deleteProjectAudio } = await import('@/lib/storage/opfs');
      await deleteProjectAudio(project.id, panelId);
    } catch {}
    setAudioBlobs(prev => {
      const next = new Map(prev);
      next.delete(panelId);
      return next;
    });
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

        // Точные позиции аудио на таймлайне: интро с 0, панели со своих audioStart,
        // аутро — после последней панели. Это чинит рассинхрон (раньше дорожка
        // склеивалась подряд, без пауз 0.3s между панелями).
        const audioPlacements: AudioPlacement[] = [];
        if (introAudio) audioPlacements.push({ start: 0, blob: introAudio, role: 'intro', label: 'Интро' });
        for (const p of project.panels) {
          const seg = tl.find(t => t.panelId === p.id);
          const b = audioBlobs.get(p.id) || await loadProjectAudio(project.id, p.id);
          if (b && seg) {
            audioPlacements.push({
              start: seg.audioStart,
              blob: b,
              role: 'panel',
              label: `Панель ${p.id}${p.character ? ` · ${p.character}` : ''}`,
            });
          }
        }
        if (outroAudio) {
          const lastEnd = tl.length > 0 ? tl[tl.length - 1].audioEnd : project.introDuration;
          audioPlacements.push({ start: lastEnd, blob: outroAudio, role: 'outro', label: 'Аутро' });
        }

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

  const handleSeek = useCallback((t: number) => {
    if (!isFinite(t)) return;
    setCurrentTime(t);
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
    <div className="flex-1 bg-[#0B0B0C] flex flex-col min-h-0">
      <div className="h-14 px-4 flex items-center justify-between border-b border-[#26262C] bg-[#0B0B0C]/80 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="w-8 h-8 rounded-[6px] bg-[#16161A] border border-[#26262C] flex items-center justify-center hover:bg-[#1E1E23] transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Input value={project.name} onChange={(e) => updateProject({ name: e.target.value })} className="h-8 bg-transparent border-transparent hover:border-[#26262C] focus:border-[#26262C] text-[14px] font-medium px-2 max-w-[240px]" />
          <span className={`text-[11px] font-mono ${saveStatus === 'saved' ? 'text-[#8A8A93]' : saveStatus === 'saving' ? 'text-[#E8B44C]' : 'text-[#F87171]'}`}>
            {saveStatus === 'saved' ? 'сохранено' : saveStatus === 'saving' ? 'сохранение...' : 'не сохранено'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setShowScenario(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Сценарий
          </button>
          <button onClick={() => setShowIntroOutro(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Интро/Аутро
          </button>
          <button onClick={() => setShowVoices(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Голоса
          </button>
          <button onClick={() => setShowExport(true)} className="h-8 px-3 rounded-[6px] bg-[#E8B44C] text-[#0B0B0C] text-xs font-medium hover:bg-[#B88A2E] transition-colors">
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

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[960px] mx-auto p-4 md:p-6 space-y-5">
          <Preview
            images={images}
            panels={project.panels}
            currentPanelIndex={currentPanelIdx}
            timeline={tl}
            currentTime={currentTime}
            duration={duration}
            isPlaying={isPlaying}
            onPlayPause={() => setIsPlaying(p => !p)}
            renderMode={renderSettings.renderMode}
            stripViewport={renderSettings.stripViewport}
            stripGap={renderSettings.stripGap}
            onSeek={handleSeek}
          />

          <RenderModePanel
            {...renderSettings}
            onChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
          />

          <Timeline
            timeline={tl}
            currentTime={currentTime}
            duration={duration}
            onSeek={handleSeek}
            onSelectPanel={(id) => { setSelectedId(id); const idx = project.panels.findIndex(p => p.id === id); if (idx !== -1) setCurrentPanelIdx(idx); }}
            onSelectIntro={() => setSelectedId('intro')}
            onSelectOutro={() => setSelectedId('outro')}
            selectedId={selectedId}
            introDuration={project.introDuration}
            outroDuration={project.outroDuration}
            panelGap={panelGap}
            onGapChange={handleGapChange}
          />

          <ContextPanel
            selected={contextValue as any}
            onUpdatePanel={(id, updates) => {
              const newPanels = project.panels.map(p => p.id === id ? { ...p, ...updates } : p);
              updateProject({ panels: newPanels });
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

          <div className="pt-8 pb-4 flex items-center justify-between text-[11px] font-mono text-[#8A8A93]/60">
            <span>{project.useOPFS ? 'OPFS' : 'IDB'} · {images.length} изобр. · {formatTime(duration)}</span>
            <span className="flex gap-3">
              <span>Space play</span>
              <span>←→ ±5s</span>
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

      <IntroOutroModal
        open={showIntroOutro}
        onClose={() => setShowIntroOutro(false)}
        intro={project.intro}
        outro={project.outro}
        introDuration={project.introDuration}
        outroDuration={project.outroDuration}
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
      />
    </div>
  );
}
