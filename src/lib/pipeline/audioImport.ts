/**
 * Импорт внешних аудиофайлов на панели по якорям (v1.3.18).
 *
 * Этот модуль — доменная обёртка над planImport: цели = панели, якорь =
 * заголовок serializeScenario («Изображение 1 [0..30%]»), порядок = тот же,
 * что в «Скопировать с якорями» ((order, imageIndex), затем id).
 *
 * planAudioImport — чистая функция (пересчитывается на каждый ререндер
 * модалки). applyAudioImport — применение: декод (проверка + длительность),
 * запись в OPFS по ключу TTS, отчёт. markPanelsImported — чистая отметка
 * панелей по отчёту (её зовёт редактор, в т.ч. после каждого файла).
 */

import type { PanelData } from './extractPanels';
import { deleteProjectAudioSignature, getOPFSUsage, saveProjectAudio } from '../storage/opfs';
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

// ---------------------------------------------------------------------------
// Применение
// ---------------------------------------------------------------------------

export interface ApplyAudioImportOptions {
  projectId: string;
  /**
   * id панелей проекта в момент применения. План мог устареть (панель
   * удалили, сценарий применили заново) — такие сопоставления уходят в failed,
   * иначе файл лёг бы сиротой по чужому ключу.
   */
  currentPanelIds?: Iterable<number>;
  signal?: AbortSignal;
  /** Одновременных декодов (по умолчанию 3: 5 мин WAV после декода ≈ 100 МБ). */
  concurrency?: number;
  /** Вызывается после каждого файла (записан или упал). */
  onProgress?: (done: number, total: number, file: string) => void;
  /** Вызывается сразу после записи файла — редактор сохраняет отметку «импорт». */
  onApplied?: (entry: AppliedAudio) => void;
  /** Декод → длительность, сек; бросает, если браузер не декодирует. Для тестов. */
  decode?: (data: ArrayBuffer) => Promise<number>;
  /** Оценка места в хранилище; по умолчанию navigator.storage.estimate. Для тестов. */
  estimateStorage?: () => Promise<{ usage: number; quota: number } | null>;
}

export interface AppliedAudio {
  panelId: number;
  file: string;
  /** Длительность после декода, сек (как есть, без округления). */
  duration: number;
  size: number;
}

export interface ApplyAudioImportReport {
  applied: AppliedAudio[];
  failed: Array<{ file: string; panelId?: number; reason: string }>;
  /** Не начаты из-за отмены. */
  notStarted: string[];
  aborted: boolean;
  /** Применение не начиналось (ошибки плана, нет места) — ничего не записано. */
  blocked?: string;
}

/** Запас сверх суммы размеров файлов при проверке квоты. */
const QUOTA_MARGIN_BYTES = 5 * 1024 * 1024;

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
}

/**
 * Декод для проверки и длительности. OfflineAudioContext на каждый файл: он не
 * упирается в лимит живых AudioContext (~6 в Chrome), не требует жеста
 * пользователя и не делит состояние между параллельными декодами.
 */
export async function decodeAudioDuration(data: ArrayBuffer): Promise<number> {
  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  type Ctor = new (channels: number, length: number, rate: number) => { decodeAudioData(d: ArrayBuffer): Promise<{ duration: number }> };
  const Offline = (w.OfflineAudioContext || w.webkitOfflineAudioContext) as Ctor | undefined;
  if (!Offline) throw new Error('Web Audio недоступен в этом браузере');
  const decoded = await new Offline(1, 1, 44100).decodeAudioData(data);
  return decoded.duration;
}

/**
 * Применяет план: для каждого сопоставления — декод, запись в
 * projects/{id}/audio/{panelId}.mp3 (ключ TTS; внутри исходный кодек, без
 * ресемпла и транскода — частоту приводит экспорт), удаление TTS-подписи.
 *
 * - Не больше `concurrency` декодов одновременно; каждый файл пишется сразу
 *   после своего декода (в памяти не копится вся пачка).
 * - Ошибка одного файла не останавливает остальные (→ failed).
 * - Отмена: новые файлы не начинаются (→ notStarted), уже декодированный
 *   дописывается — запись в OPFS не обрывается на середине.
 * - План с ошибками и нехватка места — blocked, ничего не пишется.
 *
 * PanelData здесь не меняется (это состояние редактора): по отчёту и
 * onApplied редактор зовёт markPanelsImported.
 */
