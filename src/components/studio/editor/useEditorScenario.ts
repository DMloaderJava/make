"use client";

import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { applyScenarioToProject, SCENARIO_GAP_SECONDS, type ScenarioLine } from '@/lib/pipeline/scenario';
import { translateScenarioLines, isTranslatableLanguage } from '@/lib/pipeline/translateScenario';
import { resolveTTSProviderId } from '@/lib/pipeline/projectSettings';
import { getTTSProvider } from '@/lib/providers/tts/catalog';
import { deleteProjectAudio } from '@/lib/storage/opfs';
import type { LLMProvider } from '@/lib/providers/llm/types';

type LLMConfig = { provider: LLMProvider; llmId: string; model: string; baseUrl?: string; accountId?: string };

/**
 * Модалка «Сценарий»: перевод реплик и применение сценария к проекту (P0-1).
 */
export function useEditorScenario({
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
}: {
  project: Project | null;
  images: string[];
  updateProject: (updates: Partial<Project>) => void;
  resolveLLMConfig: () => LLMConfig;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setAudioBlobs: Dispatch<SetStateAction<Map<number, Blob>>>;
  setAudioFull: Dispatch<SetStateAction<Map<number, { blob: Blob; duration: number }>>>;
  setAudioDurations: Dispatch<SetStateAction<Map<number, number>>>;
  setSelectedId: Dispatch<SetStateAction<number | 'intro' | 'outro' | null>>;
  setCurrentPanelIdx: Dispatch<SetStateAction<number>>;
  setShowScenario: Dispatch<SetStateAction<boolean>>;
}) {
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
   *   интро/аутро проекта СОХРАНЯЮТСЯ — это отдельные сущности.
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
  return { handleTranslateScenario, handleApplyScenario };
}
