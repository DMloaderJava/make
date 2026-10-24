/**
 * Явные идемпотентные миграции схемы проекта и таймлайна
 * (Этап 1 п. 5, Этап 8 п. 74).
 *
 * Миграция выполняется строго по номерам версий `schemaVersion` и `timelineVersion`
 * (не по косвенным признакам). Повторный вызов на актуальном проекте идемпотентен
 * (`migrated: false`, данные не меняются).
 */

import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  CURRENT_TIMELINE_VERSION,
  Project,
  PanelData,
  appendProjectEvent,
} from './db';
import { DEFAULT_PANEL_GAP, rebuildSrt } from '../pipeline/buildTimeline';

export interface SchemaMigrationResult {
  project: Project;
  migrated: boolean;
  fromSchemaVersion: number;
  toSchemaVersion: number;
  fromTimelineVersion: number;
  toTimelineVersion: number;
  steps: string[];
}

function normalizePanel(panel: Partial<PanelData>, index: number): PanelData {
  const bbox = panel.bbox || { x: 0, y: 0, width: 100, height: 100 };
  const x = Number.isFinite(bbox.x) ? Math.max(0, Math.min(100, bbox.x)) : 0;
  const y = Number.isFinite(bbox.y) ? Math.max(0, Math.min(100, bbox.y)) : 0;
  const width = Number.isFinite(bbox.width) && bbox.width > 0 ? Math.max(0.1, Math.min(100, bbox.width)) : 100;
  const height = Number.isFinite(bbox.height) && bbox.height > 0 ? Math.max(0.1, Math.min(100, bbox.height)) : 100;

  return {
    id: typeof panel.id === 'number' && Number.isFinite(panel.id) ? panel.id : index,
    bbox: { x, y, width, height },
    dialogue: typeof panel.dialogue === 'string' ? panel.dialogue : '',
    character: typeof panel.character === 'string' && panel.character.trim() ? panel.character : 'Рассказчик',
    emotion: typeof panel.emotion === 'string' && panel.emotion ? panel.emotion : 'neutral',
    type:
      panel.type === 'speech' || panel.type === 'thought' || panel.type === 'narration' || panel.type === 'sfx'
        ? panel.type
        : 'speech',
    order: typeof panel.order === 'number' && Number.isFinite(panel.order) ? panel.order : index,
    imageIndex: typeof panel.imageIndex === 'number' && Number.isFinite(panel.imageIndex) && panel.imageIndex >= 0 ? panel.imageIndex : 0,
    ...(panel.fullFrame !== undefined ? { fullFrame: panel.fullFrame } : {}),
    ...(panel.audioSource ? { audioSource: panel.audioSource } : {}),
    ...(panel.audioFileName ? { audioFileName: panel.audioFileName } : {}),
    ...(panel.audioOriginalMime ? { audioOriginalMime: panel.audioOriginalMime } : {}),
    ...(panel.audioNormalizedMime ? { audioNormalizedMime: panel.audioNormalizedMime } : {}),
    ...(panel.audioSha256 ? { audioSha256: panel.audioSha256 } : {}),
    ...(panel.trimIn !== undefined && Number.isFinite(panel.trimIn) && panel.trimIn >= 0 ? { trimIn: panel.trimIn } : {}),
    ...(panel.trimOut !== undefined && Number.isFinite(panel.trimOut) && panel.trimOut >= 0 ? { trimOut: panel.trimOut } : {}),
    ...(panel.durationOverride !== undefined && Number.isFinite(panel.durationOverride) && panel.durationOverride > 0
      ? { durationOverride: panel.durationOverride }
      : {}),
    ...(panel.muted !== undefined ? { muted: Boolean(panel.muted) } : {}),
    ...(panel.solo !== undefined ? { solo: Boolean(panel.solo) } : {}),
    ...(panel.gain !== undefined && Number.isFinite(panel.gain) ? { gain: Math.max(0, Math.min(2, panel.gain)) } : {}),
    ...(panel.fadeIn !== undefined && Number.isFinite(panel.fadeIn) && panel.fadeIn >= 0 ? { fadeIn: panel.fadeIn } : {}),
    ...(panel.fadeOut !== undefined && Number.isFinite(panel.fadeOut) && panel.fadeOut >= 0 ? { fadeOut: panel.fadeOut } : {}),
    ...(panel.splitGroupId ? { splitGroupId: panel.splitGroupId } : {}),
    ...(panel.sourceAudioPanelId !== undefined ? { sourceAudioPanelId: panel.sourceAudioPanelId } : {}),
  };
}

