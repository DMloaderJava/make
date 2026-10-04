/**
 * Unified namespace mvs-info for all persistent data
 * - OPFS: /mvs-info/projects/, /mvs-info/tts-cache/
 * - localStorage: mvs-info:keys, mvs-info:settings, etc.
 * - IndexedDB: mvs-info
 */

export const INFO_NAMESPACE = 'mvs-info';
export const INFO_OPFS_ROOT = 'mvs-info';
export const INFO_IDB_NAME = 'mvs-info';
export const INFO_LS_PREFIX = 'mvs-info:';

export function lsKey(name: string): string {
  return `${INFO_LS_PREFIX}${name}`;
}

// Known LS keys (new)
export const LS_KEYS = {
  KEYS: lsKey('keys'),
  SETTINGS: lsKey('settings'),
  CUSTOM_LLM: lsKey('custom-llm-config'),
  MIGRATION_DONE: lsKey('migration-v1-done'),
} as const;

// Old keys for migration
const OLD_LS_KEYS = {
  KEYS: 'manga-voice-keys',
  SETTINGS: 'manga-voice-settings',
  CUSTOM: 'custom-llm-config',
} as const;

const OLD_IDB_NAME = 'manga-voice-db';
const OLD_OPFS_DIRS = ['projects', 'tts-cache'];

function isLocalStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function getAllLocalStorageKeysWithPrefix(prefix: string): string[] {
  if (!isLocalStorageAvailable()) return [];
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) out.push(k);
  }
  return out;
}

async function getOPFSRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !(navigator.storage as any)?.getDirectory) return null;
    return await (navigator.storage as any).getDirectory();
  } catch {
    return null;
  }
}


async function deleteOPFSPath(path: string[]): Promise<void> {
  const root = await getOPFSRoot();
  if (!root) return;
  try {
    if (path.length === 1) {
      await root.removeEntry(path[0], { recursive: true } as any);
    } else {
      // navigate to parent
      let dir = root;
      for (let i = 0; i < path.length - 1; i++) {
        dir = await dir.getDirectoryHandle(path[i]);
      }
      await dir.removeEntry(path[path.length - 1], { recursive: true } as any);
    }
  } catch {}
}

async function listAllOPFSFilesRecursive(dir: FileSystemDirectoryHandle, basePath: string, out: Array<{ path: string; handle: FileSystemFileHandle }>): Promise<void> {
  // @ts-ignore
  for await (const [name, handle] of (dir as any).entries()) {
    const fullPath = basePath ? `${basePath}/${name}` : name;
    if ((handle as any).kind === 'file') {
      out.push({ path: fullPath, handle: handle as FileSystemFileHandle });
    } else if ((handle as any).kind === 'directory') {
      await listAllOPFSFilesRecursive(handle as FileSystemDirectoryHandle, fullPath, out);
    }
  }
}

async function readFileAsBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function writeBase64ToFile(dir: FileSystemDirectoryHandle, fileName: string, base64: string): Promise<void> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await (fileHandle as any).createWritable();
  await writable.write(bytes);
  await writable.close();
}

/** Полная очистка: localStorage + IDB + OPFS. Необратимо. */
export async function clearAllInfo(): Promise<void> {
  // LS
  if (isLocalStorageAvailable()) {
    const toDelete = getAllLocalStorageKeysWithPrefix(INFO_LS_PREFIX);
    for (const k of toDelete) localStorage.removeItem(k);
    // Also clean old keys if any left
    for (const k of Object.values(OLD_LS_KEYS)) {
      try { localStorage.removeItem(k); } catch {}
    }
    // taskqueue- old prefix
    const allKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) allKeys.push(k);
    }
    for (const k of allKeys) {
      if (k.startsWith('taskqueue-')) {
        try { localStorage.removeItem(k); } catch {}
      }
    }
  }

  // IDB: сначала закрываем своё соединение (dbPromise в db.ts), иначе
  // deleteDatabase блокируется открытым соединением и данные остаются.
  if (typeof indexedDB !== 'undefined') {
    const { closeDB } = await import('./db');
    await closeDB().catch(() => {});
    await deleteDatabaseAsync(INFO_IDB_NAME);
    await deleteDatabaseAsync(OLD_IDB_NAME);
  }

  // OPFS
  const root = await getOPFSRoot();
  if (root) {
    await deleteOPFSPath([INFO_OPFS_ROOT]);
    for (const old of OLD_OPFS_DIRS) {
      await deleteOPFSPath([old]);
    }
  }
}

/** deleteDatabase с ожиданием результата (успех/блокировка). */
function deleteDatabaseAsync(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve(); // не подвисаем, просто сообщаем наверх
    } catch {
      resolve();
    }
  });
}

/** Оценка размера по каждому слою. */
export async function getInfoUsage(): Promise<{
  localStorage: number;
  indexedDB: number;
  opfs: number;
  opfsQuota: number;
}> {
  let ls = 0;
  let idb = 0;
  let opfs = 0;
  let quota = 0;

  if (isLocalStorageAvailable()) {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (!k.startsWith(INFO_LS_PREFIX)) continue;
      const v = localStorage.getItem(k) || '';
      ls += (k.length + v.length) * 2; // utf16 approx
    }
  }

  try {
    const { openDB } = await import('idb');
    const db = await openDB(INFO_IDB_NAME, 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
      },
    }).catch(() => null);
    if (db) {
      try {
        const all = await db.getAll('projects');
        const json = JSON.stringify(all);
        idb = json.length * 2;
      } catch {}
      db.close();
    }
  } catch {}

  try {
    if (typeof navigator !== 'undefined' && (navigator.storage as any)?.estimate) {
      const est = await (navigator.storage as any).estimate();
      opfs = est.usage || 0;
      quota = est.quota || 0;
    }
  } catch {}

  return { localStorage: ls, indexedDB: idb, opfs, opfsQuota: quota };
}

