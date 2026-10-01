/**
 * Audio generation with OPFS cache, retry, fallback, cost estimation
 * Fixed: singleton AudioContext to avoid leak (Chrome limit ~6 contexts)
 */

import { getTTSProvider, TTS_PROVIDERS } from '../providers/tts';
import { getAllKeys } from '../storage/local';
import { getTTSCacheKey, saveTTSCache, loadTTSCache, saveProjectAudio, loadProjectAudio, saveProjectIntroAudio, saveProjectOutroAudio, loadProjectIntroAudio, loadProjectOutroAudio } from '../storage/opfs';
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

export async function generateAllAudio(options: AudioGenerationOptions): Promise<AudioGenerationResult> {
  const keys = getAllKeys();
  const ttsProvider = getTTSProvider(options.ttsProviderId);
  
  if (!ttsProvider) throw new Error(`TTS provider ${options.ttsProviderId} not found`);
  
  const apiKey = keys[options.ttsProviderId];
  if (!apiKey) throw new Error(`No API key for ${options.ttsProviderId}. Add in settings.`);

  const costEstimate = estimateTotalCost(options.panels, options.intro || '', options.outro || '', options.ttsProviderId);
  options.onCostEstimate?.({ characters: costEstimate.characters, cost: costEstimate.estimatedCost });

  const panelAudios = new Map<number, { blob: Blob; duration: number }>();
  const durations = new Map<number, number>();
  
  let introAudio: Blob | null = null;
  let outroAudio: Blob | null = null;

  // Load persisted project audio first (OPFS project files), then fallback to shared TTS cache
  if (options.intro) {
    introAudio = await loadProjectIntroAudio(options.projectId);
    if (!introAudio) {
      const introKey = await getTTSCacheKey({
        text: options.intro,
        voice: Object.values(options.voiceAssignments)[0] || 'Puck',
        provider: options.ttsProviderId,
        model: options.model,
        language: options.language || 'ru'
      });
      introAudio = await loadTTSCache(introKey);
    }
  }
  if (options.outro) {
    outroAudio = await loadProjectOutroAudio(options.projectId);
    if (!outroAudio) {
      const outroKey = await getTTSCacheKey({
        text: options.outro,
        voice: Object.values(options.voiceAssignments)[0] || 'Puck',
        provider: options.ttsProviderId,
        model: options.model,
        language: options.language || 'ru'
      });
      outroAudio = await loadTTSCache(outroKey);
    }
  }

  const queue = new TaskQueue({
    concurrency: 2,
    retryDelay: 1500,
    maxRetries: 3,
    rateLimit: { maxRequests: 5, perMs: 10000 },
    persistKey: `tts-${options.projectId}`, // Persist progress, OPFS cache makes re-run fast
    onProgress: (completed, total, currentId) => {
      options.onProgress?.(completed, total, currentId);
    }
  });

  const allowFallback = options.allowCrossProviderFallback === true;

  for (const panel of options.panels) {
    const voiceId = options.voiceAssignments[panel.character] || Object.values(options.voiceAssignments)[0] || 'Puck';
    
    queue.add({
      id: `panel-${panel.id}`,
      fn: async () => {
        const persisted = await loadProjectAudio(options.projectId, panel.id);
        if (persisted) {
          const duration = await getAudioDuration(persisted);
          return { blob: persisted, duration };
        }

        const cacheKey = await getTTSCacheKey({
          text: panel.dialogue,
          voice: voiceId,
          provider: options.ttsProviderId,
          model: options.model,
          speed: options.speed,
          language: options.language || 'ru'
        });

        const cached = await loadTTSCache(cacheKey);
        if (cached) {
          const duration = await getAudioDuration(cached);
          await saveProjectAudio(options.projectId, panel.id, cached);
          return { blob: cached, duration };
        }

        const buffer = await ttsProvider.generate(panel.dialogue, {
          apiKey,
          voice: voiceId,
          model: options.model,
          speed: options.speed,
          language: options.language || 'ru'
        });

        const blob = new Blob([buffer], { type: 'audio/mpeg' });
        const duration = await getAudioDuration(blob);

        await saveTTSCache(cacheKey, blob);
        await saveProjectAudio(options.projectId, panel.id, blob);

        return { blob, duration };
      },
      retries: 3,
      ...(allowFallback ? {
        fallbackChain: TTS_PROVIDERS.filter(p => p.id !== options.ttsProviderId).map(fallbackProvider => async () => {
          const fallbackKey = keys[fallbackProvider.id];
          if (!fallbackKey) throw new Error(`No key for fallback ${fallbackProvider.id}`);

          const voices = await fallbackProvider.getVoices(fallbackKey);
          const voice = voices[0]?.id || voiceId;

          const buffer = await fallbackProvider.generate(panel.dialogue, {
            apiKey: fallbackKey,
            voice,
            language: options.language || 'ru'
          });

          const blob = new Blob([buffer], { type: 'audio/mpeg' });
          const duration = await getAudioDuration(blob);

          await saveProjectAudio(options.projectId, panel.id, blob);
          return { blob, duration };
        })
      } : {})
    });
  }

  const results = await queue.run();

  for (const panel of options.panels) {
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
      const voiceId = Object.values(options.voiceAssignments)[0] || 'Puck';
      const buffer = await ttsProvider.generate(options.intro, {
        apiKey,
        voice: voiceId,
        language: options.language || 'ru'
      });
      introAudio = new Blob([buffer], { type: 'audio/mpeg' });
      const cacheKey = await getTTSCacheKey({
        text: options.intro,
        voice: voiceId,
        provider: options.ttsProviderId,
        model: options.model,
        language: options.language || 'ru'
      });
      await saveTTSCache(cacheKey, introAudio);
      await saveProjectIntroAudio(options.projectId, introAudio);
    } catch (e) {
      console.error('Intro generation failed', e);
    }
  }

  if (options.outro && !outroAudio) {
    try {
      const voiceId = Object.values(options.voiceAssignments)[0] || 'Puck';
      const buffer = await ttsProvider.generate(options.outro, {
        apiKey,
        voice: voiceId,
        language: options.language || 'ru'
      });
      outroAudio = new Blob([buffer], { type: 'audio/mpeg' });
      const cacheKey = await getTTSCacheKey({
        text: options.outro,
        voice: voiceId,
        provider: options.ttsProviderId,
        model: options.model,
        language: options.language || 'ru'
      });
      await saveTTSCache(cacheKey, outroAudio);
      await saveProjectOutroAudio(options.projectId, outroAudio);
    } catch (e) {
      console.error('Outro generation failed', e);
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
