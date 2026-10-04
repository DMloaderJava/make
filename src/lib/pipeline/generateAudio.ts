/**
 * Audio generation with OPFS cache, retry, fallback, cost estimation
 * Fixed: singleton AudioContext to avoid leak (Chrome limit ~6 contexts)
 *
 * v1.4 fixes:
 * - CORS-провайдеры идут через /api/tts (см. providers/tts/router.ts)
 * - голос по умолчанию берётся у провайдера, а не хардкод 'Puck'
 * - MIME по провайдеру (gemini → wav, а не mp3)
 * - подпись аудио: правка текста/голоса инвалидирует OPFS-аудио панели
 * - onlyPanelIds: точечная переозвучка выбранных панелей
 */

import { getTTSProvider, TTS_PROVIDERS } from '../providers/tts';
import { generateTTS } from '../providers/tts/router';
import { resolveAudioMime } from '../providers/tts/mime';
import { resolveVoice } from '../providers/tts/voice-resolver';
import { getAllKeys } from '../storage/local';
import {
  getTTSCacheKey,
  saveTTSCache,
  loadTTSCache,
  saveProjectAudio,
  saveProjectIntroAudio,
  saveProjectOutroAudio,
  loadProjectIntroAudio,
  loadProjectOutroAudio,
  saveProjectAudioSignature,
  loadFreshProjectAudio,
  hashSHA256,
} from '../storage/opfs';
import { TaskQueue } from './taskQueue';
import { estimateTotalCost } from '../validators';

export interface AudioGenerationOptions {
  projectId: string;
  panels: Array<{ id: number; dialogue: string; character: string }>;
  voiceAssignments: Record<string, string>;
  intro?: string;
  outro?: string;
  ttsProviderId: string;
  model?: string;
  language?: string;
  speed?: number;
  onProgress?: (completed: number, total: number, current: string) => void;
  onCostEstimate?: (estimate: { characters: number; cost: string }) => void;
  allowCrossProviderFallback?: boolean; // default false to avoid unexpected charges
  /** Если задано — переозвучиваются только эти панели, остальное берётся из кэша. */
  onlyPanelIds?: number[];
  /** Перегенерировать intro/outro (по умолчанию они берутся из кэша). */
  regenerateIntroOutro?: boolean;
  /**
   * Игнорировать кэши (OPFS-файл панели и общий TTS-кэш) и синтезировать заново.
   * Нужно кнопке «↻ Переозвучить»: без флага при неизменном тексте она возвращала
   * ровно тот же файл из TTS-кэша, то есть кнопка врала.
   */
  forceRegenerate?: boolean;
  /**
   * Тексты панелей из сохранённого таймлайна (panelId → text).
   * Нужны для мягкой миграции аудио без подписи: если текст совпадает,
   * файл считается актуальным и не перегенерируется.
   */
  previousTexts?: Record<number, string>;
}

export interface AudioGenerationResult {
  panelAudios: Map<number, { blob: Blob; duration: number }>;
  introAudio: Blob | null;
  outroAudio: Blob | null;
  durations: Map<number, number>;
  totalCost: { characters: number; cost: string };
}

// Singleton AudioContext to avoid leak (Chrome limit ~6 contexts)
// Used only for non-concurrent fallback; main duration uses OfflineAudioContext per blob to avoid race
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
    sharedAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return sharedAudioContext;
}

export async function closeSharedAudioContext(): Promise<void> {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    try {
      await sharedAudioContext.close();
    } catch {}
    sharedAudioContext = null;
  }
}

/** Подпись аудио: меняется текст/голос/провайдер/модель/язык → аудио устарело. */
export async function buildAudioSignature(params: {
  text: string;
  voice: string;
  provider: string;
  model?: string;
  speed?: number;
  language?: string;
}): Promise<string> {
  return hashSHA256(
    [params.provider, params.voice, params.model || '', params.speed ?? 1, params.language || '', params.text].join('|')
  );
}

export type CachedAudioSource = 'persisted' | 'tts-cache' | 'generate';

/**
 * Откуда брать аудио панели. Вынесено отдельно, чтобы явное «переозвучить»
 * нельзя было случайно перепутать с обычным прогоном.
 */
export function decideAudioSource(params: {
  forceRegenerate?: boolean;
  hasPersisted: boolean;
  hasCached: boolean;
}): CachedAudioSource {
  if (params.forceRegenerate) return 'generate';
  if (params.hasPersisted) return 'persisted';
  if (params.hasCached) return 'tts-cache';
  return 'generate';
}

