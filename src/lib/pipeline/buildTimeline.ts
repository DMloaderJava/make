import { PanelData } from './extractPanels';
import {
  CURRENT_PROJECT_SCHEMA_VERSION,
  CURRENT_TIMELINE_VERSION,
  Project,
  SyncTimeline,
} from '../storage/db';

export interface AudioSegment {
  panelId: number;
  duration: number; // seconds
  blob?: Blob;
  base64?: string;
}

/** Пауза по умолчанию между репликами, сек (сценарий задаёт 0,6 — см. SCENARIO_GAP_SECONDS). */
export const DEFAULT_PANEL_GAP = 0.3;

/** Режим сборки таймлайна (Этап 1 п. 2):
 *  - 'draft' — разрешает оценочную длительность по тексту ТОЛЬКО для панелей, у которых ещё нет реального аудио;
 *  - 'real' — требует реальную длительность (или durationOverride) для каждой панели.
 */
export type TimelineBuildMode = 'draft' | 'real';

export interface BuildTimelineOptions {
  mode?: TimelineBuildMode;
  /** Реальные длительности аудиофайлов (имеют безусловный приоритет над оценкой). */
  realDurations?: ReadonlyMap<number, number> | Record<number, number>;
}

function lookupDuration(
  source: ReadonlyMap<number, number> | Record<number, number> | undefined,
  panelId: number
): number | undefined {
  if (!source) return undefined;
  if (source instanceof Map || typeof (source as ReadonlyMap<number, number>).get === 'function') {
    return (source as ReadonlyMap<number, number>).get(panelId);
  }
  return (source as Record<number, number>)[panelId];
}

/**
 * Вычисляет эффективную длительность панели (Этап 1 п. 2, 4 + Этап 6 п. 52, 54):
 * 1. Если задан `panel.durationOverride > 0` — используется он.
 * 2. Если есть реальная длительность аудио (`realDurations` или `audioDurations`) —
 *    ВСЕГДА используется она (с вычетом `trimIn` и `trimOut`), оценка по тексту запрещена.
 * 3. Если реального файла нет:
 *    - в режиме `mode === 'real'` бросает ошибку;
 *    - в режиме `mode === 'draft'` возвращает `estimateDuration(panel.dialogue)` с `isEstimated: true`.
 */
export function resolvePanelEffectiveDuration(
  panel: PanelData,
  audioDurations?: ReadonlyMap<number, number> | Record<number, number>,
  options: BuildTimelineOptions = {}
): { duration: number; rawDuration: number; isEstimated: boolean } {
  const trimIn = Math.max(0, Number.isFinite(panel.trimIn) ? Number(panel.trimIn) : 0);
  const trimOut = Math.max(0, Number.isFinite(panel.trimOut) ? Number(panel.trimOut) : 0);

  if (
    panel.durationOverride !== undefined &&
    Number.isFinite(panel.durationOverride) &&
    panel.durationOverride > 0
  ) {
    const d = Math.max(0.1, panel.durationOverride);
    return { duration: d, rawDuration: d, isEstimated: false };
  }

  const audioKey = panel.sourceAudioPanelId ?? panel.id;
  const fromReal =
    lookupDuration(options.realDurations, panel.id) ??
    lookupDuration(options.realDurations, audioKey);
  const fromMap =
    lookupDuration(audioDurations, panel.id) ??
    lookupDuration(audioDurations, audioKey);

  // Реальная длительность всегда приоритетнее оценочной (Задача 4: без мёртвой ветки).
  // Приоритет: durationOverride > realDurations > audioDurations (как fallback значения, но isEstimated: true) > estimateDuration.
  const hasReal =
    (fromReal !== undefined && Number.isFinite(fromReal) && fromReal > 0) ||
    (options.realDurations === undefined &&
      options.mode === 'real' &&
      fromMap !== undefined &&
      Number.isFinite(fromMap) &&
      fromMap > 0);

  if (hasReal) {
    const raw = (fromReal !== undefined && Number.isFinite(fromReal) && fromReal > 0 ? fromReal : fromMap)!;
    const effective = Math.max(0.05, raw - trimIn - trimOut);
    return { duration: effective, rawDuration: raw, isEstimated: false };
  }

  if (options.mode === 'real') {
    throw new Error(
      `Панель ${panel.id}: отсутствует реальная длительность аудио (режим 'real' запрещает текстовую оценку)`
    );
  }

  const fallbackRaw =
    fromMap !== undefined && Number.isFinite(fromMap) && fromMap > 0
      ? fromMap
      : estimateDuration(panel.dialogue);
  const effective = Math.max(0.05, fallbackRaw - trimIn - trimOut);
  return { duration: effective, rawDuration: fallbackRaw, isEstimated: true };
}

