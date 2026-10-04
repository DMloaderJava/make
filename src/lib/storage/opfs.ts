/**
 * OPFS (Origin Private File System) abstraction
 * - Stores images, audio cache, projects files under mvs-info/
 */

import { INFO_OPFS_ROOT } from './info';

export interface OPFSHandle {
  isOPFS: boolean;
}

let rootDir: FileSystemDirectoryHandle | null = null;
let opfsSupported: boolean | null = null;

export async function isOPFSSupported(): Promise<boolean> {
  if (opfsSupported !== null) return opfsSupported;
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || !(navigator.storage as any).getDirectory) {
      opfsSupported = false;
      return false;
    }
    await (navigator.storage as any).getDirectory();
    opfsSupported = true;
    return true;
  } catch {
    opfsSupported = false;
    return false;
  }
}

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (rootDir) return rootDir as FileSystemDirectoryHandle;
  if (!(await isOPFSSupported())) {
    throw new Error('OPFS not supported');
  }
  const dir = await (navigator.storage as any).getDirectory();
  rootDir = dir;
  return dir as FileSystemDirectoryHandle;
}

async function ensureDir(path: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await getRoot();
  // Always prefix with INFO_OPFS_ROOT unless path already starts with it
  const fullPath = path[0] === INFO_OPFS_ROOT ? path : [INFO_OPFS_ROOT, ...path];
  for (const segment of fullPath) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

export async function getInfoRootDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await getRoot();
    return await root.getDirectoryHandle(INFO_OPFS_ROOT);
  } catch {
    return null;
  }
}

export async function writeFile(path: string[], filename: string, data: Blob | ArrayBuffer | string): Promise<void> {
  if (!(await isOPFSSupported())) {
    // Fallback: store in IDB via localStorage? We'll use IDB for fallback
    throw new Error('OPFS not supported, use IDB fallback');
  }
  const dir = await ensureDir(path);
  const fileHandle = await dir.getFileHandle(filename, { create: true });
  const writable = await (fileHandle as any).createWritable();
  if (data instanceof Blob) {
    await writable.write(data);
  } else if (data instanceof ArrayBuffer) {
    await writable.write(data);
  } else {
    await writable.write(new Blob([data]));
  }
  await writable.close();
}

export async function readFile(path: string[], filename: string): Promise<Blob> {
  if (!(await isOPFSSupported())) {
    throw new Error('OPFS not supported');
  }
  const dir = await ensureDir(path);
  const fileHandle = await dir.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return file;
}

