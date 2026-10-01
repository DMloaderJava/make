/**
 * One-shot migration from old namespaces to mvs-info
 */

import { INFO_LS_PREFIX, lsKey, INFO_IDB_NAME, INFO_OPFS_ROOT, LS_KEYS } from './info';

const OLD_LS = {
  KEYS: 'manga-voice-keys',
  SETTINGS: 'manga-voice-settings',
  CUSTOM: 'custom-llm-config',
};
const OLD_IDB = 'manga-voice-db';
const OLD_OPFS = ['projects', 'tts-cache'];
const MIGRATION_FLAG = lsKey('migration-v1-done');

function lsAvailable(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

async function getOPFSRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !(navigator.storage as any)?.getDirectory) return null;
    return await (navigator.storage as any).getDirectory();
  } catch {
    return null;
  }
}

async function copyDirRecursive(
  srcDir: FileSystemDirectoryHandle,
  destDir: FileSystemDirectoryHandle
): Promise<void> {
  // @ts-ignore
  for await (const [name, handle] of (srcDir as any).entries()) {
    if ((handle as any).kind === 'file') {
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        const destFile = await destDir.getFileHandle(name, { create: true });
        const writable = await (destFile as any).createWritable();
        await writable.write(file);
        await writable.close();
      } catch (e) {
        console.warn(`[migrate] failed to copy file ${name}`, e);
      }
    } else if ((handle as any).kind === 'directory') {
      try {
        const destSub = await destDir.getDirectoryHandle(name, { create: true });
        await copyDirRecursive(handle as FileSystemDirectoryHandle, destSub);
      } catch (e) {
        console.warn(`[migrate] failed to copy dir ${name}`, e);
      }
    }
  }
}