export function buildTimeline(
  panels: PanelData[],
  audioDurations: ReadonlyMap<number, number> | Record<number, number>, // panelId -> duration
  voiceAssignments: Record<string, string>,
  introDuration: number = 8,
  /** Пауза между репликами, сек: после завершения чтения — переход к следующему изображению. */
  panelGap: number = DEFAULT_PANEL_GAP,
  options: BuildTimelineOptions = {}
): SyncTimeline[] {
  const timeline: SyncTimeline[] = [];
  const safeIntro = Number.isFinite(introDuration) && introDuration >= 0 ? introDuration : 0;
  let currentTime = safeIntro;
  const gap = Number.isFinite(panelGap) && panelGap >= 0 ? panelGap : DEFAULT_PANEL_GAP;

  // Sort panels by order, then id for deterministic ordering
  const sorted = [...panels].sort((a, b) => (a.order - b.order) || (a.id - b.id));

  for (const panel of sorted) {
    const { duration } = resolvePanelEffectiveDuration(panel, audioDurations, options);
    const voiceId = voiceAssignments[panel.character] || 'default';

    const seg: SyncTimeline = {
      panelId: panel.id,
      imageIndex: panel.imageIndex,
      audioStart: currentTime,
      audioEnd: currentTime + duration,
      panelBbox: { ...panel.bbox },
      voiceId,
      text: panel.dialogue,
      character: panel.character,
      ...(panel.audioSource ? { audioSource: panel.audioSource } : {}),
      ...(panel.trimIn !== undefined ? { trimIn: panel.trimIn } : {}),
      ...(panel.trimOut !== undefined ? { trimOut: panel.trimOut } : {}),
      ...(panel.muted !== undefined ? { muted: panel.muted } : {}),
      ...(panel.solo !== undefined ? { solo: panel.solo } : {}),
      ...(panel.gain !== undefined ? { gain: panel.gain } : {}),
      ...(panel.fadeIn !== undefined ? { fadeIn: panel.fadeIn } : {}),
      ...(panel.fadeOut !== undefined ? { fadeOut: panel.fadeOut } : {}),
    };

    timeline.push(seg);

    currentTime += duration + gap; // пауза между репликами перед следующим изображением
  }

  return timeline;
}

/**
 * ЕДИНАЯ точка сборки таймлайна + SRT. Все места, где SRT «вручную» строился
 * (сценарий, смена паузы, озвучка, интро/аутро), вызывают отсюда:
 * — длительности = реальные (realDurations / audioDurations), если есть, иначе оценка;
 * — интро/аутро и их длительности передаются как есть (SRT сдвигается на
 *   introDuration, аутро — после последней панели);
 * — draft = true, пока хотя бы у одной панели нет РЕАЛЬНОЙ длительности
 *   (озвучка ещё не сгенерирована) — SRT «черновой», не влияет на экспорт.
 */
export interface RebuildSrtInput {
  panels: PanelData[];
  /** panelId → длительность (реальная или оценочная). */
  audioDurations: ReadonlyMap<number, number> | Record<number, number>;
  voiceAssignments: Record<string, string>;
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  panelGap: number;
  /** Реальные (сохранённые) длительности — имеют приоритет над оценочными и определяют флаг черновика. */
  realDurations?: Record<number, number>;
  mode?: TimelineBuildMode;
}

export interface RebuildSrtResult {
  timeline: SyncTimeline[];
  srt: string;
  draft: boolean;
  totalDuration: number;
}

export function rebuildSrt(input: RebuildSrtInput): RebuildSrtResult {
  const real = input.realDurations;
  const durationMap = new Map<number, number>();
  for (const p of input.panels) {
    const audioKey = p.sourceAudioPanelId ?? p.id;
    const realDur = real?.[p.id] ?? real?.[audioKey];
    const mapDur = lookupDuration(input.audioDurations, p.id) ?? lookupDuration(input.audioDurations, audioKey);
    // Реальная длительность всегда приоритетнее оценочной (Этап 1 п. 4)
    if (realDur !== undefined && Number.isFinite(realDur) && realDur > 0) {
      durationMap.set(p.id, realDur);
    } else if (mapDur !== undefined && Number.isFinite(mapDur) && mapDur > 0) {
      durationMap.set(p.id, mapDur);
    } else {
      durationMap.set(p.id, estimateDuration(p.dialogue));
    }
  }
  const timeline = buildTimeline(
    input.panels,
    durationMap,
    input.voiceAssignments,
    input.introDuration,
    input.panelGap,
    { mode: input.mode, realDurations: real }
  );
  const srt = generateSRT(timeline, input.intro, input.outro, input.introDuration, input.outroDuration);
  const realRecord = real ?? {};
  const draft = input.panels.length > 0 && input.panels.some(p => {
    const key = p.sourceAudioPanelId ?? p.id;
    return realRecord[p.id] === undefined && realRecord[key] === undefined && p.durationOverride === undefined;
  });
  const totalDuration = calculateTotalDuration(timeline, input.introDuration, input.outroDuration);
  return { timeline, srt, draft, totalDuration };
}

