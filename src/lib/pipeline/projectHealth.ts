/**
 * Диагностика здоровья проекта («Проверка проекта»), предэкспортный контроль ресурсов,
 * генерация диагностического JSON-отчёта, WAV-предпрослушивание микса и тултипы
 * (Этап 9, пункты 84–89; Этап 10, пункты 91–94, 99).
 */

import type { PanelData, Project, SyncTimeline } from '../storage/db';
import { calculateTotalDuration, DEFAULT_PANEL_GAP } from './buildTimeline';
import { validateTimelineFull } from './timelineValidator';
import { yRangeFromBbox } from './yRange';
import { convertAudioBufferToWavBlob } from './audioPlayer';
import { mixAudioPlacements, type AudioPlacement } from './audioMix';

export type HealthIssueSeverity = 'error' | 'warning' | 'info';
export type HealthIssueCategory = 'sync' | 'audio' | 'image' | 'range' | 'duration' | 'storage';

export interface ProjectHealthIssue {
  id: string;
  severity: HealthIssueSeverity;
  category: HealthIssueCategory;
  code: string;
  message: string;
  panelId?: number;
  imageIndex?: number;
  /** Время на таймлайне для перехода по клику в списке проблем (Этап 10 п. 92). */
  seekTime?: number;
}

export type ProjectReadinessStatus = 'ready' | 'draft' | 'warnings' | 'errors';

export interface ProjectHealthReport {
  readyForExport: boolean;
  status: ProjectReadinessStatus;
  /** Текст индикатора готовности проекта для шапки редактора (Этап 10 п. 93). */
  badgeLabel: string;
  /** Точная итоговая длительность ролика, совпадающая с Timeline и SRT (Этап 9 п. 85). */
  exactDuration: number;
  voicedPanelsCount: number;
  totalDialoguePanelsCount: number;
  issues: ProjectHealthIssue[];
}

export interface InspectProjectHealthParams {
  panels: readonly PanelData[];
  timeline: readonly SyncTimeline[];
  srt?: string;
  intro?: string;
  outro?: string;
  panelGap?: number;
  introDuration?: number;
  outroDuration?: number;
  /** Индексы доступных изображений (0-based) или общее число страниц. */
  availableImageIndices?: Iterable<number> | number;
  /** ID панелей, у которых есть реальный аудио-блоб в памяти или OPFS. */
  voicedPanelIds?: Iterable<number>;
  /** Реальные длительности аудиофайлов. */
  realDurations?: ReadonlyMap<number, number> | Record<number, number>;
  /** Использовать строгую блокировку экспорта при отсутствии озвучки реплики. */
  requireAllDialogueVoiced?: boolean;
}

/** Minimum and maximum recommended clip durations in seconds (Stage 9 item 89). */
export const MIN_RECOMMENDED_CLIP_DURATION_SEC = 0.2;
export const MAX_RECOMMENDED_CLIP_DURATION_SEC = 60;

/**
 * Выполняет полную проверку проекта («Проверка проекта», Этап 9 п. 84–86, 89; Этап 10 п. 91–93).
 */
