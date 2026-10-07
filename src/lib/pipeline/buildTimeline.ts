import { PanelData } from './extractPanels';
import { SyncTimeline } from '../storage/db';

export interface AudioSegment {
  panelId: number;
  duration: number; // seconds
  blob?: Blob;
  base64?: string;
}

/** Пауза по умолчанию между репликами, сек (сценарий задаёт 0,6 — см. SCENARIO_GAP_SECONDS). */
export const DEFAULT_PANEL_GAP = 0.3;

export function buildTimeline(
  panels: PanelData[],
  audioDurations: Map<number, number>, // panelId -> duration
  voiceAssignments: Record<string, string>,
  introDuration: number = 8,
  /** Пауза между репликами, сек: после завершения чтения — переход к следующему изображению. */
  panelGap: number = DEFAULT_PANEL_GAP
): SyncTimeline[] {
  const timeline: SyncTimeline[] = [];
  let currentTime = introDuration;
  const gap = Number.isFinite(panelGap) && panelGap >= 0 ? panelGap : DEFAULT_PANEL_GAP;

  // Sort panels by order
  const sorted = [...panels].sort((a, b) => a.order - b.order);

  for (const panel of sorted) {
    const duration = audioDurations.get(panel.id) ?? estimateDuration(panel.dialogue);
    const voiceId = voiceAssignments[panel.character] || 'default';

    timeline.push({
      panelId: panel.id,
      imageIndex: panel.imageIndex,
      audioStart: currentTime,
      audioEnd: currentTime + duration,
      panelBbox: panel.bbox,
      voiceId,
      text: panel.dialogue,
      character: panel.character,
    });

    currentTime += duration + gap; // пауза между репликами перед следующим изображением
  }

  return timeline;
}

/**
 * ЕДИНАЯ точка сборки таймлайна + SRT. Все места, где SRT «вручную» строился
 * (сценарий, смена паузы, озвучка, интро/аутро), вызывают отсюда:
 * — длительности = реальные (audioDurations), если есть, иначе оценка;
 * — интро/аутро и их длительности передаются как есть (SRT сдвигается на
 *   introDuration, аутро — после последней панели);
 * — draft = true, пока хотя бы у одной панели нет РЕАЛЬНОЙ длительности
 *   (озвучка ещё не сгенерирована) — SRT «черновой», не влияет на экспорт.
 */
export interface RebuildSrtInput {
  panels: PanelData[];
  /** panelId → длительность (реальная или оценочная). */
  audioDurations: Map<number, number>;
  voiceAssignments: Record<string, string>;
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  panelGap: number;
  /** Реальные (сохранённые) длительности — для флага черновика. */
  realDurations?: Record<number, number>;
}

export interface RebuildSrtResult {
  timeline: SyncTimeline[];
  srt: string;
  draft: boolean;
}

export function rebuildSrt(input: RebuildSrtInput): RebuildSrtResult {
  const durationMap = new Map<number, number>();
  for (const p of input.panels) {
    durationMap.set(p.id, input.audioDurations.get(p.id) ?? estimateDuration(p.dialogue));
  }
  const timeline = buildTimeline(
    input.panels,
    durationMap,
    input.voiceAssignments,
    input.introDuration,
    input.panelGap
  );
  const srt = generateSRT(timeline, input.intro, input.outro, input.introDuration, input.outroDuration);
  const real = input.realDurations ?? {};
  const draft = input.panels.length > 0 && input.panels.some(p => real[p.id] === undefined);
  return { timeline, srt, draft };
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
  const charCount = text.length;
  const base = Math.max(1.5, charCount / 14); // 14 chars per sec
  return Math.min(base + 0.5, 60); // cap at 60 sec per panel (long monologues)
}

export function calculateTotalDuration(timeline: SyncTimeline[], intro: number, outro: number): number {
  if (timeline.length === 0) return intro + outro;
  const last = timeline[timeline.length - 1];
  return last.audioEnd + outro;
}

export function generateSRT(timeline: SyncTimeline[], introText: string, outroText: string, introDuration: number, outroDuration: number): string {
  const lines: string[] = [];
  let index = 1;

  // Округляем ОБЩИЕ миллисекунды: floor((t % 1) * 1000) на плавающей точке
  // даёт 7.6s → 07,599 (0.6*1000 = 599.9999… — классический fp-баг).
  const formatTime = (seconds: number): string => {
    const totalMs = Math.round(Math.max(0, seconds) * 1000);
    const h = Math.floor(totalMs / 3600000);
    const m = Math.floor((totalMs % 3600000) / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };

  if (introText) {
    lines.push(`${index++}`);
    lines.push(`${formatTime(0)} --> ${formatTime(introDuration)}`);
    lines.push(introText);
    lines.push('');
  }

  for (const seg of timeline) {
    lines.push(`${index++}`);
    lines.push(`${formatTime(seg.audioStart)} --> ${formatTime(seg.audioEnd)}`);
    lines.push(`${seg.character}: ${seg.text}`);
    lines.push('');
  }

  if (outroText) {
    const totalEnd = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd + outroDuration : introDuration + outroDuration;
    const outroStart = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : introDuration;
    lines.push(`${index++}`);
    lines.push(`${formatTime(outroStart)} --> ${formatTime(totalEnd)}`);
    lines.push(outroText);
    lines.push('');
  }

  return lines.join('\n');
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