/**
 * Округляет реальную длительность аудио интро/аутро до 0.01 с (Задача 12).
 */
export function roundMediaDuration(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds * 100) / 100;
}

/**
 * Принудительная пересборка таймлайна и SRT проекта со сбросом устаревшего timeline
 * (Этап 1 п. 3, 9; Итерация 2 Задачи 2, 12): вызывается при любом изменении порядка панелей,
 * изображения, bbox, длительностей аудио или паузы. Монотонно инкрементирует timelineVersion.
 */
export function invalidateAndRebuildTimeline(
  project: Project,
  realDurations?: ReadonlyMap<number, number> | Record<number, number>,
  patch?: Partial<Pick<Project, 'panels' | 'intro' | 'outro' | 'introDuration' | 'outroDuration' | 'voiceAssignments'>> & {
    panelGap?: number;
    introAudioDuration?: number | null;
    outroAudioDuration?: number | null;
  }
): Project {
  const panels = patch?.panels ?? project.panels;
  const intro = patch?.intro ?? project.intro;
  const outro = patch?.outro ?? project.outro;
  const introDuration =
    patch?.introDuration !== undefined
      ? patch.introDuration
      : patch?.introAudioDuration !== undefined && patch.introAudioDuration !== null && patch.introAudioDuration > 0
        ? roundMediaDuration(patch.introAudioDuration)
        : project.introDuration;
  const outroDuration =
    patch?.outroDuration !== undefined
      ? patch.outroDuration
      : patch?.outroAudioDuration !== undefined && patch.outroAudioDuration !== null && patch.outroAudioDuration > 0
        ? roundMediaDuration(patch.outroAudioDuration)
        : project.outroDuration;
  const voiceAssignments = patch?.voiceAssignments ?? project.voiceAssignments;
  const panelGap = patch?.panelGap ?? project.settings.panelGap ?? DEFAULT_PANEL_GAP;

  const realObj: Record<number, number> = {};
  if (realDurations) {
    if (realDurations instanceof Map || typeof (realDurations as ReadonlyMap<number, number>).forEach === 'function') {
      (realDurations as ReadonlyMap<number, number>).forEach((v, k) => {
        if (Number.isFinite(v) && v > 0) realObj[k] = v;
      });
    } else {
      for (const [k, v] of Object.entries(realDurations as Record<number, number>)) {
        if (Number.isFinite(v) && v > 0) realObj[Number(k)] = v;
      }
    }
  } else if (project.audioDurations) {
    for (const [k, v] of Object.entries(project.audioDurations)) {
      if (Number.isFinite(v) && v > 0) realObj[Number(k)] = v;
    }
  }

  const rebuilt = rebuildSrt({
    panels,
    audioDurations: realObj,
    voiceAssignments,
    intro,
    outro,
    introDuration,
    outroDuration,
    panelGap,
    realDurations: realObj,
  });

  const nextTimelineVersion = (project.timelineVersion ?? CURRENT_TIMELINE_VERSION) + 1;

  return {
    ...project,
    panels,
    intro,
    outro,
    introDuration,
    outroDuration,
    voiceAssignments,
    timeline: rebuilt.timeline,
    srt: rebuilt.srt,
    audioDurations: realObj,
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    timelineVersion: nextTimelineVersion,
    settings: {
      ...project.settings,
      ...(patch?.panelGap !== undefined ? { panelGap: patch.panelGap } : {}),
    },
    updatedAt: Date.now(),
  };
}

/**
 * Временной разряд группы СОСЕДНИХ сегментов на одном изображении.
 * Камера (Ken Burns) идёт по progress этой группы, а не отдельного сегмента —
 * иначе на каждой панели той же страницы зум «скачет» от 1.08 к 1.0.
 * @returns null, если сегмента с таким panelId в таймлайне нет.
 */