export function inspectProjectHealth(params: InspectProjectHealthParams): ProjectHealthReport {
  const {
    panels,
    timeline,
    srt = '',
    intro = '',
    outro = '',
    panelGap = DEFAULT_PANEL_GAP,
    introDuration = 0,
    outroDuration = 0,
    availableImageIndices,
    voicedPanelIds,
    realDurations,
    requireAllDialogueVoiced = false,
  } = params;

  const issues: ProjectHealthIssue[] = [];
  const segByPanelId = new Map<number, SyncTimeline>(timeline.map(s => [s.panelId, s]));

  const imageSet: Set<number> | null =
    typeof availableImageIndices === 'number'
      ? new Set(Array.from({ length: Math.max(0, availableImageIndices) }, (_, i) => i))
      : availableImageIndices
      ? new Set(availableImageIndices)
      : null;

  const voicedSet: Set<number> | null = voicedPanelIds ? new Set(voicedPanelIds) : null;

  // 1. Проверка наличия панелей
  if (panels.length === 0) {
    issues.push({
      id: 'empty-panels',
      severity: 'error',
      category: 'sync',
      code: 'NO_PANELS',
      message: 'В проекте нет ни одной панели или реплики.',
      seekTime: 0,
    });
  }

  // 2. Проверка наличия изображений и аудио для каждой панели (Этап 9 п. 84)
  let voicedPanelsCount = 0;
  let totalDialoguePanelsCount = 0;
  const sortedPanels = [...panels].sort((a, b) => a.order - b.order || a.id - b.id);

  for (const panel of sortedPanels) {
    const seg = segByPanelId.get(panel.id);
    const seekTime = seg ? seg.audioStart : introDuration;

    if (imageSet && !imageSet.has(panel.imageIndex)) {
      issues.push({
        id: `missing-image-${panel.id}`,
        severity: 'error',
        category: 'image',
        code: 'MISSING_IMAGE_RESOURCE',
        message: `Панель #${panel.id}: отсутствует исходное изображение страницы №${panel.imageIndex + 1}.`,
        panelId: panel.id,
        imageIndex: panel.imageIndex,
        seekTime,
      });
    }

    // Итерация 2.2 (P1-5): предупреждение для сверхтонких полос (< 2% высоты), где камера почти не движется
    if (!panel.fullFrame && panel.bbox && panel.bbox.height > 0 && panel.bbox.height < 2) {
      issues.push({
        id: `tiny-height-${panel.id}`,
        severity: 'warning',
        category: 'range',
        code: 'PANEL_HEIGHT_UNDER_2_PERCENT',
        message: `Панель #${panel.id}: панель < 2% высоты (${panel.bbox.height}%) — камера почти не движется.`,
        panelId: panel.id,
        imageIndex: panel.imageIndex,
        seekTime,
      });
    }

    const hasDialogue = Boolean((panel.dialogue || '').trim());
    if (hasDialogue) {
      totalDialoguePanelsCount += 1;
      const hasAudio = voicedSet
        ? voicedSet.has(panel.id) ||
          (panel.sourceAudioPanelId !== undefined && voicedSet.has(panel.sourceAudioPanelId))
        : seg !== undefined && !seg.isEstimated;

      if (hasAudio) {
        voicedPanelsCount += 1;
      } else {
        issues.push({
          id: `missing-audio-${panel.id}`,
          severity: requireAllDialogueVoiced ? 'error' : 'warning',
          category: 'audio',
          code: 'MISSING_AUDIO_RESOURCE',
          message: `Панель #${panel.id} (${panel.character || 'Персонаж'}): нет реального аудиофайла — используется черновая оценка длительности.`,
          panelId: panel.id,
          imageIndex: panel.imageIndex,
          seekTime,
        });
      }
    }
  }

  // 3. Валидация таймлайна, монотонности, наложений, SRT и процентов (Этап 1 п. 6–8, Этап 4 п. 32, Этап 9 п. 86)
  const exactDuration = calculateTotalDuration([...timeline], introDuration, outroDuration);
  const fullValidation = validateTimelineFull({
    panels,
    timeline,
    intro,
    outro,
    introDuration,
    outroDuration,
    panelGap,
    claimedDuration: exactDuration,
    srt,
    realDurations,
  });

  for (const vIssue of fullValidation.issues) {
    // Если SRT просто не был передан (пустая строка в unit-тесте без SRT), пропускаем SRT_COUNT_MISMATCH
    if (!srt && vIssue.code === 'SRT_COUNT_MISMATCH') continue;
    const seg = vIssue.panelId !== undefined ? segByPanelId.get(vIssue.panelId) : undefined;
    const panel = vIssue.panelId !== undefined ? panels.find(p => p.id === vIssue.panelId) : undefined;
    issues.push({
      id: `val-${vIssue.code}-${vIssue.panelId ?? issues.length}`,
      severity: vIssue.severity,
      category: vIssue.code.includes('RANGE') ? 'range' : 'sync',
      code: vIssue.code,
      message: vIssue.message,
      panelId: vIssue.panelId,
      imageIndex: panel?.imageIndex,
      seekTime: seg?.audioStart ?? 0,
    });
  }

  // 4. Предупреждения о слишком коротких (< 0.2s) и слишком длинных (> 60s) клипах (Этап 9 п. 89)
  for (const seg of timeline) {
    const clipDur = seg.audioEnd - seg.audioStart;
    const panel = panels.find(p => p.id === seg.panelId);
    if (clipDur < MIN_RECOMMENDED_CLIP_DURATION_SEC - 1e-4) {
      issues.push({
        id: `short-clip-${seg.panelId}`,
        severity: 'warning',
        category: 'duration',
        code: 'CLIP_TOO_SHORT',
        message: `Панель #${seg.panelId}: слишком короткий клип (${clipDur.toFixed(2)} с < ${MIN_RECOMMENDED_CLIP_DURATION_SEC} с). Зритель может не успеть прочитать реплику.`,
        panelId: seg.panelId,
        imageIndex: panel?.imageIndex,
        seekTime: seg.audioStart,
      });
    } else if (clipDur > MAX_RECOMMENDED_CLIP_DURATION_SEC + 1e-4) {
      issues.push({
        id: `long-clip-${seg.panelId}`,
        severity: 'warning',
        category: 'duration',
        code: 'CLIP_TOO_LONG',
        message: `Панель #${seg.panelId}: очень длинный клип (${clipDur.toFixed(1)} с > ${MAX_RECOMMENDED_CLIP_DURATION_SEC} с). Рекомендуется разбить реплику через Split (S).`,
        panelId: seg.panelId,
        imageIndex: panel?.imageIndex,
        seekTime: seg.audioStart,
      });
    }
  }

  const hasErrors = issues.some(i => i.severity === 'error');
  const hasWarnings = issues.some(i => i.severity === 'warning');
  const isDraft = totalDialoguePanelsCount > 0 && voicedPanelsCount < totalDialoguePanelsCount;

  let status: ProjectReadinessStatus = 'ready';
  let badgeLabel = 'Готов к экспорту';

  if (hasErrors) {
    status = 'errors';
    badgeLabel = `Ошибок: ${issues.filter(i => i.severity === 'error').length}`;
  } else if (isDraft) {
    status = 'draft';
    badgeLabel = `Черновик (${voicedPanelsCount}/${totalDialoguePanelsCount} озв.)`;
  } else if (hasWarnings) {
    status = 'warnings';
    badgeLabel = `Предупреждений: ${issues.filter(i => i.severity === 'warning').length}`;
  }

  return {
    readyForExport: !hasErrors,
    status,
    badgeLabel,
    exactDuration,
    voicedPanelsCount,
    totalDialoguePanelsCount,
    issues,
  };
}

