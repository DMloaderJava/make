/**
 * Импорт внешних аудиофайлов на изображения по якорям (v1.3.18).
 *
 * Этот модуль — доменная обёртка над planImport: цели = реплики панелей,
 * но номер файла означает номер изображения, якорь =
 * заголовок serializeScenario («Изображение 1 [0..30%]»), порядок = тот же,
 * что в «Скопировать с якорями» ((order, imageIndex), затем id).
 *
 * planAudioImport — чистая функция (пересчитывается на каждый ререндер
 * модалки). applyAudioImport — применение: декод (проверка + длительность),
 * запись в OPFS по ключу TTS, отчёт. markPanelsImported — чистая отметка
 * панелей по отчёту (её зовёт редактор, в т.ч. после каждого файла).
 *
 * Дополнено по ТЗ (Этап 2 п. 11–20, Этап 3 п. 21, 23, 24):
 * - разделение `panelNumber` (номер реплики) и `imageNumber` (номер изображения);
 * - предварительная диагностическая таблица плана импорта (`buildAudioImportPreviewRows`);
 * - пред-декод и SHA-256 проверка файлов (`inspectFilesBeforeAudioImport`);
 * - выборочный повторный импорт отмеченных файлов (`selectedFiles`);
 * - откат последнего импорта (`createAudioImportUndoSnapshot`, `undoLastAudioImport`);
 * - определение MIME по magic bytes и сохранение `audioOriginalMime` / `audioNormalizedMime`.
 */

import type { PanelData } from './extractPanels';
import type { SyncTimeline } from '../storage/db';
import {
  deleteProjectAudio,
  deleteProjectAudioSignature,
  getOPFSUsage,
  loadProjectAudio,
  readFile,
  saveProjectAudio,
  writeFile,
} from '../storage/opfs';
import { fileExtension, planImport, type ImportFileRef, type ImportPlan, type ImportVia } from './importPlan';
import { panelAnchor } from './scenarioFormat';
import { computeBlobSha256 } from '../storage/resourceIntegrity';
import { normalizeAudioBlobMime } from '../providers/tts/mime';

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

export interface PanelAudioTargetInfo {
  panelId: number;
  /** 1-based порядковый номер панели (реплики) в сценарии (Этап 2 п. 12). */
  panelNumber: number;
  /** 1-based номер исходного изображения (`panel.imageIndex + 1`) (Этап 2 п. 12). */
  imageNumber: number;
  anchor: string;
  label: string;
  /** Подпись с явным разделением номера панели и номера изображения для UI. */
  detailedLabel: string;
}

/**
 * Возвращает сведения о целевой панели с явным разделением
 * «номера панели» (`panelNumber`) и «номера изображения» (`imageNumber`) (Этап 2 п. 12).
 */