interface ExportJSON {
  version: 1;
  timestamp: number;
  localStorage: Record<string, string>;
  indexedDB: { projects: any[] };
  opfs?: Record<string, string>; // path -> base64
}

/** Экспорт всего в один JSON (без файлов OPFS — только мета). */
export async function exportAllInfo(options?: { includeKeys?: boolean }): Promise<Blob> {
  const includeKeys = options?.includeKeys ?? true;
  const ls: Record<string, string> = {};
  if (isLocalStorageAvailable()) {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(INFO_LS_PREFIX)) continue;
      if (!includeKeys && k === LS_KEYS.KEYS) continue;
      const v = localStorage.getItem(k);
      if (v !== null) ls[k] = v;
    }
  }

  let projects: any[] = [];
  try {
    const { openDB } = await import('idb');
    const db = await openDB(INFO_IDB_NAME, 3, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
      },
    }).catch(() => null);
    if (db) {
      try {
        projects = await db.getAll('projects');
      } catch {}
      db.close();
    }
  } catch {}

  const payload: ExportJSON = {
    version: 1,
    timestamp: Date.now(),
    localStorage: ls,
    indexedDB: { projects },
  };

  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

/** Полный бэкап (JSON + все файлы OPFS) в .mvs.json (base64). */
export async function exportAllInfoWithFiles(options?: { includeKeys?: boolean }): Promise<Blob> {
  const includeKeys = options?.includeKeys ?? true;
  const baseBlob = await exportAllInfo({ includeKeys });
  const baseJson: ExportJSON = JSON.parse(await baseBlob.text());

  const opfsMap: Record<string, string> = {};
  const root = await getOPFSRoot();
  if (root) {
    try {
      const infoRoot = await root.getDirectoryHandle(INFO_OPFS_ROOT).catch(() => null);
      if (infoRoot) {
        const files: Array<{ path: string; handle: FileSystemFileHandle }> = [];
        await listAllOPFSFilesRecursive(infoRoot, '', files);
        for (const { path, handle } of files) {
          try {
            const file = await handle.getFile();
            const b64 = await readFileAsBase64(file);
            // Store with full path under mvs-info/
            opfsMap[`${INFO_OPFS_ROOT}/${path}`] = b64;
          } catch {}
        }
      }
    } catch {}
  }

  const full: ExportJSON = { ...baseJson, opfs: opfsMap };
  return new Blob([JSON.stringify(full)], { type: 'application/json' });
}

function isValidProject(p: any): boolean {
  return p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.panels);
}

/** Импорт из JSON. Перезаписывает всё. 
 * Порядок: сначала IDB и OPFS, только при успехе — LS, чтобы избежать потери данных при падении.
 */
export async function importAllInfo(blob: Blob): Promise<void> {
  const text = await blob.text();
  const data = JSON.parse(text) as ExportJSON;

  if (!data.version || !data.localStorage) {
    throw new Error('Invalid backup format');
  }

  // Validate projects before wiping
  if (data.indexedDB?.projects) {
    const invalid = data.indexedDB.projects.filter((p: any) => !isValidProject(p));
    if (invalid.length > 0) {
      console.warn(`[import] ${invalid.length} invalid projects will be skipped`);
      data.indexedDB.projects = data.indexedDB.projects.filter(isValidProject);
    }
  }

  // 1) Restore IDB first — most critical, if fails we keep old LS
  if (data.indexedDB?.projects) {
    try {
      const { openDB } = await import('idb');
      const db = await openDB(INFO_IDB_NAME, 3, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('projects')) {
            db.createObjectStore('projects', { keyPath: 'id' });
          }
        },
      });
      const tx = db.transaction('projects', 'readwrite');
      await tx.objectStore('projects').clear();
      for (const p of data.indexedDB.projects) {
        await tx.objectStore('projects').put(p);
      }
      await tx.done;
      db.close();
    } catch (e) {
      console.error('Failed to restore IDB — aborting import, LS untouched', e);
      throw e;
    }
  }

  // 2) Restore OPFS files if present — if fails, we still have IDB new + old LS, user can retry
  // We do OPFS before LS so LS isn't wiped on OPFS failure
  if (data.opfs) {
    const root = await getOPFSRoot();
    if (root) {
      const opfsErrors: string[] = [];
      for (const [fullPath, b64] of Object.entries(data.opfs)) {
        try {
          const parts = fullPath.split('/').filter(Boolean);
          const fileName = parts.pop()!;
          const dirPath = parts;
          let dir = root;
          for (const seg of dirPath) {
            dir = await dir.getDirectoryHandle(seg, { create: true });
          }
          await writeBase64ToFile(dir, fileName, b64);
        } catch (e) {
          console.warn('Failed to restore OPFS file', fullPath, e);
          opfsErrors.push(fullPath);
        }
      }
      if (opfsErrors.length > 0) {
        console.warn(`[import] ${opfsErrors.length} OPFS files failed, continuing`);
        // Don't throw — OPFS partial failure shouldn't block LS restore, but log
      }
    }
  }

  // 3) Restore LS last — only after IDB (and best-effort OPFS) succeeded
  if (isLocalStorageAvailable()) {
    const existing = getAllLocalStorageKeysWithPrefix(INFO_LS_PREFIX);
    for (const k of existing) {
      try { localStorage.removeItem(k); } catch {}
    }
    for (const [k, v] of Object.entries(data.localStorage)) {
      if (!k.startsWith(INFO_LS_PREFIX)) continue;
      try { localStorage.setItem(k, v); } catch {}
    }
  }
}
