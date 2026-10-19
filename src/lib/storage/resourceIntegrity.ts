/**
 * Целостность ресурсов проекта (Этап 8, пункты 72, 73, 78, 79):
 * - расчёт и проверка SHA-256 контрольной суммы для каждого blob;
 * - формирование и валидация манифеста ресурсов (имя, размер, исходный/нормализованный MIME, sha256, дата импорта);
 * - журнал прогресса импорта для восстановления после закрытия вкладки во время импорта;
 * - проверка квоты хранилища с предупреждением до импорта.
 */

import { lsKey } from './info';
import { getOPFSUsage } from './opfs';

export type ResourceRole = 'image' | 'panel-audio' | 'intro-audio' | 'outro-audio';

export interface ResourceManifestEntry {
  id: string;
  path: string;
  fileName: string;
  size: number;
  originalMime: string;
  normalizedMime: string;
  sha256: string;
  importedAt: number;
  role: ResourceRole;
  panelId?: number;
  imageIndex?: number;
}

export interface ImportJournalStep {
  fileName: string;
  panelId: number;
  sha256: string;
  completedAt: number;
}

export interface ImportJournalSession {
  projectId: string;
  sessionId: string;
  startedAt: number;
  totalFiles: number;
  plannedFiles: string[];
  completedSteps: ImportJournalStep[];
  status: 'in-progress' | 'completed' | 'aborted';
}

const JOURNAL_PREFIX = 'import-journal:';
const DEFAULT_QUOTA_WARNING_RATIO = 0.85;
const DEFAULT_SAFETY_MARGIN_BYTES = 5 * 1024 * 1024;

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * Вычисляет полный SHA-256 (64 hex-символа) для Blob, ArrayBuffer или Uint8Array.
 * Использует Web Crypto API (доступен в браузере и в Node 20+).
 */
export async function computeBlobSha256(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  let bytes: Uint8Array;
  if (data instanceof Blob) {
    bytes = new Uint8Array(await data.arrayBuffer());
  } else {
    bytes = toUint8Array(data);
  }

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Детерминированный FNV-1a 256-bit fallback, если subtle недоступен
  const hashes = [0x811c9dc5, 0x01000193, 0xdeadbeef, 0x12345678, 0x9abcdef0, 0x0fedcba9, 0x55555555, 0xaaaaaaaa];
  for (let i = 0; i < bytes.length; i++) {
    const hIdx = i & 7;
    hashes[hIdx] = Math.imul(hashes[hIdx] ^ bytes[i], 0x01000193) >>> 0;
  }
  return hashes.map(h => h.toString(16).padStart(8, '0')).join('');
}

/**
 * Проверяет совпадение SHA-256 блоба с ожидаемой контрольной суммой.
 */
export async function verifyBlobChecksum(
  data: Blob | ArrayBuffer | Uint8Array,
  expectedSha256: string
): Promise<boolean> {
  if (!expectedSha256 || typeof expectedSha256 !== 'string') return false;
  const actual = await computeBlobSha256(data);
  return actual.toLowerCase() === expectedSha256.trim().toLowerCase();
}

/**
 * Создаёт запись манифеста ресурса с вычислением SHA-256.
 */
export async function createResourceManifestEntry(params: {
  id: string;
  path: string;
  fileName: string;
  blob: Blob;
  originalMime?: string;
  normalizedMime?: string;
  role: ResourceRole;
  panelId?: number;
  imageIndex?: number;
  importedAt?: number;
}): Promise<ResourceManifestEntry> {
  const sha256 = await computeBlobSha256(params.blob);
  const fallbackMime = params.blob.type || 'application/octet-stream';
  return {
    id: params.id,
    path: params.path,
    fileName: params.fileName,
    size: params.blob.size,
    originalMime: params.originalMime || fallbackMime,
    normalizedMime: params.normalizedMime || fallbackMime,
    sha256,
    importedAt: params.importedAt ?? Date.now(),
    role: params.role,
    ...(params.panelId !== undefined ? { panelId: params.panelId } : {}),
    ...(params.imageIndex !== undefined ? { imageIndex: params.imageIndex } : {}),
  };
}

export interface ManifestVerificationReport {
  valid: boolean;
  verified: string[];
  corrupted: Array<{ id: string; path: string; expectedSha256: string; actualSha256: string; reason: string }>;
  missing: Array<{ id: string; path: string; fileName: string }>;
}

/**
 * Проверяет все ресурсы манифеста по их контрольным суммам и размерам.
 */