/**
 * Экспорт полного диагностического JSON-отчёта о проекте и состоянии синхронизации
 * (Этап 9, пункт 88; Этап 10, пункт 99).
 */
export function buildDiagnosticReportJson(
  project: Pick<
    Project,
    | 'id'
    | 'name'
    | 'schemaVersion'
    | 'timelineVersion'
    | 'revision'
    | 'panels'
    | 'timeline'
    | 'audioDurations'
    | 'resourceManifest'
    | 'eventLog'
  > & {
    settings?: Partial<Project['settings']>;
  },
  healthReport: ProjectHealthReport
): string {
  const report = {
    generatedAt: new Date().toISOString(),
    projectId: project.id,
    projectName: project.name,
    schemaVersion: project.schemaVersion ?? 2,
    timelineVersion: project.timelineVersion ?? 2,
    timelineMode: healthReport.status === 'draft' ? 'draft' : 'real',
    revision: project.revision ?? 1,
    renderMode: project.settings?.renderMode ?? 'panels',
    panelGap: project.settings?.panelGap ?? DEFAULT_PANEL_GAP,
    exactDuration: healthReport.exactDuration,
    health: {
      readyForExport: healthReport.readyForExport,
      status: healthReport.status,
      badgeLabel: healthReport.badgeLabel,
      voicedPanelsCount: healthReport.voicedPanelsCount,
      totalDialoguePanelsCount: healthReport.totalDialoguePanelsCount,
      issues: healthReport.issues,
    },
    panels: project.panels.map(p => ({
      id: p.id,
      order: p.order,
      imageIndex: p.imageIndex,
      yRange: yRangeFromBbox(p.bbox, p.fullFrame) ?? { from: 0, to: 100 },
      character: p.character,
      audioSource: p.audioSource ?? 'tts',
      audioFileName: p.audioFileName,
      audioOriginalMime: p.audioOriginalMime,
      audioNormalizedMime: p.audioNormalizedMime,
      trimIn: p.trimIn,
      trimOut: p.trimOut,
      durationOverride: p.durationOverride,
      gain: p.gain,
      fadeIn: p.fadeIn,
      fadeOut: p.fadeOut,
      muted: p.muted,
      solo: p.solo,
    })),
    timeline: project.timeline,
    audioDurations: project.audioDurations ?? {},
    resourceManifestCount: Object.keys(project.resourceManifest ?? {}).length,
    eventLog: project.eventLog ?? [],
  };

  return JSON.stringify(report, null, 2);
}

