/**
 * Импорт внешних аудиофайлов на панели по якорям (v1.3.18).
 *
 * Этот модуль — доменная обёртка над planImport: цели = панели, якорь =
 * заголовок serializeScenario («Изображение 1 [0..30%]»), порядок = тот же,
 * что в «Скопировать с якорями» ((order, imageIndex), затем id).
 *
 * Здесь только план (чистая функция). Применение (декод, OPFS, отметка
 * «импорт» в PanelData) — applyAudioImport, следующий шаг.
 */

import type { PanelData } from './extractPanels';
import { fileExtension, planImport, type ImportFileRef, type ImportPlan } from './importPlan';
import { panelAnchor } from './scenarioFormat';

/**
 * Расширения, которые пускаем в план. Это не обещание, что браузер их
 * декодирует: истина — decodeAudioData на применении («формат не поддержан
 * браузером»). Список отсекает явно не-аудио (картинки, txt) ещё в таблице.
 */
export const AUDIO_IMPORT_EXTENSIONS = [
  'mp3', 'wav', 'wave', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'mp4', 'flac', 'webm', 'weba', 'aif', 'aiff', 'caf',
] as const;

export function isAudioFileName(name: string): boolean {
  return (AUDIO_IMPORT_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** Подпись панели в плане: «Изображение 1 [0..30%] · Аня». */
export function audioTargetLabel(panel: Pick<PanelData, 'imageIndex' | 'bbox' | 'fullFrame' | 'character'>): string {
  const anchor = panelAnchor(panel);
  const who = (panel.character || '').trim();
  return who ? `${anchor} · ${who}` : anchor;
}

export interface PlanAudioImportOptions {
  manifest?: string;
  manualOverrides?: ReadonlyMap<string, string>;
  allowNameAnchor?: boolean;
  useOrder?: boolean;
  /** Перезаписывать панели, у которых уже есть аудио (TTS или прошлый импорт). */
  overwrite?: boolean;
  /** id панелей, у которых уже есть аудио. */
  existingAudio?: Iterable<number>;
}

export interface AudioImportPlan extends ImportPlan<PanelData> {
  /**
   * Сопоставлены, но не будут применены: у панели уже есть аудио, а
   * «Перезаписать» выключено. Повторный импорт тех же файлов → всё сюда, 0 ошибок.
   */
  skipped: AudioImportPlan['matches'];
}

export function planAudioImport(
  files: ImportFileRef[],
  panels: PanelData[],
  opts: PlanAudioImportOptions = {},
): AudioImportPlan {
  const errors: string[] = [];
  const audioFiles: ImportFileRef[] = [];
  for (const f of files) {
    if (isAudioFileName(f.name)) audioFiles.push(f);
    else errors.push(`Файл «${f.name}»: не аудиофайл (mp3, wav, ogg/opus, m4a/aac, flac, webm)`);
  }

  const plan = planImport<PanelData>({
    files: audioFiles,
    targets: panels,
    targetId: p => String(p.id),
    targetAnchor: p => panelAnchor(p),
    targetLabel: p => audioTargetLabel(p),
    targetOrder: p => [p.order ?? 0, p.imageIndex, p.id],
    manifest: opts.manifest,
    manualOverrides: opts.manualOverrides,
    allowNameAnchor: opts.allowNameAnchor,
    useOrder: opts.useOrder,
    nouns: { genitivePlural: 'панелей', genitiveSingular: 'панели' },
  });

  const existing = new Set(opts.existingAudio ?? []);
  const warnings = [...plan.warnings];
  const matches: AudioImportPlan['matches'] = [];
  const skipped: AudioImportPlan['matches'] = [];
  for (const m of plan.matches) {
    if (!opts.overwrite && existing.has(m.target.id)) {
      skipped.push(m);
      warnings.push(`Панель «${m.label}»: аудио уже есть — «${m.file}» пропущен (включите «Перезаписать»)`);
    } else {
      matches.push(m);
    }
  }
  // Панели без файла — только если файлы вообще есть (пустая модалка без шума).
  if (audioFiles.length > 0) {
    for (const p of plan.unmatchedTargets) {
      warnings.push(existing.has(p.id)
        ? `Панель «${audioTargetLabel(p)}» без файла — останется текущее аудио`
        : `Панель «${audioTargetLabel(p)}» без файла — останется TTS`);
    }
  }

  return { ...plan, matches, skipped, errors: [...errors, ...plan.errors], warnings };
}
