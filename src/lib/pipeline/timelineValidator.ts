/**
 * Валидаторы таймлайна, длительности и синхронизации SRT
 * (Этап 1 п. 6, 7, 8; Этап 4 п. 31, 32; Этап 9 п. 86).
 */

import type { PanelData, SyncTimeline } from '../storage/db';
import { calculateTotalDuration, DEFAULT_PANEL_GAP, parseSRTCues } from './buildTimeline';

export interface TimelineValidationIssue {
  code:
    | 'NON_POSITIVE_SEGMENT'
    | 'STARTS_BEFORE_INTRO'
    | 'MONOTONICITY_VIOLATION'
    | 'GAP_MISMATCH'
    | 'AUDIO_OVERLAP'
    | 'BLOB_EXCEEDS_WINDOW'
    | 'DURATION_MISMATCH'
    | 'SRT_COUNT_MISMATCH'
    | 'SRT_TIMING_MISMATCH'
    | 'INVALID_PERCENT_RANGE';
  severity: 'error' | 'warning';
  panelId?: number;
  message: string;
}

export interface TimelineValidationResult {
  valid: boolean;
  issues: TimelineValidationIssue[];
  errors: string[];
  warnings: string[];
}

const EPS = 1e-3;
const SRT_TOLERANCE_SEC = 0.005; // 5 мс — запас на округление миллисекунд в формате SRT

function makeResult(issues: TimelineValidationIssue[]): TimelineValidationResult {
  const errors = issues.filter(i => i.severity === 'error').map(i => i.message);
  const warnings = issues.filter(i => i.severity === 'warning').map(i => i.message);
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}

/**
 * Пункт 6: Валидатор монотонности интервалов.
 * Следующий сегмент начинается не раньше конца предыдущего с учётом gap.
 */
export function validateTimelineMonotonicity(
  timeline: readonly SyncTimeline[],
  panelGap: number = DEFAULT_PANEL_GAP,
  introDuration: number = 0
): TimelineValidationResult {
  const issues: TimelineValidationIssue[] = [];
  const safeGap = Number.isFinite(panelGap) && panelGap >= 0 ? panelGap : 0;
  const safeIntro = Number.isFinite(introDuration) && introDuration >= 0 ? introDuration : 0;

  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    if (!Number.isFinite(seg.audioStart) || !Number.isFinite(seg.audioEnd) || seg.audioEnd <= seg.audioStart + 1e-6) {
      issues.push({
        code: 'NON_POSITIVE_SEGMENT',
        severity: 'error',
        panelId: seg.panelId,
        message: `Панель ${seg.panelId}: некорректный интервал [${seg.audioStart}..${seg.audioEnd}] (длительность должна быть > 0)`,
      });
    }

    if (i === 0 && seg.audioStart < safeIntro - EPS) {
      issues.push({
        code: 'STARTS_BEFORE_INTRO',
        severity: 'error',
        panelId: seg.panelId,
        message: `Панель ${seg.panelId}: начинается в ${seg.audioStart.toFixed(3)}с раньше конца интро (${safeIntro.toFixed(3)}с)`,
      });
    }

    if (i > 0) {
      const prev = timeline[i - 1];
      const expectedMinStart = prev.audioEnd + safeGap;
      if (seg.audioStart < prev.audioEnd - EPS) {
        issues.push({
          code: 'MONOTONICITY_VIOLATION',
          severity: 'error',
          panelId: seg.panelId,
          message: `Нарушение монотонности: панель ${seg.panelId} начинается в ${seg.audioStart.toFixed(3)}с раньше конца панели ${prev.panelId} (${prev.audioEnd.toFixed(3)}с)`,
        });
      } else if (seg.audioStart < expectedMinStart - EPS) {
        issues.push({
          code: 'GAP_MISMATCH',
          severity: 'error',
          panelId: seg.panelId,
          message: `Панель ${seg.panelId}: старт ${seg.audioStart.toFixed(3)}с меньше ожидаемого с учётом паузы ${safeGap}с (${expectedMinStart.toFixed(3)}с)`,
        });
      }
    }
  }

  return makeResult(issues);
}

/**
 * Пункт 7: Валидатор отсутствия пересечений аудио.
 * Проверяет как пересечения сегментов таймлайна, так и выход реальной длительности
 * аудиоблоба за границы следующего сегмента.
 */
