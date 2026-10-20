/**
 * Генератор стартового демо-проекта (v1.3.18, Вариант 4 + Onboarding Wizard).
 *
 * Создаёт полностью готовый к открытию в `/editor/<id>` проект:
 * - 1 локальное изображение-заглушка (берётся из `/demo-images/scene-1.jpg` либо встроенный SVG/PNG data URL для офлайн/тестовой среды);
 * - 2 панели (`[0..50%]` и `[50..100%]`) с диалогами, ролями и черновыми длительностями по 2.0 с;
 * - предзаполненный текст сценария (`scenarioText`), описание сцены, `intro` и `outro` (по 1.5 с);
 * - готовый `timeline` (`SyncTimeline[]`), рассчитанный через `buildTimeline`, и синтезированные WAV-блобы (без вызова платного TTS).
 */

import { createProject, saveProject, type PanelData, type Project } from '../storage/db';
import { getSettings } from '../storage/local';
import { saveProjectAudio } from '../storage/opfs';
import { buildTimeline } from './buildTimeline';

export const DEMO_PLACEHOLDER_SVG_DATA_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
      <rect width="800" height="1200" fill="#121217"/>
      <rect x="36" y="36" width="728" height="528" rx="12" fill="#1C1C24" stroke="#E8B44C" stroke-width="4"/>
      <text x="400" y="270" fill="#F5F5F7" font-family="sans-serif" font-size="34" font-weight="bold" text-anchor="middle">ПАНЕЛЬ 1 · АНТАГОНИСТ [0..50%]</text>
      <text x="400" y="330" fill="#8A8A93" font-family="sans-serif" font-size="22" text-anchor="middle">«Ты правда думаешь остановить этот удар?»</text>
      <rect x="36" y="616" width="728" height="548" rx="12" fill="#181820" stroke="#4ADE80" stroke-width="4"/>
      <text x="400" y="870" fill="#F5F5F7" font-family="sans-serif" font-size="34" font-weight="bold" text-anchor="middle">ПАНЕЛЬ 2 · ГЕРОЙ [50..100%]</text>
      <text x="400" y="930" fill="#8A8A93" font-family="sans-serif" font-size="22" text-anchor="middle">«Мне хватит одного мгновения. Смотри внимательно!»</text>
    </svg>`
  );

/** Создаёт короткий валидный 16-bit PCM WAV-блоб (мягкий тон/тишина) для демо-озвучки без реального TTS. */
export function createDemoWavBlob(durationSec = 2.0, freqHz = 220, sampleRate = 22050): Blob {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t / 0.05, (durationSec - t) / 0.05);
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.08 * Math.max(0, env);
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function buildDemoProjectData(dateStr = new Date().toLocaleDateString('ru-RU')) {
  const panels: PanelData[] = [
    {
      id: 0,
      imageIndex: 0,
      order: 0,
      bbox: { x: 0, y: 0, width: 100, height: 50 },
      dialogue: 'Ты действительно думаешь, что сможешь остановить этот удар?',
      character: 'Антагонист',
      emotion: 'angry',
      type: 'speech',
      durationOverride: 2.0,
    },
    {
      id: 1,
      imageIndex: 0,
      order: 1,
      bbox: { x: 0, y: 50, width: 100, height: 50 },
      dialogue: 'Мне достаточно одного мгновения. Смотри внимательно!',
      character: 'Герой',
      emotion: 'excited',
      type: 'speech',
      durationOverride: 2.0,
    },
  ];

  const scenarioText = [
    'Изображение 1 [0..50%]',
    'Антагонист: Ты действительно думаешь, что сможешь остановить этот удар?',
    '',
    'Изображение 1 [50..100%]',
    'Герой: Мне достаточно одного мгновения. Смотри внимательно!',
  ].join('\n');

  const introDuration = 1.5;
  const outroDuration = 1.5;
  const panelGap = 0.2;
  const durations = new Map<number, number>([
    [0, 2.0],
    [1, 2.0],
  ]);
  const voiceAssignments: Record<string, string> = {
    Антагонист: 'demo-voice-1',
    Герой: 'demo-voice-2',
  };
  const timeline = buildTimeline(panels, durations, voiceAssignments, introDuration, panelGap);

  return {
    name: `Демо-проект ${dateStr}`,
    panels,
    scenarioText,
    characters: [
      { name: 'Антагонист', appearance: 'Сильный противник в тёмном плаще', voiceId: 'demo-voice-1', emotion: 'angry' as const },
      { name: 'Герой', appearance: 'Молодой мечник', voiceId: 'demo-voice-2', emotion: 'excited' as const },
    ],
    voiceAssignments,
    audioDurations: { 0: 2.0, 1: 2.0 },
    sceneDescription: 'Кульминационный поединок двух героев на странице манги (демо-шаблон без ключей).',
    intro: 'В этой сцене всё решается за две секунды. Смотрим разбор страницы манги!',
    outro: 'Спасибо за просмотр! Подписывайтесь на канал — продолжение следует.',
    introDuration,
    outroDuration,
    panelGap,
    timeline,
  };
}

export async function createDemoProject(options?: {
  fetchImage?: () => Promise<Blob | null>;
}): Promise<Project> {
  const settings = getSettings();
  const demo = buildDemoProjectData();

  let imageBlob: Blob | null = null;
  if (options?.fetchImage) {
    imageBlob = await options.fetchImage().catch(() => null);
  } else if (typeof fetch === 'function' && typeof window !== 'undefined') {
    try {
      const res = await fetch('/demo-images/scene-1.jpg');
      if (res.ok) {
        imageBlob = await res.blob();
      }
    } catch {}
  }

  const initialFiles = imageBlob ? [imageBlob] : [];
  const project = await createProject(demo.name, initialFiles as any);

  // Сохраняем демо-WAV для двух панелей в OPFS (если OPFS поддерживается), чтобы плеер и экспорт сразу работали со звуком
  try {
    await saveProjectAudio(project.id, 0, createDemoWavBlob(2.0, 220));
    await saveProjectAudio(project.id, 1, createDemoWavBlob(2.0, 330));
  } catch {}

  const updated: Project = {
    ...project,
    images:
      project.images.length > 0 || (project.imageFiles && project.imageFiles.length > 0)
        ? project.images
        : [DEMO_PLACEHOLDER_SVG_DATA_URL],
    useOPFS: project.useOPFS && Boolean(project.imageFiles && project.imageFiles.length > 0),
    panels: demo.panels,
    characters: demo.characters,
    voiceAssignments: demo.voiceAssignments,
    audioDurations: demo.audioDurations,
    sceneDescription: demo.sceneDescription,
    intro: demo.intro,
    outro: demo.outro,
    introDuration: demo.introDuration,
    outroDuration: demo.outroDuration,
    timeline: demo.timeline,
    settings: {
      ttsProvider: settings.defaultTTSProvider || 'gemini',
      llmProvider: settings.defaultLLMProvider || 'openrouter',
      visionModel: settings.defaultVisionModel || 'google/gemma-4-31b-it:free',
      musicVolume: settings.backgroundMusicVolume ?? 0.15,
      panelGap: demo.panelGap,
    },
  };

  await saveProject(updated, { allowStale: true });
  return updated;
}
