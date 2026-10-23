"use client";

import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { generateIntro, generateOutro, generateFallbackIntro, generateFallbackOutro, resolveChannelName } from '@/lib/pipeline/generateIntro';
import { generateAllAudio } from '@/lib/pipeline/generateAudio';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { roundMediaDuration } from '@/lib/pipeline/buildTimeline';
import { deleteProjectAudio, saveProjectIntroAudio, saveProjectOutroAudio } from '@/lib/storage/opfs';
import { getAudioDuration, getImportedAudioDuration } from '@/lib/editor/audioUtils';

type IntroOutroPatch = { intro?: string; outro?: string; introDuration?: number; outroDuration?: number };

/**
 * Тексты и озвучка интро/аутро (P0-1).
 *
 * Здесь только модалка «Интро/Аутро»: LLM-генерация текста, TTS, импорт своих
 * файлов и очистка. Панельная озвучка живёт в useEditorAudioOps.
 */
export function useEditorDialogue({
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
}: {
  project: Project | null;
  applyIntroOutroChange: (patch: IntroOutroPatch) => void;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setAudioError: Dispatch<SetStateAction<string | null>>;
  setAudioProgress: Dispatch<SetStateAction<string>>;
  setIsGeneratingIntro: Dispatch<SetStateAction<boolean>>;
  setVoicingIntroOutro: Dispatch<SetStateAction<boolean>>;
  setIntroAudio: Dispatch<SetStateAction<Blob | null>>;
  setIntroAudioDuration: Dispatch<SetStateAction<number | null>>;
  setOutroAudio: Dispatch<SetStateAction<Blob | null>>;
  setOutroAudioDuration: Dispatch<SetStateAction<number | null>>;
}) {
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
  return {
    resolveLLMConfig,
    resolveChannel,
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
  };
}