export function validateAudioNonOverlapping(
  timeline: readonly SyncTimeline[],
  realDurations?: ReadonlyMap<number, number> | Record<number, number>
): TimelineValidationResult {
  const issues: TimelineValidationIssue[] = [];

  const getDur = (panelId: number): number | undefined => {
    if (!realDurations) return undefined;
    if (realDurations instanceof Map || typeof (realDurations as ReadonlyMap<number, number>).get === 'function') {
      return (realDurations as ReadonlyMap<number, number>).get(panelId);
    }
    return (realDurations as Record<number, number>)[panelId];
  };

  for (let i = 0; i < timeline.length; i++) {
    const seg = timeline[i];
    const next = timeline[i + 1];

    if (next && next.audioStart < seg.audioEnd - EPS) {
      const overlap = seg.audioEnd - next.audioStart;
      issues.push({
        code: 'AUDIO_OVERLAP',
        severity: 'error',
        panelId: seg.panelId,
        message: `Пересечение аудио: панель ${seg.panelId} [${seg.audioStart.toFixed(2)}..${seg.audioEnd.toFixed(2)}с] накладывается на панель ${next.panelId} [${next.audioStart.toFixed(2)}..${next.audioEnd.toFixed(2)}с] на ${overlap.toFixed(2)}с`,
      });
    }

    const rawDur = getDur(seg.panelId);
    if (rawDur !== undefined && Number.isFinite(rawDur) && rawDur > 0) {
      const trimIn = Math.max(0, seg.trimIn ?? 0);
      const trimOut = Math.max(0, seg.trimOut ?? 0);
      const effectiveBlobDur = Math.max(0.05, rawDur - trimIn - trimOut);
      const segDur = seg.audioEnd - seg.audioStart;

      if (next && seg.audioStart + effectiveBlobDur > next.audioStart + EPS) {
        const over = seg.audioStart + effectiveBlobDur - next.audioStart;
        issues.push({
          code: 'BLOB_EXCEEDS_WINDOW',
          severity: 'error',
          panelId: seg.panelId,
          message: `Аудио панели ${seg.panelId} (${effectiveBlobDur.toFixed(2)}с) перекрывает старт панели ${next.panelId} на ${over.toFixed(2)}с`,
        });
      } else if (Math.abs(effectiveBlobDur - segDur) > 0.05) {
        issues.push({
          code: 'BLOB_EXCEEDS_WINDOW',
          severity: 'warning',
          panelId: seg.panelId,
          message: `Панель ${seg.panelId}: длительность сегмента (${segDur.toFixed(2)}с) отличается от длительности аудио (${effectiveBlobDur.toFixed(2)}с) — требуется пересборка таймлайна`,
        });
      }
    }
  }

  return makeResult(issues);
}

/**
 * Пункт 8: Проверка совпадения `duration` и последнего сегмента:
 * интро, панели, паузы и аутро учитываются ровно один раз.
 */
export function validateTotalDuration(
  timeline: readonly SyncTimeline[],
  introDuration: number,
  outroDuration: number,
  claimedDuration: number,
  panelGap?: number
): TimelineValidationResult {
  const issues: TimelineValidationIssue[] = [];
  const expectedTotal = calculateTotalDuration([...timeline], introDuration, outroDuration);

  if (!Number.isFinite(claimedDuration) || Math.abs(claimedDuration - expectedTotal) > EPS) {
    issues.push({
      code: 'DURATION_MISMATCH',
      severity: 'error',
      message: `Несовпадение общей длительности: заявлено ${Number(claimedDuration).toFixed(3)}с, по таймлайну (интро + панели + паузы + аутро) = ${expectedTotal.toFixed(3)}с`,
    });
  }

  if (timeline.length > 0 && panelGap !== undefined && Number.isFinite(panelGap) && panelGap >= 0) {
    const safeIntro = Math.max(0, introDuration);
    const safeOutro = Math.max(0, outroDuration);
    const panelsSum = timeline.reduce((sum, seg) => sum + Math.max(0, seg.audioEnd - seg.audioStart), 0);
    const gapsSum = Math.max(0, timeline.length - 1) * panelGap;
    const exactFormulaTotal = safeIntro + panelsSum + gapsSum + safeOutro;

    if (Math.abs(expectedTotal - exactFormulaTotal) > EPS) {
      issues.push({
        code: 'DURATION_MISMATCH',
        severity: 'error',
        message: `Рассинхрон суммы сегментов: конец последнего сегмента + аутро = ${expectedTotal.toFixed(3)}с, а (интро ${safeIntro.toFixed(2)}с + панели ${panelsSum.toFixed(2)}с + паузы ${gapsSum.toFixed(2)}с + аутро ${safeOutro.toFixed(2)}с) = ${exactFormulaTotal.toFixed(3)}с`,
      });
    }
  }

  return makeResult(issues);
}