export async function runMigration(): Promise<void> {
  if (!lsAvailable()) return;
  if (localStorage.getItem(MIGRATION_FLAG) === '1') {
    return;
  }

  console.log('[mvs-info] Starting migration v1...');

  // 1. localStorage
  try {
    // manga-voice-keys -> mvs-info:keys
    const oldKeys = localStorage.getItem(OLD_LS.KEYS);
    if (oldKeys && !localStorage.getItem(LS_KEYS.KEYS)) {
      localStorage.setItem(LS_KEYS.KEYS, oldKeys);
      console.log('[migrate] keys migrated');
    }
    const oldSettings = localStorage.getItem(OLD_LS.SETTINGS);
    if (oldSettings && !localStorage.getItem(LS_KEYS.SETTINGS)) {
      localStorage.setItem(LS_KEYS.SETTINGS, oldSettings);
      console.log('[migrate] settings migrated');
    }
    const oldCustom = localStorage.getItem(OLD_LS.CUSTOM);
    if (oldCustom && !localStorage.getItem(LS_KEYS.CUSTOM_LLM)) {
      localStorage.setItem(LS_KEYS.CUSTOM_LLM, oldCustom);
      console.log('[migrate] custom-llm-config migrated');
    }
    // taskqueue-*
    const toMigrate: Array<{ oldK: string; newK: string; val: string }> = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith('taskqueue-')) {
        const newK = lsKey(k);
        if (!localStorage.getItem(newK)) {
          const v = localStorage.getItem(k);
          if (v) toMigrate.push({ oldK: k, newK, val: v });
        }
      }
    }
    for (const { newK, val } of toMigrate) {
      localStorage.setItem(newK, val);
    }
    if (toMigrate.length) console.log(`[migrate] ${toMigrate.length} taskqueue keys migrated`);
  } catch (e) {
    console.error('[migrate] LS migration failed', e);
  }

  // 2. IndexedDB
  try {
    if (typeof indexedDB !== 'undefined') {
      const { openDB } = await import('idb');
      // Check if old DB exists by trying to open
      const oldExists = await new Promise<boolean>((resolve) => {
        const req = indexedDB.open(OLD_IDB);
        req.onsuccess = () => {
          const db = req.result;
          const exists = db.objectStoreNames.contains('projects');
          db.close();
          resolve(exists);
        };
        req.onerror = () => resolve(false);
        req.onupgradeneeded = () => {
          // If upgradeneeded, old DB didn't exist with data, abort
          try { req.transaction?.abort(); } catch {}
          resolve(false);
        };
      });

      if (oldExists) {
        console.log('[migrate] old IDB found, copying...');
        const oldDb = await openDB(OLD_IDB, 3);
        let projects: any[] = [];
        try {
          projects = await oldDb.getAll('projects');
        } catch {}
        oldDb.close();

        if (projects.length > 0) {
          const newDb = await openDB(INFO_IDB_NAME, 3, {
            upgrade(db) {
              if (!db.objectStoreNames.contains('projects')) {
                db.createObjectStore('projects', { keyPath: 'id' });
              }
            },
          });
          const tx = newDb.transaction('projects', 'readwrite');
          for (const p of projects) {
            try {
              await tx.objectStore('projects').put(p);
            } catch {}
          }
          await tx.done;
          newDb.close();
          console.log(`[migrate] ${projects.length} projects copied to new IDB`);
          // Delete old DB only after successful copy
          try {
            indexedDB.deleteDatabase(OLD_IDB);
            console.log('[migrate] old IDB deleted');
          } catch {}
        }
      }
    }
  } catch (e) {
    console.error('[migrate] IDB migration failed', e);
  }

  // 3. OPFS
  try {
    const root = await getOPFSRoot();
    if (root) {
      const infoRoot = await root.getDirectoryHandle(INFO_OPFS_ROOT, { create: true });
      for (const oldName of OLD_OPFS) {
        try {
          const oldHandle = await root.getDirectoryHandle(oldName);
          // If old exists, check if new already has content
          const newSubName = oldName; // projects stays projects, tts-cache stays tts-cache
          let shouldCopy = true;
          try {
            const existingNew = await infoRoot.getDirectoryHandle(newSubName);
            // If new exists and has files, skip to avoid overwrite? We merge.
            // We'll still copy missing files
          } catch {
            // new doesn't exist, need to create
          }

          if (shouldCopy) {
            const destSub = await infoRoot.getDirectoryHandle(newSubName, { create: true });
            await copyDirRecursive(oldHandle, destSub);
            console.log(`[migrate] OPFS ${oldName} -> ${INFO_OPFS_ROOT}/${newSubName} copied`);
            // Delete old only after copy
            try {
              await root.removeEntry(oldName, { recursive: true } as any);
              console.log(`[migrate] OPFS old ${oldName} removed`);
            } catch {}
          }
        } catch {
          // old dir doesn't exist, skip
        }
      }
    }
  } catch (e) {
    console.error('[migrate] OPFS migration failed', e);
  }

  // Cleanup old LS keys only after everything succeeded
  try {
    // Only delete old if new exists
    if (localStorage.getItem(LS_KEYS.KEYS) && localStorage.getItem(OLD_LS.KEYS)) {
      localStorage.removeItem(OLD_LS.KEYS);
    }
    if (localStorage.getItem(LS_KEYS.SETTINGS) && localStorage.getItem(OLD_LS.SETTINGS)) {
      localStorage.removeItem(OLD_LS.SETTINGS);
    }
    if (localStorage.getItem(LS_KEYS.CUSTOM_LLM) && localStorage.getItem(OLD_LS.CUSTOM)) {
      localStorage.removeItem(OLD_LS.CUSTOM);
    }
    // taskqueue old
    const oldTaskKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('taskqueue-')) oldTaskKeys.push(k);
    }
    for (const oldK of oldTaskKeys) {
      const newK = lsKey(oldK);
      if (localStorage.getItem(newK)) {
        try { localStorage.removeItem(oldK); } catch {}
      }
    }
  } catch {}

  localStorage.setItem(MIGRATION_FLAG, '1');
  console.log('[mvs-info] Migration v1 done');
}