export function sameImageSpan(
  timeline: SyncTimeline[],
  panelId: number
): { start: number; end: number; startIndex: number } | null {
  const idx = timeline.findIndex(t => t.panelId === panelId);
  if (idx === -1) return null;
  const imageIndex = timeline[idx].imageIndex;
  let startIdx = idx;
  while (startIdx > 0 && timeline[startIdx - 1].imageIndex === imageIndex) startIdx--;
  let endIdx = idx;
  while (endIdx < timeline.length - 1 && timeline[endIdx + 1].imageIndex === imageIndex) endIdx++;
  return { start: timeline[startIdx].audioStart, end: timeline[endIdx].audioEnd, startIndex: startIdx };
}

export function estimateDuration(text: string): number {
  const charCount = (text || '').length;
  const base = Math.max(1.5, charCount / 14); // 14 chars per sec
  return Math.min(base + 0.5, 60); // cap at 60 sec per panel (long monologues)
}

export function calculateTotalDuration(timeline: SyncTimeline[], intro: number, outro: number): number {
  const safeIntro = Number.isFinite(intro) && intro >= 0 ? intro : 0;
  const safeOutro = Number.isFinite(outro) && outro >= 0 ? outro : 0;
  if (timeline.length === 0) return safeIntro + safeOutro;
  const last = timeline[timeline.length - 1];
  return last.audioEnd + safeOutro;
}

export function formatSRTTime(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function generateSRT(
  timeline: SyncTimeline[],
  introText: string,
  outroText: string,
  introDuration: number,
  outroDuration: number
): string {
  const lines: string[] = [];
  let index = 1;

  if (introText) {
    lines.push(`${index++}`);
    lines.push(`${formatSRTTime(0)} --> ${formatSRTTime(introDuration)}`);
    lines.push(introText);
    lines.push('');
  }

  for (const seg of timeline) {
    lines.push(`${index++}`);
    lines.push(`${formatSRTTime(seg.audioStart)} --> ${formatSRTTime(seg.audioEnd)}`);
    lines.push(`${seg.character}: ${seg.text}`);
    lines.push('');
  }

  if (outroText) {
    const totalEnd = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd + outroDuration : introDuration + outroDuration;
    const outroStart = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : introDuration;
    lines.push(`${index++}`);
    lines.push(`${formatSRTTime(outroStart)} --> ${formatSRTTime(totalEnd)}`);
    lines.push(outroText);
    lines.push('');
  }

  return lines.join('\n');
}

export interface ParsedSRTCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

export function parseSRTCues(srt: string): ParsedSRTCue[] {
  if (!srt || !srt.trim()) return [];
  const normalized = srt
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  const cues: ParsedSRTCue[] = [];
  const blocks = normalized.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trimEnd());
    if (lines.length < 2) continue;
    let timeLineIdx = 1;
    let index = cues.length + 1;
    if (lines[0].includes('-->')) {
      timeLineIdx = 0;
    } else {
      index = parseInt(lines[0], 10) || cues.length + 1;
    }
    const timeLine = lines[timeLineIdx] || '';
    const m = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    const start = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 1000;
    const end = parseInt(m[5], 10) * 3600 + parseInt(m[6], 10) * 60 + parseInt(m[7], 10) + parseInt(m[8], 10) / 1000;
    const text = lines.slice(timeLineIdx + 1).join('\n');
    cues.push({ index, start, end, text });
  }
  return cues;
}

// Ken Burns params
export interface KenBurnsParams {
  startScale: number;
  endScale: number;
  startX: number;
  endX: number;
  startY: number;
  endY: number;
}

export function getKenBurnsParams(panelIndex: number): KenBurnsParams {
  const directions: KenBurnsParams[] = [
    { startScale: 1.0, endScale: 1.15, startX: 0, endX: -0.08, startY: 0, endY: -0.05 },
    { startScale: 1.15, endScale: 1.0, startX: -0.08, endX: 0, startY: -0.05, endY: 0 },
    { startScale: 1.0, endScale: 1.2, startX: 0.05, endX: -0.08, startY: 0, endY: -0.08 },
    { startScale: 1.1, endScale: 1.0, startX: -0.05, endX: 0.05, startY: 0.05, endY: 0 },
    { startScale: 1.05, endScale: 1.18, startX: 0, endX: -0.1, startY: 0.05, endY: -0.05 },
  ];
  return directions[panelIndex % directions.length];
}