/**
 * Проверка синхронности SRT и SyncTimeline (Этап 1 критерий приёмки, Этап 9 п. 86).
 */
export function validateSrtSync(
  timeline: readonly SyncTimeline[],
  srt: string,
  introText: string = '',
  outroText: string = '',
  introDuration: number = 0,
  outroDuration: number = 0
): TimelineValidationResult {
  const issues: TimelineValidationIssue[] = [];
  const cues = parseSRTCues(srt);

  const expectedCues: Array<{ start: number; end: number; panelId?: number; label: string }> = [];
  if (introText) {
    expectedCues.push({ start: 0, end: introDuration, label: 'Интро' });
  }
  for (const seg of timeline) {
    expectedCues.push({
      start: seg.audioStart,
      end: seg.audioEnd,
      panelId: seg.panelId,
      label: `Панель ${seg.panelId}`,
    });
  }
  if (outroText) {
    const outroStart = timeline.length > 0 ? timeline[timeline.length - 1].audioEnd : introDuration;
    const outroEnd = outroStart + outroDuration;
    expectedCues.push({ start: outroStart, end: outroEnd, label: 'Аутро' });
  }

  if (cues.length !== expectedCues.length) {
    issues.push({
      code: 'SRT_COUNT_MISMATCH',
      severity: 'error',
      message: `Рассинхрон SRT: в SRT ${cues.length} титров, а в таймлайне ожидается ${expectedCues.length}`,
    });
    return makeResult(issues);
  }

  for (let i = 0; i < expectedCues.length; i++) {
    const exp = expectedCues[i];
    const cue = cues[i];
    if (
      Math.abs(cue.start - exp.start) > SRT_TOLERANCE_SEC ||
      Math.abs(cue.end - exp.end) > SRT_TOLERANCE_SEC
    ) {
      issues.push({
        code: 'SRT_TIMING_MISMATCH',
        severity: 'error',
        panelId: exp.panelId,
        message: `Рассинхрон SRT (${exp.label}): в SRT [${cue.start.toFixed(3)}..${cue.end.toFixed(3)}с], в SyncTimeline [${exp.start.toFixed(3)}..${exp.end.toFixed(3)}с]`,
      });
    }
  }

  return makeResult(issues);
}

/**
 * Проверка корректности процентов/bbox всех панелей (Этап 4 п. 31, 32).
 */
export function validatePanelPercentages(panels: readonly PanelData[]): TimelineValidationResult {
  const issues: TimelineValidationIssue[] = [];
  for (const p of panels) {
    if (p.fullFrame) continue;
    const b = p.bbox;
    if (!b || !Number.isFinite(b.y) || !Number.isFinite(b.height)) {
      issues.push({
        code: 'INVALID_PERCENT_RANGE',
        severity: 'error',
        panelId: p.id,
        message: `Панель ${p.id}: не заданы числовые координаты bbox`,
      });
      continue;
    }
    const from = b.y;
    const to = b.y + b.height;
    if (from < -1e-6 || to > 100 + 1e-6 || from >= to) {
      issues.push({
        code: 'INVALID_PERCENT_RANGE',
        severity: 'error',
        panelId: p.id,
        message: `Панель ${p.id}: диапазон [${from}..${to}%] нарушает правило 0 <= from < to <= 100`,
      });
    }
  }
  return makeResult(issues);
}

/**
 * Полная комплексная проверка синхронизации таймлайна, длительности, аудио и SRT.
 */
export function validateTimelineFull(params: {
  panels: readonly PanelData[];
  timeline: readonly SyncTimeline[];
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  panelGap: number;
  claimedDuration: number;
  srt: string;
  realDurations?: ReadonlyMap<number, number> | Record<number, number>;
}): TimelineValidationResult {
  const mono = validateTimelineMonotonicity(params.timeline, params.panelGap, params.introDuration);
  const overlap = validateAudioNonOverlapping(params.timeline, params.realDurations);
  const total = validateTotalDuration(
    params.timeline,
    params.introDuration,
    params.outroDuration,
    params.claimedDuration,
    params.panelGap
  );
  const srtSync = validateSrtSync(
    params.timeline,
    params.srt,
    params.intro,
    params.outro,
    params.introDuration,
    params.outroDuration
  );
  const pct = validatePanelPercentages(params.panels);

  return makeResult([
    ...mono.issues,
    ...overlap.issues,
    ...total.issues,
    ...srtSync.issues,
    ...pct.issues,
  ]);
}
