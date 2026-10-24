"use client";

import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import { checkCapabilities, type BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import { getProjectWithImages } from '@/lib/storage/db';
import { migrateProjectSchema } from '@/lib/storage/schemaMigration';
import { recoverInterruptedImport } from '@/lib/storage/resourceIntegrity';
import { getAllKeys, getSettings } from '@/lib/storage/local';
import { getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { roundMediaDuration } from '@/lib/pipeline/buildTimeline';
import { loadPanelAudios } from '@/lib/pipeline/loadPanelAudio';
import { loadProjectIntroAudio, loadProjectOutroAudio, isOPFSSupported } from '@/lib/storage/opfs';
import { getAudioDuration } from '@/lib/editor/audioUtils';
import type { ProjectClock } from '@/lib/pipeline/projectClock';

/**
 * Загрузка проекта (P0-1): IndexedDB + OPFS + миграция схемы.
 *
 * Вынесено из контроллера редактора: это единственное место, где читаются
 * проект, изображения и аудио, поэтому «загрузка» и «редактирование» больше
 * не перемешаны в одном хуке.
 */
export function useEditorProjectLoader({
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
}: {
  id: string;
  clockRef: { current: ProjectClock };
  setProject: Dispatch<SetStateAction<Project | null>>;
  setImages: Dispatch<SetStateAction<string[]>>;
  setCurrentPanelIdx: Dispatch<SetStateAction<number>>;
  setSelectedId: Dispatch<SetStateAction<number | 'intro' | 'outro' | null>>;
  setAudioDurations: Dispatch<SetStateAction<Map<number, number>>>;
  setAudioBlobs: Dispatch<SetStateAction<Map<number, Blob>>>;
  setAudioFull: Dispatch<SetStateAction<Map<number, { blob: Blob; duration: number }>>>;
  setIntroAudio: Dispatch<SetStateAction<Blob | null>>;
  setOutroAudio: Dispatch<SetStateAction<Blob | null>>;
  setIntroAudioDuration: Dispatch<SetStateAction<number | null>>;
  setOutroAudioDuration: Dispatch<SetStateAction<number | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setShowScenario: Dispatch<SetStateAction<boolean>>;
  setAudioProgress: Dispatch<SetStateAction<string>>;
  setOpfsActive: Dispatch<SetStateAction<boolean>>;
  setBackendCaps: Dispatch<SetStateAction<BackendCapabilities | null>>;
}) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadResult, setLoadResult] = useState<{ id: string; attempt: number; error?: string } | null>(null);
  const isProjectLoading = !loadResult || loadResult.id !== id || loadResult.attempt !== loadAttempt;
  const projectLoadError = isProjectLoading ? null : loadResult.error ?? null;

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

  return {
    isProjectLoading,
    projectLoadError,
    reloadProject: () => setLoadAttempt((attempt) => attempt + 1),
  };
}
