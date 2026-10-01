import { PanelData } from './extractPanels';
import { SyncTimeline } from '../storage/db';

export interface AudioSegment {
  panelId: number;
  duration: number; // seconds
  blob?: Blob;
  base64?: string;
}

export function buildTimeline(
  panels: PanelData[],
  audioDurations: Map<number, number>, // panelId -> duration
  voiceAssignments: Record<string, string>,
  introDuration: number = 8,
  outroDuration: number = 5
): SyncTimeline[] {
  const timeline: SyncTimeline[] = [];
  let currentTime = introDuration;

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

    currentTime += duration + 0.3; // small pause between panels
  }

  return timeline;
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

  const formatTime = (seconds: number): string => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
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
