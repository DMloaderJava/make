"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import { getProjectWithImages, saveProject, Project } from '@/lib/storage/db';
import { Preview } from '@/components/studio/Preview';
import { Timeline } from '@/components/studio/Timeline';
import { ContextPanel } from '@/components/studio/ContextPanel';
import { VoicesModal } from '@/components/studio/modals/VoicesModal';
import { ExportModal } from '@/components/studio/modals/ExportModal';
import { Input } from '@/components/ui/input';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider } from '@/lib/providers/llm';
import { buildTimeline, estimateDuration, generateSRT, calculateTotalDuration } from '@/lib/pipeline/buildTimeline';
import { generateIntro, generateOutro, generateFallbackIntro, generateFallbackOutro } from '@/lib/pipeline/generateIntro';
import { formatSEOPackage, generateSEO, generateFallbackSEO } from '@/lib/pipeline/generateSEO';
import { generateAllAudio } from '@/lib/pipeline/generateAudio';
import { concatenateAudioBlobs } from '@/lib/pipeline/assembleVideo';
import { renderVideo, checkCapabilities, BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import { loadProjectAudio, loadProjectIntroAudio, loadProjectOutroAudio, isOPFSSupported } from '@/lib/storage/opfs';
import { estimateTotalCost } from '@/lib/validators';
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
  const [audioDone, setAudioDone] = useState(0);
  // Число панелей в текущем прогоне: при точечной переозвучке это НЕ project.panels.length,
  // иначе полоса показывала 2% вместо 20%.
  const [audioTotal, setAudioTotal] = useState(0);
  const [costEstimate, setCostEstimate] = useState<{ characters: number; cost: string } | null>(null);
  const [isGeneratingIntro, setIsGeneratingIntro] = useState(false);
  const [generatingSEO, setGeneratingSEO] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<number | 'intro' | 'outro' | null>(null);
  const [showVoices, setShowVoices] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [backendCaps, setBackendCaps] = useState<BackendCapabilities | null>(null);
  const [preferredBackend, setPreferredBackend] = useState<'auto' | 'webcodecs' | 'canvas'>('auto');
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved');

  const duration = useMemo(() => {
    if (!project) return 0;
    const timeline = buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, project.outroDuration);
    return calculateTotalDuration(timeline, project.introDuration, project.outroDuration);
  }, [project, audioDurations]);

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

        const { project: loadedProject, imageDataUrls: urls } = result;
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

        const cost = estimateTotalCost(loadedProject.panels, loadedProject.intro, loadedProject.outro, loadedProject.settings.ttsProvider);
        setCostEstimate({ characters: cost.characters, cost: cost.estimatedCost });

        if (loadedProject.panels.length > 0) {
          setSelectedId(loadedProject.panels[0].id);
        } else {
          setSelectedId('intro');
        }
        setLoadResult({ id, attempt });
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
  ]);

  // Playback timer.
  // Раньше startTime брался из замыкания при старте эффекта, поэтому перемотка
  // во время проигрывания тут же откатывалась назад. Теперь смещение читается
  // из ref, а тик идёт через requestAnimationFrame.
  useEffect(() => {
    if (!isPlaying) return;
    if (!duration || duration <= 0 || !isFinite(duration)) {
      setIsPlaying(false);
      return;
    }
    const startWall = performance.now();
    const startOffset = currentTimeRef.current;
    let raf = 0;
    const tick = () => {
      const next = startOffset + (performance.now() - startWall) / 1000;
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
    const llmId = project?.settings.llmProvider || settings.defaultLLMProvider || 'openrouter';
    const provider = getLLMProvider(llmId);
    const customRaw = typeof window !== 'undefined' ? (localStorage.getItem('mvs-info:custom-llm-config') || localStorage.getItem('custom-llm-config')) : null;
    let baseUrl: string | undefined;
    let model = project?.settings.visionModel || provider?.defaultModel || '';
    if (customRaw) {
      try {
        const cfg = JSON.parse(customRaw);
        if (llmId === 'custom' || llmId === 'cloudflare') {
          baseUrl = cfg.baseUrl || baseUrl;
          model = cfg.model || model;
        }
        if (llmId === 'custom' && cfg.baseUrl) baseUrl = cfg.baseUrl;
      } catch {}
    }
    return { provider, llmId, baseUrl, model, settings };
  };

  const handleGenerateIntro = async () => {
    if (!project) return;
    const keys = getAllKeys();
    const { provider, llmId, baseUrl, model } = resolveLLMConfig();
    const apiKey = keys[llmId] || keys[provider?.id || ''];
    if (!provider || !apiKey) {
      updateProject({ intro: generateFallbackIntro(project.sceneDescription || '') });
      return;
    }
    setIsGeneratingIntro(true);
    try {
      const text = await generateIntro(project.sceneDescription || project.panels.map(p => p.dialogue).join(' '), project.characters.map(c => c.name), provider, { apiKey, model, baseUrl, temperature: 0.8 });
      updateProject({ intro: text });
    } catch {
      updateProject({ intro: generateFallbackIntro(project.sceneDescription || '') });
    } finally {
      setIsGeneratingIntro(false);
    }
  };

  const handleGenerateOutro = async () => {
    if (!project) return;
    const keys = getAllKeys();
    const { provider, llmId, baseUrl, model, settings } = resolveLLMConfig();
    const apiKey = keys[llmId] || keys[provider?.id || ''];
    if (!provider || !apiKey) {
      updateProject({ outro: generateFallbackOutro(settings.siteName) });
      return;
    }
    setIsGeneratingIntro(true);
    try {
      const text = await generateOutro(settings.siteName, settings.ctaType, provider, { apiKey, model, baseUrl });
      updateProject({ outro: text });
    } catch {
      updateProject({ outro: generateFallbackOutro(settings.siteName) });
    } finally {
      setIsGeneratingIntro(false);
    }
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
  const runAudioGeneration = async (onlyPanelIds?: number[]) => {
    if (!project) return;
    const ttsId = project.settings.ttsProvider || getSettings().defaultTTSProvider;
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

      const tl = buildTimeline(project.panels, newDur, project.voiceAssignments, project.introDuration, project.outroDuration);
      const srt = generateSRT(tl, project.intro, project.outro, project.introDuration, project.outroDuration);
      const obj: Record<number, number> = {};
      newDur.forEach((v, k) => obj[k] = v);
      // Обновляем снимок текстов для всех озвученных панелей (включая старые,
      // которые остались в кэше) — это база для следующей мягкой миграции.
      const audioTexts: Record<number, string> = { ...(project.audioTexts || {}) };
      for (const panel of project.panels) audioTexts[panel.id] = panel.dialogue;
      updateProject({ timeline: tl, srt, audioDurations: obj, audioTexts });

      setAudioProgress('Готово! Сохранено в OPFS.');
      setTimeout(() => setAudioProgress(''), 3000);
    } catch (e: any) {
      alert(`Ошибка озвучки: ${e.message}`);
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  const handleGenerateAudio = async () => {
    if (!project) return;
    const ttsId = project.settings.ttsProvider || getSettings().defaultTTSProvider;
    const cost = estimateTotalCost(project.panels, project.intro, project.outro, ttsId);
    const confirmed = confirm(`Озвучить ${project.panels.length} панелей?\nСимволов: ${cost.characters}\nСтоимость: ${cost.estimatedCost}\n\nOPFS кэш — повтор бесплатно. Изменённый текст/голос озвучивается заново.`);
    if (!confirmed) return;
    setCostEstimate({ characters: cost.characters, cost: cost.estimatedCost });
    await runAudioGeneration();
  };

  /**
   * Генерация SEO-пакета (раньше кнопки не было вообще, а generateSEO нигде не вызывался).
   * Если LLM недоступна — кладём шаблонный фолбэк, чтобы экспорт не был пустым.
   */
  const handleGenerateSEO = async () => {
    if (!project) return;
    const { provider, llmId, baseUrl, model } = resolveLLMConfig();
    const keys = getAllKeys();
    const apiKey = keys[llmId] || (provider ? keys[provider.id] : '');
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
    await runAudioGeneration([panelId]);
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
        const tl = project.timeline.length > 0 ? project.timeline : buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, project.outroDuration);

        // Точные позиции аудио на таймлайне: интро с 0, панели со своих audioStart,
        // аутро — после последней панели. Это чинит рассинхрон (раньше дорожка
        // склеивалась подряд, без пауз 0.3s между панелями).
        const audioPlacements: Array<{ start: number; blob: Blob }> = [];
        if (introAudio) audioPlacements.push({ start: 0, blob: introAudio });
        for (const p of project.panels) {
          const seg = tl.find(t => t.panelId === p.id);
          const b = audioBlobs.get(p.id) || await loadProjectAudio(project.id, p.id);
          if (b && seg) audioPlacements.push({ start: seg.audioStart, blob: b });
        }
        if (outroAudio) {
          const lastEnd = tl.length > 0 ? tl[tl.length - 1].audioEnd : project.introDuration;
          audioPlacements.push({ start: lastEnd, blob: outroAudio });
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
  const tl = useMemo(() => {
    if (!project) return [];
    return project.timeline.length > 0 ? project.timeline : buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, project.outroDuration);
  }, [project, audioDurations]);

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
            onSeek={handleSeek}
          />

          <Timeline
            panels={project.panels}
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
          />

          <ContextPanel
            selected={contextValue as any}
            onUpdatePanel={(id, updates) => {
              const newPanels = project.panels.map(p => p.id === id ? { ...p, ...updates } : p);
              updateProject({ panels: newPanels });
            }}
            onUpdateIntro={(text, dur) => updateProject({ intro: text, introDuration: dur })}
            onUpdateOutro={(text, dur) => updateProject({ outro: text, outroDuration: dur })}
            voiceAssignments={project.voiceAssignments}
            onVoiceChange={(char, voiceId) => updateProject({ voiceAssignments: { ...project.voiceAssignments, [char]: voiceId } })}
            onGenerateIntro={handleGenerateIntro}
            onGenerateOutro={handleGenerateOutro}
            generating={isGeneratingIntro}
            onRegeneratePanel={handleRegeneratePanel}
            regenerating={isGeneratingAudio}
          />

          <div className="pt-2">
            <button
              onClick={handleGenerateAudio}
              disabled={isGeneratingAudio}
              className="w-full h-11 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[14px] hover:bg-[#B88A2E] transition-colors duration-[150ms] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isGeneratingAudio ? <><Loader2 className="w-4 h-4 animate-spin" /> {audioProgress}</> : 'Озвучить всё'}
            </button>
            {costEstimate && !isGeneratingAudio && (
              <p className="text-center font-mono text-[11px] text-[#8A8A93] mt-2">{costEstimate.characters} симв. · {costEstimate.cost} · OPFS кэш — повтор бесплатно</p>
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