/**
 * Приводит проект любой старой версии к актуальным `CURRENT_PROJECT_SCHEMA_VERSION`
 * и `CURRENT_TIMELINE_VERSION`.
 */
export function migrateProjectSchema(raw: Partial<Project> & { id: string }): SchemaMigrationResult {
  const fromSchemaVersion = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 1;
  const fromTimelineVersion = typeof raw.timelineVersion === 'number' ? raw.timelineVersion : 1;

  if (
    fromSchemaVersion === CURRENT_PROJECT_SCHEMA_VERSION &&
    fromTimelineVersion === CURRENT_TIMELINE_VERSION &&
    Array.isArray(raw.panels) &&
    Array.isArray(raw.timeline) &&
    typeof raw.revision === 'number' &&
    raw.resourceManifest !== undefined &&
    Array.isArray(raw.eventLog)
  ) {
    return {
      project: raw as Project,
      migrated: false,
      fromSchemaVersion,
      toSchemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
      fromTimelineVersion,
      toTimelineVersion: CURRENT_TIMELINE_VERSION,
      steps: [],
    };
  }

  const steps: string[] = [];
  const now = Date.now();
  const panels = Array.isArray(raw.panels) ? raw.panels.map((p, idx) => normalizePanel(p, idx)) : [];

  const audioDurations: Record<number, number> = {};
  if (raw.audioDurations && typeof raw.audioDurations === 'object') {
    for (const [k, v] of Object.entries(raw.audioDurations)) {
      const numId = Number(k);
      const dur = Number(v);
      if (Number.isFinite(numId) && Number.isFinite(dur) && dur > 0) {
        audioDurations[numId] = dur;
      }
    }
  }

  const intro = typeof raw.intro === 'string' ? raw.intro : '';
  const outro = typeof raw.outro === 'string' ? raw.outro : '';
  const introDuration = typeof raw.introDuration === 'number' && Number.isFinite(raw.introDuration) && raw.introDuration >= 0 ? raw.introDuration : 8;
  const outroDuration = typeof raw.outroDuration === 'number' && Number.isFinite(raw.outroDuration) && raw.outroDuration >= 0 ? raw.outroDuration : 5;
  const voiceAssignments = raw.voiceAssignments && typeof raw.voiceAssignments === 'object' ? { ...raw.voiceAssignments } : {};
  // Схема v3: блокировки дорожек живут в проекте (P1-1), а не в useState
  // компонента — иначе после перезагрузки они молча снимались.
  const locks = {
    videoTrackLocked: Boolean(raw.locks?.videoTrackLocked),
    audioTrackLocked: Boolean(raw.locks?.audioTrackLocked),
  };
  const rawSettings: Partial<Project['settings']> = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const panelGap = typeof rawSettings.panelGap === 'number' && Number.isFinite(rawSettings.panelGap) && rawSettings.panelGap >= 0
    ? rawSettings.panelGap
    : DEFAULT_PANEL_GAP;

  if (fromSchemaVersion < CURRENT_PROJECT_SCHEMA_VERSION) {
    steps.push(`schema:${fromSchemaVersion}->${CURRENT_PROJECT_SCHEMA_VERSION}`);
  }

  let timeline = Array.isArray(raw.timeline) ? [...raw.timeline] : [];
  let srt = typeof raw.srt === 'string' ? raw.srt : '';

  if (fromTimelineVersion < CURRENT_TIMELINE_VERSION || timeline.length !== panels.length) {
    // Явная миграция таймлайна: пересобираем по каноничной формуле из панелей и длительностей
    const rebuilt = rebuildSrt({
      panels,
      audioDurations,
      voiceAssignments,
      intro,
      outro,
      introDuration,
      outroDuration,
      panelGap,
      realDurations: audioDurations,
    });
    timeline = rebuilt.timeline;
    srt = rebuilt.srt;
    steps.push(`timeline:${fromTimelineVersion}->${CURRENT_TIMELINE_VERSION}`);
  }

  const settings: Project['settings'] = {
    ttsProvider: rawSettings.ttsProvider || 'gemini',
    llmProvider: rawSettings.llmProvider || 'openrouter',
    visionModel: rawSettings.visionModel || 'google/gemma-4-31b-it:free',
    musicVolume: typeof rawSettings.musicVolume === 'number' ? rawSettings.musicVolume : 0.15,
    ...(rawSettings.ttsModel ? { ttsModel: rawSettings.ttsModel } : {}),
    ...(rawSettings.chatModel ? { chatModel: rawSettings.chatModel } : {}),
    ...(rawSettings.ttsLanguage ? { ttsLanguage: rawSettings.ttsLanguage } : {}),
    ...(typeof rawSettings.ttsSpeed === 'number' ? { ttsSpeed: rawSettings.ttsSpeed } : {}),
    ...(rawSettings.renderMode ? { renderMode: rawSettings.renderMode } : {}),
    ...(typeof rawSettings.stripViewport === 'number' ? { stripViewport: rawSettings.stripViewport } : {}),
    ...(typeof rawSettings.stripGap === 'number' ? { stripGap: rawSettings.stripGap } : {}),
    ...(typeof rawSettings.panelGap === 'number' ? { panelGap: rawSettings.panelGap } : {}),
    ...(rawSettings.videoTrackLocked !== undefined ? { videoTrackLocked: Boolean(rawSettings.videoTrackLocked) } : {}),
    ...(rawSettings.audioTrackLocked !== undefined ? { audioTrackLocked: Boolean(rawSettings.audioTrackLocked) } : {}),
    ...(rawSettings.debugOverlay !== undefined ? { debugOverlay: Boolean(rawSettings.debugOverlay) } : {}),
    ...(rawSettings.channelName ? { channelName: rawSettings.channelName } : {}),
    ...(rawSettings.channelTagline ? { channelTagline: rawSettings.channelTagline } : {}),
    ...(rawSettings.backgroundMusic ? { backgroundMusic: rawSettings.backgroundMusic } : {}),
  };

  let eventLog = Array.isArray(raw.eventLog) ? [...raw.eventLog] : [];
  if (steps.length > 0) {
    eventLog = appendProjectEvent(eventLog, {
      type: 'migration',
      summary: `Миграция проекта (${steps.join(', ')})`,
      timestamp: now,
    });
  }

  const migratedProject: Project = {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Без названия',
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    locks,
    timelineVersion: CURRENT_TIMELINE_VERSION,
    revision: typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 1,
    images: Array.isArray(raw.images) ? [...raw.images] : [],
    ...(Array.isArray(raw.imageFiles) ? { imageFiles: [...raw.imageFiles] } : {}),
    ...(raw.useOPFS !== undefined ? { useOPFS: Boolean(raw.useOPFS) } : {}),
    panels,
    characters: Array.isArray(raw.characters) ? [...raw.characters] : [],
    voiceAssignments,
    timeline,
    intro,
    outro,
    introDuration,
    outroDuration,
    audioDurations,
    ...(raw.audioTexts ? { audioTexts: { ...raw.audioTexts } } : {}),
    resourceManifest: raw.resourceManifest ? { ...raw.resourceManifest } : {},
    lastAudioImportUndo: raw.lastAudioImportUndo ?? null,
    eventLog,
    srt,
    seoPackage: raw.seoPackage ?? null,
    settings,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
    ...(raw.sceneDescription ? { sceneDescription: raw.sceneDescription } : {}),
    ...(raw.taskProgress ? { taskProgress: { ...raw.taskProgress } } : {}),
  };

  return {
    project: migratedProject,
    migrated: true,
    fromSchemaVersion,
    toSchemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    fromTimelineVersion,
    toTimelineVersion: CURRENT_TIMELINE_VERSION,
    steps,
  };
}