export async function readFileAsDataURL(path: string[], filename: string): Promise<string> {
  const blob = await readFile(path, filename);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function deleteFile(path: string[], filename: string): Promise<void> {
  if (!(await isOPFSSupported())) return;
  try {
    const dir = await ensureDir(path);
    await dir.removeEntry(filename);
  } catch {}
}

export async function listFiles(path: string[]): Promise<string[]> {
  if (!(await isOPFSSupported())) return [];
  try {
    const dir = await ensureDir(path);
    const files: string[] = [];
    // @ts-ignore - async iterator
    for await (const [name, handle] of (dir as any).entries()) {
      if ((handle as any).kind === 'file') files.push(name);
    }
    return files;
  } catch {
    return [];
  }
}

export async function fileExists(path: string[], filename: string): Promise<boolean> {
  if (!(await isOPFSSupported())) return false;
  try {
    const dir = await ensureDir(path);
    await dir.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}

// High-level helpers for project images
export async function saveProjectImage(projectId: string, index: number, blob: Blob): Promise<string> {
  const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
  const filename = `${index}.${ext}`;
  await writeFile(['projects', projectId, 'images'], filename, blob);
  return filename; // return relative path
}

export async function loadProjectImage(projectId: string, filename: string): Promise<Blob> {
  return readFile(['projects', projectId, 'images'], filename);
}

export async function loadProjectImageAsDataURL(projectId: string, filename: string): Promise<string> {
  return readFileAsDataURL(['projects', projectId, 'images'], filename);
}

export async function deleteProjectImages(projectId: string): Promise<void> {
  if (!(await isOPFSSupported())) return;
  try {
    const root = await getRoot();
    const infoRoot = await root.getDirectoryHandle(INFO_OPFS_ROOT);
    const projectsDir = await infoRoot.getDirectoryHandle('projects');
    await projectsDir.removeEntry(projectId, { recursive: true });
  } catch {
    // fallback try old location for migration cleanup
    try {
      const root = await getRoot();
      const projectsDir = await root.getDirectoryHandle('projects');
      await projectsDir.removeEntry(projectId, { recursive: true });
    } catch {}
  }
}

// TTS Cache - keyed by hash
export function hashString(str: string): string {
  // Simple hash for filename - will use SHA-256 in actual implementation
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

export async function hashSHA256(text: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }
  return hashString(text);
}

export async function getTTSCacheKey(params: {
  text: string;
  voice: string;
  provider: string;
  model?: string;
  speed?: number;
  emotion?: string;
  language?: string;
}): Promise<string> {
  const keyString = `${params.provider}|${params.voice}|${params.model||''}|${params.speed||1}|${params.emotion||''}|${params.language||''}|${params.text}`;
  const hash = await hashSHA256(keyString);
  return `${params.provider}-${hash}.mp3`;
}

export async function saveTTSCache(key: string, blob: Blob): Promise<void> {
  await writeFile(['tts-cache'], key, blob);
}

export async function loadTTSCache(key: string): Promise<Blob | null> {
  try {
    if (await fileExists(['tts-cache'], key)) {
      return await readFile(['tts-cache'], key);
    }
    return null;
  } catch {
    return null;
  }
}

export async function hasTTSCache(key: string): Promise<boolean> {
  return fileExists(['tts-cache'], key);
}

// Audio blobs per project - persisted
export async function saveProjectAudio(projectId: string, panelId: number, blob: Blob): Promise<void> {
  await writeFile(['projects', projectId, 'audio'], `${panelId}.mp3`, blob);
}

export async function loadProjectAudio(projectId: string, panelId: number): Promise<Blob | null> {
  try {
    if (await fileExists(['projects', projectId, 'audio'], `${panelId}.mp3`)) {
      return await readFile(['projects', projectId, 'audio'], `${panelId}.mp3`);
    }
    return null;
  } catch {
    return null;
  }
}

// --- Подпись аудио: позволяет понять, что сохранённый файл устарел ---
// Раньше loadProjectAudio всегда возвращал старый файл, поэтому правки текста
// и смена голоса не применялись при повторной озвучке.

export async function saveProjectAudioSignature(
  projectId: string,
  slot: ProjectAudioSlot,
  signature: string
): Promise<void> {
  await writeFile(['projects', projectId, 'audio'], `${slot}.sig`, signature);
}

export async function getProjectAudioSignature(
  projectId: string,
  slot: ProjectAudioSlot
): Promise<string | null> {
  try {
    if (!(await fileExists(['projects', projectId, 'audio'], `${slot}.sig`))) return null;
    const blob = await readFile(['projects', projectId, 'audio'], `${slot}.sig`);
    return (await blob.text()).trim();
  } catch {
    return null;
  }
}

/**
 * Возвращает сохранённое аудио слота, если его подпись совпадает с ожидаемой.
 *
 * Мягкая миграция: если подписи ещё нет (аудио создано до v1.3.2), файл НЕ
 * выбрасывается вслепую — решение принимает вызывающая сторона через
 * `legacyIsFresh`. Если она подтверждает, что текст не менялся (сравнение с
 * сохранённым таймлайном), подпись просто дописывается — пользователь не
 * платит за повторную генерацию.
 *
 * @param legacyIsFresh undefined → старое аудио считается устаревшим
 *                      (безопасно: повтор обычно попадает в общий TTS-кэш);
 *                      true → подпись дописывается, файл переиспользуется.
 */
export async function loadFreshProjectAudio(
  projectId: string,
  slot: ProjectAudioSlot,
  expectedSignature: string,
  legacyIsFresh?: boolean
): Promise<Blob | null> {
  const blob = slot === 'intro'
    ? await loadProjectIntroAudio(projectId)
    : slot === 'outro'
      ? await loadProjectOutroAudio(projectId)
      : await loadProjectAudio(projectId, slot);
  if (!blob) return null;

  const stored = await getProjectAudioSignature(projectId, slot);

  // Подписи нет (аудио из старой версии)
  if (!stored) {
    if (legacyIsFresh) {
      await saveProjectAudioSignature(projectId, slot, expectedSignature);
      return blob;
    }
    return null;
  }

  return stored === expectedSignature ? blob : null;
}

export type ProjectAudioSlot = number | 'intro' | 'outro';

function audioFileName(slot: ProjectAudioSlot): string {
  return `${slot}.mp3`;
}

/** Удаляет аудио (и подпись) — используется кнопкой «↻ Переозвучить». */
export async function deleteProjectAudio(projectId: string, slot: ProjectAudioSlot): Promise<void> {
  await deleteFile(['projects', projectId, 'audio'], audioFileName(slot));
  await deleteFile(['projects', projectId, 'audio'], `${slot}.sig`);
}

export async function saveProjectIntroAudio(projectId: string, blob: Blob): Promise<void> {
  await writeFile(['projects', projectId, 'audio'], `intro.mp3`, blob);
}

export async function saveProjectOutroAudio(projectId: string, blob: Blob): Promise<void> {
  await writeFile(['projects', projectId, 'audio'], `outro.mp3`, blob);
}

export async function loadProjectIntroAudio(projectId: string): Promise<Blob | null> {
  try {
    if (await fileExists(['projects', projectId, 'audio'], `intro.mp3`)) {
      return await readFile(['projects', projectId, 'audio'], `intro.mp3`);
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadProjectOutroAudio(projectId: string): Promise<Blob | null> {
  try {
    if (await fileExists(['projects', projectId, 'audio'], `outro.mp3`)) {
      return await readFile(['projects', projectId, 'audio'], `outro.mp3`);
    }
    return null;
  } catch {
    return null;
  }
}

export async function getOPFSUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return { usage: est.usage || 0, quota: est.quota || 0 };
    }
    return null;
  } catch {
    return null;
  }
}