/**
 * Собирает WAV-блоб финального аудиомикса для предпрослушивания в `ExportModal`
 * перед полным видеорендером (Этап 9, пункт 87).
 */
export async function renderExportAudioMixPreviewWav(
  placements: AudioPlacement[],
  totalDuration: number,
  options: { sampleRate?: number; channels?: number } = {}
): Promise<Blob | null> {
  const mixed = await mixAudioPlacements(placements, totalDuration, {
    sampleRate: options.sampleRate ?? 22050,
    channels: options.channels ?? 1,
  });
  if (!mixed) return null;
  return convertAudioBufferToWavBlob(mixed.buffer);
}

// ---------- Тултипы для [X..Y%], клипов и gap (Этап 10, пункт 94) ----------

export function formatRangeTooltip(from: number, to: number, imageNumber: number): string {
  if (from <= 0 && to >= 100) {
    return `Изображение ${imageNumber} целиком [0..100%]: показывается вся страница от верхнего до нижнего края.`;
  }
  return `Изображение ${imageNumber} [${from}..${to}%]: вертикальный срез страницы от ${from}% до ${to}% высоты (определяет только ГДЕ показывать кадр, длительность задаётся звуком).`;
}

export function formatClipTooltip(params: {
  panelId: number;
  imageNumber: number;
  audioStart: number;
  audioEnd: number;
  source?: 'tts' | 'import' | 'draft';
  fileName?: string;
  trimIn?: number;
  trimOut?: number;
}): string {
  const dur = Math.max(0, params.audioEnd - params.audioStart).toFixed(2);
  const srcLabel =
    params.source === 'import'
      ? `Импорт (${params.fileName || 'внешний файл'})`
      : params.source === 'tts'
      ? 'Синтез речи (TTS)'
      : 'Черновая оценка по длине текста';
  const trimNote =
    (params.trimIn ?? 0) > 0 || (params.trimOut ?? 0) > 0
      ? ` · Trim [${(params.trimIn ?? 0).toFixed(2)}s / -${(params.trimOut ?? 0).toFixed(2)}s]`
      : '';
  return `Панель #${params.panelId} (Стр. ${params.imageNumber}) · ${params.audioStart.toFixed(2)}–${params.audioEnd.toFixed(2)} с (${dur} с) · ${srcLabel}${trimNote}`;
}

export function formatGapTooltip(durationSec: number, indexAfterPanelId: number): string {
  return `Межрепликовая пауза (panelGap): ${durationSec.toFixed(2)} с после панели #${indexAfterPanelId}. Настраивается в параметрах проекта.`;
}