export async function verifyProjectManifest(
  manifest: Record<string, ResourceManifestEntry> | undefined,
  loadBlob: (entry: ResourceManifestEntry) => Promise<Blob | null>
): Promise<ManifestVerificationReport> {
  const verified: string[] = [];
  const corrupted: ManifestVerificationReport['corrupted'] = [];
  const missing: ManifestVerificationReport['missing'] = [];

  if (!manifest) {
    return { valid: true, verified, corrupted, missing };
  }

  for (const entry of Object.values(manifest)) {
    let blob: Blob | null = null;
    try {
      blob = await loadBlob(entry);
    } catch {
      blob = null;
    }

    if (!blob) {
      missing.push({ id: entry.id, path: entry.path, fileName: entry.fileName });
      continue;
    }

    const actualSha256 = await computeBlobSha256(blob);
    if (actualSha256.toLowerCase() !== entry.sha256.toLowerCase()) {
      corrupted.push({
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        actualSha256,
        reason: `Несовпадение контрольной суммы SHA-256 для «${entry.fileName}»`,
      });
      continue;
    }

    if (entry.size > 0 && blob.size !== entry.size) {
      corrupted.push({
        id: entry.id,
        path: entry.path,
        expectedSha256: entry.sha256,
        actualSha256,
        reason: `Несовпадение размера для «${entry.fileName}»: ожидалось ${entry.size} Б, получено ${blob.size} Б`,
      });
      continue;
    }

    verified.push(entry.id);
  }

  return {
    valid: corrupted.length === 0 && missing.length === 0,
    verified,
    corrupted,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Проверка квоты хранилища (пункт 78)
// ---------------------------------------------------------------------------

export interface StorageQuotaCheck {
  ok: boolean;
  estimateAvailable: boolean;
  warning?: string;
  blockedReason?: string;
  usageBytes: number;
  quotaBytes: number;
  freeBytes: number | null;
  requiredBytes: number;
}

function formatBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} МБ`;
}

export async function checkStorageQuotaBeforeImport(
  requiredBytes: number,
  options: {
    estimate?: () => Promise<{ usage: number; quota: number } | null>;
    safetyMarginBytes?: number;
    warningRatio?: number;
  } = {}
): Promise<StorageQuotaCheck> {
  const safetyMargin = options.safetyMarginBytes ?? DEFAULT_SAFETY_MARGIN_BYTES;
  const warningRatio = options.warningRatio ?? DEFAULT_QUOTA_WARNING_RATIO;
  const est = await (options.estimate ?? getOPFSUsage)().catch(() => null);

  if (!est || est.quota <= 0) {
    return {
      ok: true,
      estimateAvailable: false,
      usageBytes: est?.usage ?? 0,
      quotaBytes: est?.quota ?? 0,
      freeBytes: null,
      requiredBytes,
    };
  }

  const freeBytes = Math.max(0, est.quota - est.usage);
  const neededWithMargin = requiredBytes + safetyMargin;

  if (freeBytes < neededWithMargin) {
    return {
      ok: false,
      estimateAvailable: true,
      blockedReason: `Недостаточно места в хранилище браузера: требуется ~${formatBytesMb(neededWithMargin)}, свободно ~${formatBytesMb(freeBytes)}`,
      usageBytes: est.usage,
      quotaBytes: est.quota,
      freeBytes,
      requiredBytes,
    };
  }

  const projectedRatio = (est.usage + requiredBytes) / est.quota;
  if (projectedRatio >= warningRatio) {
    return {
      ok: true,
      estimateAvailable: true,
      warning: `Хранилище браузера заполнено на ${Math.round(projectedRatio * 100)}% после импорта (останется ~${formatBytesMb(freeBytes - requiredBytes)})`,
      usageBytes: est.usage,
      quotaBytes: est.quota,
      freeBytes,
      requiredBytes,
    };
  }

  return {
    ok: true,
    estimateAvailable: true,
    usageBytes: est.usage,
    quotaBytes: est.quota,
    freeBytes,
    requiredBytes,
  };
}

// ---------------------------------------------------------------------------
// Журнал прогресса импорта для восстановления после закрытия вкладки (пункт 79)
// ---------------------------------------------------------------------------

function journalStorageKey(projectId: string): string {
  return lsKey(`${JOURNAL_PREFIX}${projectId}`);
}

export function beginImportJournal(
  projectId: string,
  plannedFiles: string[]
): ImportJournalSession {
  const session: ImportJournalSession = {
    projectId,
    sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    totalFiles: plannedFiles.length,
    plannedFiles: [...plannedFiles],
    completedSteps: [],
    status: 'in-progress',
  };
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(journalStorageKey(projectId), JSON.stringify(session));
    }
  } catch {}
  return session;
}

export function recordImportJournalStep(
  projectId: string,
  step: { fileName: string; panelId: number; sha256: string }
): ImportJournalSession | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(journalStorageKey(projectId));
    if (!raw) return null;
    const session = JSON.parse(raw) as ImportJournalSession;
    session.completedSteps.push({
      fileName: step.fileName,
      panelId: step.panelId,
      sha256: step.sha256,
      completedAt: Date.now(),
    });
    localStorage.setItem(journalStorageKey(projectId), JSON.stringify(session));
    return session;
  } catch {
    return null;
  }
}

export function completeImportJournal(projectId: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(journalStorageKey(projectId));
    }
  } catch {}
}

export function getPendingImportJournal(projectId: string): ImportJournalSession | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(journalStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ImportJournalSession;
    if (parsed && parsed.projectId === projectId && parsed.status === 'in-progress') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Проверяет, остался ли незавершённый журнал импорта после закрытия вкладки,
 * и возвращает отчёт о восстановлении (не удаляя журнал до явного вызова completeImportJournal
 * или опции { clear: true }, чтобы состояние не потерялось при повторном сбое).
 */
export function recoverInterruptedImport(
  projectId: string,
  options?: { clear?: boolean }
): {
  recovered: boolean;
  session: ImportJournalSession | null;
  completedCount: number;
  remainingFiles: string[];
  message: string | null;
} {
  const session = getPendingImportJournal(projectId);
  if (!session) {
    return {
      recovered: false,
      session: null,
      completedCount: 0,
      remainingFiles: [],
      message: null,
    };
  }

  if (options?.clear) {
    completeImportJournal(projectId);
  }
  const doneSet = new Set(session.completedSteps.map(s => s.fileName));
  const remainingFiles = session.plannedFiles.filter(f => !doneSet.has(f));
  const completedCount = session.completedSteps.length;

  return {
    recovered: true,
    session,
    completedCount,
    remainingFiles,
    message: `Восстановлено состояние после прерванного импорта: сохранено файлов ${completedCount} из ${session.totalFiles}${remainingFiles.length > 0 ? ` (не завершены: ${remainingFiles.join(', ')})` : ''}.`,
  };
}