/**
 * Актуально ли старое аудио без подписи: сравниваем текст панели с текстом
 * из сохранённого таймлайна (он фиксировался в момент генерации).
 */
export function legacyAudioIsFresh(
  previousTexts: Record<number, string> | undefined,
  panelId: number,
  currentText: string
): boolean {
  // Снимка нет — это «неизвестно», а не «свежо»: так выглядит первый запуск
  // после обновления, в том числе когда текст правили под старой версией.
  // Возвращаем false → файл без .sig не переиспользуется вслепую; запрос уходит
  // в TaskQueue, где первым делом проверяется общий TTS-кэш по тексту/голосу,
  // так что при неизменной реплике генерация не оплачивается повторно.
  if (!previousTexts) return false;
  const prev = previousTexts[panelId];
  // Панели нет в снимке — она появилась после генерации, файл ей не принадлежит.
  if (typeof prev !== 'string') return false;
  return prev === currentText;
}

export async function generateAllAudio(options: AudioGenerationOptions): Promise<AudioGenerationResult> {
  const keys = getAllKeys();
  const ttsProvider = getTTSProvider(options.ttsProviderId);

  if (!ttsProvider) throw new Error(`TTS provider ${options.ttsProviderId} not found`);

  const apiKey = keys[options.ttsProviderId];
  if (!apiKey) throw new Error(`No API key for ${options.ttsProviderId}. Add in settings.`);

  const language = options.language || 'ru';
  // MIME больше не вычисляется заранее: для каждых полученных байтов он
  // определяется по сигнатуре через resolveAudioMime (таблица — лишь фолбэк).

  // Панели, которые реально надо переозвучить
  const targetPanels = options.onlyPanelIds
    ? options.panels.filter(p => options.onlyPanelIds!.includes(p.id))
    : options.panels;

  const costEstimate = estimateTotalCost(targetPanels, options.intro || '', options.outro || '', options.ttsProviderId);
  options.onCostEstimate?.({ characters: costEstimate.characters, cost: costEstimate.estimatedCost });

  const panelAudios = new Map<number, { blob: Blob; duration: number }>();
  const durations = new Map<number, number>();

  let introAudio: Blob | null = null;
  let outroAudio: Blob | null = null;

  // Резолв голоса — один раз на прогон (иначе для 50 панелей будет 50 запросов
  // getVoices() к провайдеру, а это ещё и биллинг у части API).
  const voiceCache = new Map<string, string>();
  const resolveVoiceCached = async (
    providerId: string,
    key: string,
    explicit?: string
  ): Promise<string> => {
    const cacheKey = `${providerId}|${explicit || '__default__'}`;
    const hit = voiceCache.get(cacheKey);
    if (hit) return hit;
    const resolved = await resolveVoice(providerId, key, explicit);
    voiceCache.set(cacheKey, resolved);
    return resolved;
  };

  // Голос по умолчанию — от самого провайдера (не хардкод 'Puck')
  const introVoice = await resolveVoiceCached(
    options.ttsProviderId,
    apiKey,
    Object.values(options.voiceAssignments).find(v => !!v)
  );

  // intro/outro: сначала «свежий» кэш проекта (подпись совпала), потом общий TTS-кэш
  if (options.intro && !options.regenerateIntroOutro) {
    const introSig = await buildAudioSignature({
      text: options.intro,
      voice: introVoice,
      provider: options.ttsProviderId,
      model: options.model,
      language,
    });
    introAudio = await loadFreshProjectAudio(options.projectId, 'intro', introSig);
    if (!introAudio) {
      const introKey = await getTTSCacheKey({
        text: options.intro,
        voice: introVoice,
        provider: options.ttsProviderId,
        model: options.model,
        language,
      });
      introAudio = await loadTTSCache(introKey);
    }
  }
  if (options.outro && !options.regenerateIntroOutro) {
    const outroSig = await buildAudioSignature({
      text: options.outro,
      voice: introVoice,
      provider: options.ttsProviderId,
      model: options.model,
      language,
    });
    outroAudio = await loadFreshProjectAudio(options.projectId, 'outro', outroSig);
    if (!outroAudio) {
      const outroKey = await getTTSCacheKey({
        text: options.outro,
        voice: introVoice,
        provider: options.ttsProviderId,
        model: options.model,
        language,
      });
      outroAudio = await loadTTSCache(outroKey);
    }
  }

  // Прогресс считает ВСЕ шаги прогона: панели (в т.ч. точечно выбранные) плюс
  // интро и аутро. Иначе полоса «доходила» до конца до генерации интро и
  // показывала 1/N при переозвучке одной панели из пятидесяти.
  const introStep = options.intro ? 1 : 0;
  const outroStep = options.outro ? 1 : 0;
  const totalSteps = targetPanels.length + introStep + outroStep;
  let completedSteps = 0;
  const reportProgress = (currentId: string) => {
    options.onProgress?.(completedSteps, totalSteps, currentId);
  };

  const queue = new TaskQueue({
    concurrency: 2,
    retryDelay: 1500,
    maxRetries: 3,
    rateLimit: { maxRequests: 5, perMs: 10000 },
    persistKey: `tts-${options.projectId}`, // Persist progress, OPFS cache makes re-run fast
    onProgress: (completed, _total, currentId) => {
      completedSteps = completed;
      reportProgress(currentId);
    }
  });

  const allowFallback = options.allowCrossProviderFallback === true;

  for (const panel of targetPanels) {
    const explicitVoice = options.voiceAssignments[panel.character];
    queue.add({
      id: `panel-${panel.id}`,
      fn: async () => {
        const voiceId = await resolveVoiceCached(options.ttsProviderId, apiKey, explicitVoice);
        const signature = await buildAudioSignature({
          text: panel.dialogue,
          voice: voiceId,
          provider: options.ttsProviderId,
          model: options.model,
          speed: options.speed,
          language,
        });

        const cacheKey = await getTTSCacheKey({
          text: panel.dialogue,
          voice: voiceId,
          provider: options.ttsProviderId,
          model: options.model,
          speed: options.speed,
          language,
        });

        // 2. Кэши смотрятся только если это не явная переозвучка.
        //    По умолчанию: OPFS-файл панели (подпись совпала) → общий TTS-кэш.
        //    Для аудио без подписи (до v1.3.2) сверяемся с текстом из таймлайна.
        const persisted = options.forceRegenerate
          ? null
          : await loadFreshProjectAudio(
              options.projectId,
              panel.id,
              signature,
              legacyAudioIsFresh(options.previousTexts, panel.id, panel.dialogue)
            );
        let cached: Blob | null = null;
        if (!persisted && !options.forceRegenerate) {
          cached = await loadTTSCache(cacheKey);
        }

        const source = decideAudioSource({
          forceRegenerate: options.forceRegenerate,
          hasPersisted: !!persisted,
          hasCached: !!cached,
        });

        if (source === 'persisted' && persisted) {
          const duration = await getAudioDuration(persisted);
          return { blob: persisted, duration };
        }

        if (source === 'tts-cache' && cached) {
          const duration = await getAudioDuration(cached);
          await saveProjectAudio(options.projectId, panel.id, cached);
          await saveProjectAudioSignature(options.projectId, panel.id, signature);
          return { blob: cached, duration };
        }

        const { buffer } = await generateTTS({
          providerId: options.ttsProviderId,
          text: panel.dialogue,
          apiKey,
          voice: voiceId,
          model: options.model,
          speed: options.speed,
          language,
        });

        const blob = new Blob([buffer], { type: resolveAudioMime(options.ttsProviderId, buffer) });
        const duration = await getAudioDuration(blob);

        await saveTTSCache(cacheKey, blob);
        await saveProjectAudio(options.projectId, panel.id, blob);
        await saveProjectAudioSignature(options.projectId, panel.id, signature);

        return { blob, duration };
      },
      retries: 3,
      ...(allowFallback ? {
        fallbackChain: TTS_PROVIDERS.filter(p => p.id !== options.ttsProviderId).map(fallbackProvider => async () => {
          const fallbackKey = keys[fallbackProvider.id];
          if (!fallbackKey) throw new Error(`No key for fallback ${fallbackProvider.id}`);

          const voice = await resolveVoiceCached(fallbackProvider.id, fallbackKey);

          const { buffer } = await generateTTS({
            providerId: fallbackProvider.id,
            text: panel.dialogue,
            apiKey: fallbackKey,
            voice,
            language,
          });

          const blob = new Blob([buffer], { type: resolveAudioMime(fallbackProvider.id, buffer) });
          const duration = await getAudioDuration(blob);

          await saveProjectAudio(options.projectId, panel.id, blob);
          return { blob, duration };
        })
      } : {})
    });
  }

  const results = await queue.run();

  for (const panel of targetPanels) {
    const result = results.get(`panel-${panel.id}`);
    if (result?.success && result.data) {
      const { blob, duration } = result.data as { blob: Blob; duration: number };
      panelAudios.set(panel.id, { blob, duration });
      durations.set(panel.id, duration);
    } else {
      console.error(`Failed panel ${panel.id}:`, result?.error);
      const estimated = Math.max(1.5, panel.dialogue.length / 14);
      durations.set(panel.id, estimated);
    }
  }

  if (options.intro && !introAudio) {
    try {
      const { buffer } = await generateTTS({
        providerId: options.ttsProviderId,
        text: options.intro,
        apiKey,
        voice: introVoice,
        model: options.model,
        language,
      });
      introAudio = new Blob([buffer], { type: resolveAudioMime(options.ttsProviderId, buffer) });
      const cacheKey = await getTTSCacheKey({
        text: options.intro,
        voice: introVoice,
        provider: options.ttsProviderId,
        model: options.model,
        language,
      });
      await saveTTSCache(cacheKey, introAudio);
      await saveProjectIntroAudio(options.projectId, introAudio);
      await saveProjectAudioSignature(
        options.projectId,
        'intro',
        await buildAudioSignature({
          text: options.intro,
          voice: introVoice,
          provider: options.ttsProviderId,
          model: options.model,
          language,
        })
      );
    } catch (e) {
      console.error('Intro generation failed', e);
    } finally {
      completedSteps = targetPanels.length + introStep;
      reportProgress('intro');
    }
  }

  if (options.outro && !outroAudio) {
    try {
      const { buffer } = await generateTTS({
        providerId: options.ttsProviderId,
        text: options.outro,
        apiKey,
        voice: introVoice,
        model: options.model,
        language,
      });
      outroAudio = new Blob([buffer], { type: resolveAudioMime(options.ttsProviderId, buffer) });
      const cacheKey = await getTTSCacheKey({
        text: options.outro,
        voice: introVoice,
        provider: options.ttsProviderId,
        model: options.model,
        language,
      });
      await saveTTSCache(cacheKey, outroAudio);
      await saveProjectOutroAudio(options.projectId, outroAudio);
      await saveProjectAudioSignature(
        options.projectId,
        'outro',
        await buildAudioSignature({
          text: options.outro,
          voice: introVoice,
          provider: options.ttsProviderId,
          model: options.model,
          language,
        })
      );
    } catch (e) {
      console.error('Outro generation failed', e);
    } finally {
      completedSteps = targetPanels.length + introStep + outroStep;
      reportProgress('outro');
    }
  }

  if (!introAudio) {
    introAudio = await loadProjectIntroAudio(options.projectId);
  }
  if (!outroAudio) {
    outroAudio = await loadProjectOutroAudio(options.projectId);
  }

  return {
    panelAudios,
    introAudio,
    outroAudio,
    durations,
    totalCost: { characters: costEstimate.characters, cost: costEstimate.estimatedCost }
  };
}