export async function applyAudioImport(
  plan: AudioImportPlan,
  files: ReadonlyMap<string, Blob>,
  opts: ApplyAudioImportOptions,
): Promise<ApplyAudioImportReport> {
  const report: ApplyAudioImportReport = { applied: [], failed: [], notStarted: [], aborted: false };
  if (plan.errors.length > 0) {
    report.blocked = `В плане ${plan.errors.length} ${plan.errors.length === 1 ? 'ошибка' : 'ошибок'} — исправьте их перед применением`;
    return report;
  }

  const current = opts.currentPanelIds ? new Set(opts.currentPanelIds) : null;
  const jobs: Array<{ panelId: number; file: string; blob: Blob }> = [];
  for (const m of plan.matches) {
    const blob = files.get(m.file);
    if (!blob) {
      report.failed.push({ file: m.file, panelId: m.target.id, reason: 'файл не передан на применение' });
    } else if (current && !current.has(m.target.id)) {
      report.failed.push({ file: m.file, panelId: m.target.id, reason: 'панель удалена из проекта после построения плана' });
    } else {
      jobs.push({ panelId: m.target.id, file: m.file, blob });
    }
  }

  // Квота — до первого декода: либо пишем всё, либо ничего.
  const need = jobs.reduce((sum, j) => sum + j.blob.size, 0);
  if (need > 0) {
    const est = await (opts.estimateStorage ?? getOPFSUsage)().catch(() => null);
    if (est && est.quota > 0) {
      const free = Math.max(0, est.quota - est.usage);
      if (free < need + QUOTA_MARGIN_BYTES) {
        report.blocked = `Не хватает места в хранилище браузера: нужно ~${formatMb(need + QUOTA_MARGIN_BYTES)}, свободно ~${formatMb(free)}`;
        return report;
      }
    }
  }

  const decode = opts.decode ?? decodeAudioDuration;
  const total = jobs.length + report.failed.length;
  let done = report.failed.length;
  let next = 0;

  const runOne = async (job: { panelId: number; file: string; blob: Blob }) => {
    if (job.blob.size === 0) {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: 'пустой файл (0 байт)' });
      return;
    }
    let duration: number;
    try {
      duration = await decode(await job.blob.arrayBuffer());
    } catch {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: 'формат не поддержан браузером или файл повреждён' });
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: 'не удалось определить длительность — файл повреждён?' });
      return;
    }
    try {
      // Сначала подпись: файл без .sig никогда не примут за TTS с совпавшими
      // параметрами, даже если вкладка упадёт между двумя записями.
      await deleteProjectAudioSignature(opts.projectId, job.panelId);
      await saveProjectAudio(opts.projectId, job.panelId, job.blob);
    } catch (e) {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: `не удалось записать в хранилище: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const entry: AppliedAudio = { panelId: job.panelId, file: job.file, duration, size: job.blob.size };
    report.applied.push(entry);
    opts.onApplied?.(entry);
  };

  const worker = async () => {
    while (next < jobs.length) {
      if (opts.signal?.aborted) return;
      const job = jobs[next++];
      await runOne(job);
      done += 1;
      opts.onProgress?.(done, total, job.file);
    }
  };

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 3));
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  if (next < jobs.length) report.notStarted = jobs.slice(next).map(j => j.file);
  report.aborted = opts.signal?.aborted === true;
  // Порядок отчёта — порядок плана, а не завершения декодов (детерминированно).
  const order = new Map(plan.matches.map((m, i) => [m.file, i]));
  report.applied.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
  report.failed.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));
  return report;
}

/** Панели с отметкой «импорт» по применённым файлам (чистая функция). */
export function markPanelsImported<P extends { id: number; audioSource?: 'tts' | 'import'; audioFileName?: string }>(
  panels: P[],
  applied: ReadonlyArray<Pick<AppliedAudio, 'panelId' | 'file'>>,
): P[] {
  if (applied.length === 0) return panels;
  const byPanel = new Map(applied.map(a => [a.panelId, a.file]));
  return panels.map(p => (byPanel.has(p.id) ? { ...p, audioSource: 'import' as const, audioFileName: byPanel.get(p.id) } : p));
}

/** Снимает отметку «импорт» (панель переозвучена TTS). Чистая функция. */
export function clearImportMark<P extends { id: number; audioSource?: 'tts' | 'import'; audioFileName?: string }>(
  panels: P[],
  panelIds: Iterable<number>,
): P[] {
  const ids = new Set(panelIds);
  if (ids.size === 0) return panels;
  return panels.map(p => {
    if (!ids.has(p.id) || (p.audioSource === undefined && p.audioFileName === undefined)) return p;
    const rest = { ...p };
    delete rest.audioSource;
    delete rest.audioFileName;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// Режим для модалки (без ручного переключателя в этой итерации)
// ---------------------------------------------------------------------------

/**
 * Аргументы плана из состояния модалки. Есть манифест → он главный, а
 * оставшиеся файлы не раскладываются по порядку (иначе неполный манифест
 * давал бы ошибку «Файлов N, панелей M» вместо «файл не сопоставлен»).
 * Нет манифеста → имя-якорь, затем номер/порядок (приоритет planImport).
 */
export function autoImportOptions(state: {
  manifest: string;
  overwrite: boolean;
  existingAudio: Iterable<number>;
}): PlanAudioImportOptions {
  const manifest = state.manifest.trim();
  return {
    manifest: manifest || undefined,
    allowNameAnchor: true,
    useOrder: !manifest,
    overwrite: state.overwrite,
    existingAudio: state.existingAudio,
  };
}

const VIA_LABEL: Record<string, string> = {
  manual: 'вручную',
  manifest: 'по манифесту',
  name: 'по якорю в имени',
  number: 'по номеру в имени',
  order: 'по порядку имён',
};

/** «по манифесту + по якорю в имени» — чем реально сопоставлены файлы плана. */
export function describeImportMode(plan: Pick<AudioImportPlan, 'matches' | 'skipped'>): string {
  const vias = new Set([...plan.matches, ...plan.skipped].map(m => m.via));
  const order = ['manual', 'manifest', 'name', 'number', 'order'];
  const labels = order.filter(v => vias.has(v as never)).map(v => VIA_LABEL[v]);
  return labels.length > 0 ? labels.join(' + ') : '—';
}

export function importViaLabel(via: string): string {
  return VIA_LABEL[via] ?? via;
}