export function getPanelAudioTargetInfo(
  panel: PanelData,
  indexInOrder: number
): PanelAudioTargetInfo {
  const panelNumber = indexInOrder + 1;
  const imageNumber = panel.imageIndex + 1;
  const anchor = panelAnchor(panel);
  const label = audioTargetLabel(panel);
  return {
    panelId: panel.id,
    panelNumber,
    imageNumber,
    anchor,
    label,
    detailedLabel: `Панель №${panelNumber} · ${label}`,
  };
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
  /** Не блокировать импорт из-за лишних файлов с повторным/вне диапазона номером. */
  ignoreUnmatchedNumbers?: boolean;
  /**
   * Повторный импорт только выбранных файлов без сброса остальных (Этап 2 п. 19).
   */
  selectedFiles?: Iterable<string>;
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
  const selectedSet = opts.selectedFiles
    ? new Set(Array.from(opts.selectedFiles, s => s.normalize('NFC').trim().toLowerCase()))
    : null;
  const candidateFiles = selectedSet
    ? files.filter(f => selectedSet.has(f.name.normalize('NFC').trim().toLowerCase()))
    : files;

  const audioFiles: ImportFileRef[] = [];
  for (const f of candidateFiles) {
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
    // Обычная нумерация должна идти по репликам, а не по изображениям:
    // у одного изображения может быть несколько панелей.
    // Обычное имя `1.mp3` означает первую реплику/панель. Привязка к
    // изображению выполняется только явно: `Изображение 2.mp3` или якорем
    // `[30..60%]`. Иначе несколько реплик одного изображения получают один
    // и тот же номер и дорожки начинают попадать не в ту панель.
    targetNumber: (_p, index) => (index ?? 0) + 1,
    manifest: opts.manifest,
    manualOverrides: opts.manualOverrides,
    allowNameAnchor: opts.allowNameAnchor,
    useOrder: opts.useOrder,
    ignoreUnmatchedNumbers: opts.ignoreUnmatchedNumbers,
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
// Предварительный план импорта (Этап 2 п. 11, 12, 16–18)
// ---------------------------------------------------------------------------

export interface AudioImportPreviewRow {
  file: string;
  status: 'matched' | 'skipped' | 'excluded' | 'error';
  via?: ImportVia;
  panelId?: number;
  panelNumber?: number;
  imageNumber?: number;
  targetLabel?: string;
  duration?: number;
  sha256?: string;
  reason?: string;
}

/**
 * Формирует предварительный план импорта (файл → целевая панель → способ сопоставления → причина исключения)
 * до записи файлов в OPFS (Этап 2 п. 11, 12).
 */
export function buildAudioImportPreviewRows(
  files: readonly ImportFileRef[],
  panels: readonly PanelData[],
  plan: AudioImportPlan
): AudioImportPreviewRow[] {
  const sortedPanels = [...panels].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.imageIndex - b.imageIndex || a.id - b.id
  );
  const infoById = new Map<number, PanelAudioTargetInfo>();
  sortedPanels.forEach((p, idx) => {
    infoById.set(p.id, getPanelAudioTargetInfo(p, idx));
  });

  const fileMetaByKey = new Map<string, ImportFileRef>();
  for (const f of files) {
    const k = f.name.normalize('NFC').trim().toLowerCase();
    if (!fileMetaByKey.has(k)) fileMetaByKey.set(k, f);
  }

  const rows: AudioImportPreviewRow[] = [];
  const handled = new Set<string>();

  for (const m of plan.matches) {
    const k = m.file.normalize('NFC').trim().toLowerCase();
    handled.add(k);
    const meta = fileMetaByKey.get(k);
    const info = infoById.get(m.target.id);
    rows.push({
      file: m.file,
      status: 'matched',
      via: m.via,
      panelId: m.target.id,
      panelNumber: info?.panelNumber,
      imageNumber: info?.imageNumber ?? (m.target.imageIndex + 1),
      targetLabel: info?.detailedLabel ?? m.label,
      duration: meta?.duration,
      sha256: meta?.sha256,
    });
  }

  for (const s of plan.skipped) {
    const k = s.file.normalize('NFC').trim().toLowerCase();
    handled.add(k);
    const meta = fileMetaByKey.get(k);
    const info = infoById.get(s.target.id);
    rows.push({
      file: s.file,
      status: 'skipped',
      via: s.via,
      panelId: s.target.id,
      panelNumber: info?.panelNumber,
      imageNumber: info?.imageNumber ?? (s.target.imageIndex + 1),
      targetLabel: info?.detailedLabel ?? s.label,
      duration: meta?.duration,
      sha256: meta?.sha256,
      reason: 'У панели уже есть аудио (включите «Перезаписать»)',
    });
  }

  for (const u of plan.unmatchedFiles) {
    const k = u.normalize('NFC').trim().toLowerCase();
    handled.add(k);
    const meta = fileMetaByKey.get(k);
    const specificErr = plan.errors.find(e => e.includes(`«${u}»`));
    const specificWarn = plan.warnings.find(w => w.includes(`«${u}»`));
    rows.push({
      file: u,
      status: specificErr ? 'error' : 'excluded',
      duration: meta?.duration,
      sha256: meta?.sha256,
      reason: specificErr || specificWarn || 'Файл не сопоставлен ни с одной панелью',
    });
  }

  for (const f of files) {
    const k = f.name.normalize('NFC').trim().toLowerCase();
    if (handled.has(k)) continue;
    handled.add(k);
    const specificErr = plan.errors.find(e => e.includes(`«${f.name}»`));
    rows.push({
      file: f.name,
      status: 'error',
      duration: f.duration,
      sha256: f.sha256,
      reason: f.decodeError
        ? `Ошибка декодирования: ${f.decodeError}`
        : specificErr || 'Файл отклонён при проверке',
    });
  }

  return rows;
}

/**
 * Предварительно декодирует выбранные файлы и считает SHA-256 до применения плана
 * (Этап 2 п. 16, 17, 18):
 * - заполняет `duration` каждого файла для отображения в таблице плана;
 * - помечает недекодируемые файлы (`decodeError`) ДО нажатия «Применить»;
 * - заполняет `sha256` для обнаружения дубликатов содержимого.
 */
export async function inspectFilesBeforeAudioImport(
  files: ReadonlyMap<string, Blob> | ReadonlyArray<{ name: string; blob: Blob }>,
  options?: {
    decode?: (data: ArrayBuffer) => Promise<number>;
    computeHash?: boolean;
  }
): Promise<ImportFileRef[]> {
  const decodeFn = options?.decode ?? decodeAudioDuration;
  const computeHash = options?.computeHash ?? true;
  const entries: Array<{ name: string; blob: Blob }> = Array.isArray(files)
    ? files
    : Array.from((files as ReadonlyMap<string, Blob>).entries(), ([name, blob]) => ({ name, blob }));

  const refs: ImportFileRef[] = [];
  for (const { name, blob } of entries) {
    if (!blob || blob.size === 0) {
      refs.push({ name, size: 0, decodeError: 'файл пуст (0 байт)' });
      continue;
    }
    try {
      const ab = await blob.arrayBuffer();
      const sha256 = computeHash ? await computeBlobSha256(ab) : undefined;
      const duration = await decodeFn(ab.slice(0));
      if (!Number.isFinite(duration) || duration <= 0) {
        refs.push({
          name,
          size: blob.size,
          sha256,
          decodeError: 'не удалось определить длительность',
        });
      } else {
        refs.push({
          name,
          size: blob.size,
          sha256,
          duration,
        });
      }
    } catch (e) {
      refs.push({
        name,
        size: blob.size,
        decodeError: e instanceof Error && e.message ? e.message : 'формат не поддержан браузером',
      });
    }
  }
  return refs;
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
  /** Сохранять резервную копию старого аудио в OPFS для `undoLastAudioImport` (Этап 2 п. 20). */
  enableUndoBackup?: boolean;
  /** Включать ли `originalMime` и `normalizedMime` в `AppliedAudio` (Этап 3 п. 24). */
  includeMimeMetadata?: boolean;
}

export interface AppliedAudio {
  panelId: number;
  file: string;
  /** Длительность после декода, сек (как есть, без округления). */
  duration: number;
  size: number;
  originalMime?: string;
  normalizedMime?: string;
  sha256?: string;
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
  const total = jobs.length;
  let next = 0;
  let done = 0;

  const runOne = async (job: typeof jobs[number]) => {
    if (job.blob.size === 0) {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: 'пустой файл (0 байт)' });
      return;
    }
    let duration: number;
    let originalMime: string | undefined;
    let normalizedMime: string | undefined;
    try {
      const buf = await job.blob.arrayBuffer();
      if (opts.includeMimeMetadata) {
        const mimeInfo = await normalizeAudioBlobMime(job.blob, buf);
        originalMime = mimeInfo.originalMime;
        normalizedMime = mimeInfo.normalizedMime;
      }
      duration = await decode(buf);
    } catch {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: 'формат не поддержан браузером или файл повреждён' });
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: 'не удалось определить длительность' });
      return;
    }
    try {
      if (opts.enableUndoBackup) {
        try {
          const prevAudio = await loadProjectAudio(opts.projectId, job.panelId);
          if (prevAudio) {
            await writeFile(['projects', opts.projectId, 'audio-undo'], `${job.panelId}.mp3`, prevAudio);
          }
        } catch {}
      }
      // Сначала убираем старую .sig, потом пишем аудио: если .sig не удаляется
      // (не NotFoundError), новый файл НЕ пишем — иначе за импортированным
      // аудио останется чужая подпись и его примут за TTS с совпавшими
      // параметрами, даже если вкладка упадёт между двумя записями.
      await deleteProjectAudioSignature(opts.projectId, job.panelId);
      await saveProjectAudio(opts.projectId, job.panelId, job.blob);
    } catch (e) {
      report.failed.push({ file: job.file, panelId: job.panelId, reason: `не удалось записать в хранилище: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const entry: AppliedAudio = opts.includeMimeMetadata
      ? { panelId: job.panelId, file: job.file, duration, size: job.blob.size, originalMime, normalizedMime }
      : { panelId: job.panelId, file: job.file, duration, size: job.blob.size };
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
export function markPanelsImported<
  P extends {
    id: number;
    audioSource?: 'tts' | 'import';
    audioFileName?: string;
    audioOriginalMime?: string;
    audioNormalizedMime?: string;
    audioSha256?: string;
  }
>(
  panels: P[],
  applied: ReadonlyArray<
    Pick<AppliedAudio, 'panelId' | 'file'> & {
      originalMime?: string;
      normalizedMime?: string;
      sha256?: string;
    }
  >,
): P[] {
  if (applied.length === 0) return panels;
  const byPanel = new Map(applied.map(a => [a.panelId, a]));
  return panels.map(p => {
    const hit = byPanel.get(p.id);
    if (!hit) return p;
    const next: P = { ...p, audioSource: 'import' as const, audioFileName: hit.file };
    if (hit.originalMime !== undefined) next.audioOriginalMime = hit.originalMime;
    if (hit.normalizedMime !== undefined) next.audioNormalizedMime = hit.normalizedMime;
    if (hit.sha256 !== undefined) next.audioSha256 = hit.sha256;
    return next;
  });
}

/** Снимает отметку «импорт» (панель переозвучена TTS). Чистая функция. */
export function clearImportMark<
  P extends {
    id: number;
    audioSource?: 'tts' | 'import';
    audioFileName?: string;
    audioOriginalMime?: string;
    audioNormalizedMime?: string;
    audioSha256?: string;
  }
>(
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
    delete rest.audioOriginalMime;
    delete rest.audioNormalizedMime;
    delete rest.audioSha256;
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
  manualOverrides?: ReadonlyMap<string, string>;
  selectedFiles?: Iterable<string>;
}): PlanAudioImportOptions {
  const manifest = state.manifest.trim();
  return {
    manifest: manifest || undefined,
    allowNameAnchor: true,
    useOrder: !manifest,
    // В папке с экспортом часто остаются дубли или файлы следующей главы.
    // Их безопаснее исключить из текущего импорта, чем блокировать всю пачку.
    ignoreUnmatchedNumbers: !manifest,
    overwrite: state.overwrite,
    existingAudio: state.existingAudio,
    manualOverrides: state.manualOverrides,
    selectedFiles: state.selectedFiles,
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
  return labels.length > 0 ? labels.join(' + ') : 'нет совпадений';
}

/**
 * Брошенный в модалку .txt-манифест → текст манифеста. Тот же файл повторно
 * (или такой же текст под другим именем) не дублируется — иначе дубли якорей
 * дали бы ошибку плана без видимой причины; новая версия файла с тем же
 * именем заменяет свой прежний блок, если пользователь его не правил.
 */
export function mergeManifestText(current: string, text: string, previousFromSameFile?: string): string {
  const block = text.trim();
  if (!block) return current;
  const prev = previousFromSameFile?.trim();
  if (prev && current.includes(prev)) return current.replace(prev, block);
  if (current.includes(block)) return current;
  return [current.trim(), block].filter(Boolean).join('\n');
}

export function importViaLabel(via: string): string {
  return VIA_LABEL[via] ?? via;
}

// ---------------------------------------------------------------------------
// Редактор: сохранение по ходу импорта и слияние результата (чистая логика
// handleImportAudio — вынесена сюда, чтобы покрыть тестами без браузера)
// ---------------------------------------------------------------------------

type ImportableProject = { panels: PanelData[]; audioDurations?: Record<number, number> };

/**
 * Сохраняет отметку «импорт» после КАЖДОГО записанного файла: падение вкладки
 * на 4-м файле оставит в IDB 3 отмеченные панели, а не файлы без отметки,
 * которые «Озвучить всё» приняло бы за аудио без подписи (легаси-путь).
 *
 * Сохранения идут строго по очереди (applyAudioImport пишет параллельно, а
 * onApplied приходит в порядке завершения), каждое — полный накопленный
 * снимок от исходного проекта, поэтому последнее сохранение = итог. Ошибка
 * одного сохранения не рвёт цепочку: следующее запишет всё накопленное.
 */
export function createImportPersister<T extends ImportableProject>(opts: {
  snapshot: T;
  save: (project: T) => Promise<unknown>;
  onSaveError?: (error: unknown) => void;
}) {
  const applied: AppliedAudio[] = [];
  const base = { ...(opts.snapshot.audioDurations ?? {}) };
  let chain: Promise<void> = Promise.resolve();

  const projectWith = (entries: readonly AppliedAudio[]): T => {
    const audioDurations = { ...base };
    for (const a of entries) audioDurations[a.panelId] = a.duration;
    return { ...opts.snapshot, panels: markPanelsImported(opts.snapshot.panels, entries), audioDurations };
  };

  return {
    onApplied(entry: AppliedAudio) {
      applied.push(entry);
      const next = projectWith([...applied]);
      chain = chain.then(() => opts.save(next)).then(() => undefined).catch((e) => opts.onSaveError?.(e));
    },
    /** Дождаться последнего сохранения. Никогда не отклоняется. */
    flush(): Promise<void> {
      return chain;
    },
    get applied(): readonly AppliedAudio[] {
      return applied;
    },
  };
}

/**
 * Слияние отчёта импорта с аудио редактора: новые Map (старые не мутируются),
 * отмеченные панели, длительности объектом для проекта и «реальные»
 * длительности для rebuildSrt (только панели, у которых есть аудио — иначе
 * SRT считался бы финальным при неозвученных панелях).
 */
export function mergeAppliedAudio(params: {
  panels: PanelData[];
  applied: readonly AppliedAudio[];
  files: ReadonlyMap<string, Blob>;
  blobs: ReadonlyMap<number, Blob>;
  full: ReadonlyMap<number, { blob: Blob; duration: number }>;
  durations: ReadonlyMap<number, number>;
}) {
  const blobs = new Map(params.blobs);
  const full = new Map(params.full);
  const durations = new Map(params.durations);
  const used: AppliedAudio[] = [];
  for (const a of params.applied) {
    const blob = params.files.get(a.file);
    if (!blob) continue; // не бывает: applyAudioImport пишет только переданные файлы
    blobs.set(a.panelId, blob);
    full.set(a.panelId, { blob, duration: a.duration });
    durations.set(a.panelId, a.duration);
    used.push(a);
  }
  const durationsObj: Record<number, number> = {};
  durations.forEach((v, k) => { durationsObj[k] = v; });
  const realDurations: Record<number, number> = {};
  blobs.forEach((_, k) => { const d = durations.get(k); if (d !== undefined) realDurations[k] = d; });
  return { blobs, full, durations, durationsObj, realDurations, panels: markPanelsImported(params.panels, used) };
}

/**
 * Итог явной переозвучки (forceRegenerate). Отметка «импорт» снимается только
 * там, где TTS реально записал новый файл. Редактор импортированный файл
 * заранее НЕ удаляет (forceRegenerate его и так не читает, а успешный синтез
 * перезаписывает), поэтому при упавшем синтезе файл пользователя цел — и
 * ошибка генератора дополняется этим фактом, чтобы «↻» не выглядела как
 * потеря записи.
 */
export function settleImportRegeneration(params: {
  panels: PanelData[];
  regeneratedIds: Iterable<number>;
  succeededIds: Iterable<number>;
  errors: readonly string[];
}): { panels: PanelData[]; errors: string[] } {
  const succeeded = new Set(params.succeededIds);
  const regenerated = [...new Set(params.regeneratedIds)];
  const byId = new Map(params.panels.map(p => [p.id, p]));
  const keptImports = regenerated.filter(id => !succeeded.has(id) && byId.get(id)?.audioSource === 'import');
  const errors = [...params.errors];
  for (const id of keptImports) {
    const name = byId.get(id)?.audioFileName;
    const kept = `импортированный файл${name ? ` «${name}»` : ''} оставлен без изменений`;
    const prefix = `Панель ${id}: `;
    const at = errors.findIndex(e => e.startsWith(prefix));
    if (at >= 0) errors[at] = `${prefix}переозвучка не удалась (${errors[at].slice(prefix.length)}) — ${kept}`;
    else errors.push(`${prefix}переозвучка не удалась — ${kept}`);
  }
  return {
    panels: clearImportMark(params.panels, regenerated.filter(id => succeeded.has(id))),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Отмена последнего импорта аудио (Этап 2 п. 20)
// ---------------------------------------------------------------------------

export interface LastAudioImportSnapshot {
  projectId: string;
  createdAt: number;
  previousPanels: PanelData[];
  previousAudioDurations: Record<number, number>;
  previousTimeline: SyncTimeline[];
  previousSrt: string;
  previouslyVoicedPanelIds: number[];
  importedPanelIds: number[];
  previousBlobs: Map<number, Blob>;
}

/**
 * Создаёт снимок состояния перед импортом аудио, чтобы кнопка «Отменить последний импорт»
 * могла вернуть предыдущие метаданные и аудио-блобы один в один (Этап 2 п. 20).
 */
export async function createAudioImportUndoSnapshot(params: {
  projectId: string;
  panels: readonly PanelData[];
  audioDurations?: Record<number, number>;
  timeline?: readonly SyncTimeline[];
  srt?: string;
  existingBlobs?: ReadonlyMap<number, Blob>;
  targetPanelIds?: Iterable<number>;
}): Promise<LastAudioImportSnapshot> {
  const {
    projectId,
    panels,
    audioDurations = {},
    timeline = [],
    srt = '',
    existingBlobs,
    targetPanelIds,
  } = params;

  const previousBlobs = new Map<number, Blob>();
  const previouslyVoicedPanelIds: number[] = [];

  if (existingBlobs) {
    for (const [id, blob] of existingBlobs.entries()) {
      previouslyVoicedPanelIds.push(id);
      previousBlobs.set(id, blob);
    }
  } else if (targetPanelIds) {
    for (const id of targetPanelIds) {
      const b = await loadProjectAudio(projectId, id);
      if (b) {
        previouslyVoicedPanelIds.push(id);
        previousBlobs.set(id, b);
      }
    }
  }

  return {
    projectId,
    createdAt: Date.now(),
    previousPanels: panels.map(p => ({ ...p, bbox: { ...p.bbox } })),
    previousAudioDurations: { ...audioDurations },
    previousTimeline: timeline.map(s => ({ ...s })),
    previousSrt: srt,
    previouslyVoicedPanelIds,
    importedPanelIds: targetPanelIds ? Array.from(targetPanelIds) : [],
    previousBlobs,
  };
}

/**
 * Восстанавливает состояние проекта и OPFS-файлы до последнего импорта аудио (Этап 2 п. 20).
 */
export async function undoLastAudioImport(
  snapshot: LastAudioImportSnapshot,
  appliedPanelIds?: Iterable<number>
): Promise<{
  panels: PanelData[];
  audioDurations: Record<number, number>;
  timeline: SyncTimeline[];
  srt: string;
  restoredBlobs: Map<number, Blob>;
}> {
  const idsToRevert = new Set<number>(appliedPanelIds ?? snapshot.importedPanelIds);
  const hadAudioBefore = new Set<number>(snapshot.previouslyVoicedPanelIds);

  for (const panelId of idsToRevert) {
    const memBackup = snapshot.previousBlobs.get(panelId);
    if (memBackup) {
      await saveProjectAudio(snapshot.projectId, panelId, memBackup);
      continue;
    }
    let opfsBackup: Blob | null = null;
    try {
      opfsBackup = await readFile(['projects', snapshot.projectId, 'audio-undo'], `${panelId}.mp3`);
    } catch {
      opfsBackup = null;
    }
    if (opfsBackup) {
      await saveProjectAudio(snapshot.projectId, panelId, opfsBackup);
      snapshot.previousBlobs.set(panelId, opfsBackup);
      continue;
    }
    if (!hadAudioBefore.has(panelId)) {
      await deleteProjectAudio(snapshot.projectId, panelId);
    }
  }

  return {
    panels: snapshot.previousPanels.map(p => ({ ...p, bbox: { ...p.bbox } })),
    audioDurations: { ...snapshot.previousAudioDurations },
    timeline: snapshot.previousTimeline.map(s => ({ ...s })),
    srt: snapshot.previousSrt,
    restoredBlobs: new Map(snapshot.previousBlobs),
  };
}

/**
 * Явное правило выбора файлов при добавлении новой пачки в модальное окно импорта
 * (Итерация 2.1, P1 п. 10):
 * - каждый новый добавленный файл автоматически помечается выбранным;
 * - если до добавления стоял `selectAll = true`, все прежние + новые файлы остаются выбранными (`selectAll = true`);
 * - если пользователь ранее снимал выбор с отдельных файлов (`selectAll = false`), прежние отметки сохраняются,
 *   новые файлы добавляются в `selectedFileNames`, а `selectAll` пересчитывается по полному совпадению.
 */
export function mergeAddedAudioImportSelection<T extends { name: string }>(params: {
  prevFiles: readonly T[];
  prevSelected: ReadonlySet<string>;
  prevSelectAll: boolean;
  incomingAudio: readonly T[];
}): {
  mergedFiles: T[];
  selectedFileNames: Set<string>;
  selectAll: boolean;
} {
  const { prevFiles, prevSelected, prevSelectAll, incomingAudio } = params;
  const incomingNames = new Set(incomingAudio.map(f => f.name.normalize('NFC')));
  const mergedFiles = [
    ...prevFiles.filter(f => !incomingNames.has(f.name.normalize('NFC'))),
    ...incomingAudio,
  ];
  const selectedFileNames = new Set<string>(
    prevSelectAll ? prevFiles.map(f => f.name) : prevSelected
  );
  for (const f of incomingAudio) {
    selectedFileNames.add(f.name);
  }
  const selectAll =
    mergedFiles.length > 0 && mergedFiles.every(f => selectedFileNames.has(f.name));
  return {
    mergedFiles,
    selectedFileNames,
    selectAll,
  };
}

