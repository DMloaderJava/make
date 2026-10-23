"use client";

import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { appendProjectEvent, saveProject, type Project } from '@/lib/storage/db';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { rebuildSrt, roundMediaDuration } from '@/lib/pipeline/buildTimeline';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { getTTSProvider } from '@/lib/providers/tts/catalog';
import { generateAllAudio } from '@/lib/pipeline/generateAudio';
import { generateSEO, generateFallbackSEO } from '@/lib/pipeline/generateSEO';
import { estimateTotalCost } from '@/lib/validators';
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
import type { AudioImportApplyControls } from '@/components/studio/modals/AudioImportModal';
import type { LLMProvider } from '@/lib/providers/llm/types';
import { getAudioDuration } from '@/lib/editor/audioUtils';
import { confirmAction } from '@/lib/ui/feedback';

type LLMConfig = { provider: LLMProvider; llmId: string; model: string; baseUrl?: string; accountId?: string };

/**
 * Панельная озвучка и импорт аудио (P0-1): генерация TTS, импорт своих файлов,
 * отмена импорта, точечная переозвучка и SEO-пакет.
 */
export function useEditorAudioOps({
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
}: {
  project: Project | null;
  audioBlobs: Map<number, Blob>;
  audioFull: Map<number, { blob: Blob; duration: number }>;
  audioDurations: Map<number, number>;
  panelGap: number;
  duration: number;
  voiceButton: { label: string };
  tl: Project['timeline'];
  lastImportUndo: LastAudioImportSnapshot | null;
  isGeneratingAudio: boolean;
  setGeneratingSEO: Dispatch<SetStateAction<boolean>>;
  updateProject: (updates: Partial<Project>) => void;
  resolveLLMConfig: () => LLMConfig;
  targetPreviousTexts: (excludeIds?: number[]) => Record<number, string> | undefined;
  setAudioBlobs: Dispatch<SetStateAction<Map<number, Blob>>>;
  setAudioFull: Dispatch<SetStateAction<Map<number, { blob: Blob; duration: number }>>>;
  setAudioDurations: Dispatch<SetStateAction<Map<number, number>>>;
  setIntroAudio: Dispatch<SetStateAction<Blob | null>>;
  setIntroAudioDuration: Dispatch<SetStateAction<number | null>>;
  setOutroAudio: Dispatch<SetStateAction<Blob | null>>;
  setOutroAudioDuration: Dispatch<SetStateAction<number | null>>;
  setIsGeneratingAudio: Dispatch<SetStateAction<boolean>>;
  setAudioDone: Dispatch<SetStateAction<number>>;
  setAudioTotal: Dispatch<SetStateAction<number>>;
  setAudioProgress: Dispatch<SetStateAction<string>>;
  setAudioError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setSaveStatus: Dispatch<SetStateAction<'saved' | 'saving' | 'unsaved'>>;
  setLastImportUndo: Dispatch<SetStateAction<LastAudioImportSnapshot | null>>;
}) {
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
    const confirmed = await confirmAction({
      message: `${voiceButton.label}?\nПровайдер: ${providerName} (${ttsId})\nСимволов: ${cost.characters}\nСтоимость: ${cost.estimatedCost}${importedNote}\n\nOPFS кэш — повтор бесплатно. Изменённый текст/голос озвучивается заново.`,
      confirmLabel: 'Озвучить',
    });
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
   * Импорт аудио: applyAudioImport пишет файлы в OPFS по ключам
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
   * (двойной клик по кнопке, не нативный confirm: в iframe-превью он молча false).
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
  return {
    runAudioGeneration,
    handleGenerateAudio,
    handleGenerateSEO,
    existingAudioIds,
    handleImportAudio,
    handleUndoLastAudioImport,
    handleRegeneratePanel,
  };
}