async function getAudioDuration(blob: Blob): Promise<number> {
  try {
    const ab = await blob.arrayBuffer();
    // Use OfflineAudioContext per blob to avoid race condition with concurrency:2
    // OfflineAudioContext is isolated, fast, and doesn't count towards real AudioContext limit in same way
    const OfflineCtx = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (OfflineCtx) {
      try {
        // length 1 is enough for decode, we only need duration from decoded buffer
        const offline = new OfflineCtx(1, 1, 22050);
        const decoded = await offline.decodeAudioData(ab.slice(0));
        if (decoded && isFinite(decoded.duration) && decoded.duration > 0) {
          return decoded.duration;
        }
      } catch {
        // fallthrough to shared context
      }
    }
    // Fallback: shared context (with clone)
    const audioContext = getSharedAudioContext();
    const decoded = await audioContext.decodeAudioData(ab.slice(0));
    return decoded.duration;
  } catch {
    // Fallback to <audio> element with proper cleanup
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.remove();
      };
      audio.addEventListener('loadedmetadata', () => {
        const dur = audio.duration;
        cleanup();
        resolve(isFinite(dur) ? dur : 2);
      });
      audio.addEventListener('error', () => {
        cleanup();
        resolve(2);
      });
      setTimeout(() => {
        cleanup();
        resolve(2);
      }, 3000);
    });
  }
}
