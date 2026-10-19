/**
 * Экспорт и импорт проекта в ZIP-архив (Этап 8, пункты 76, 77).
 *
 * Структура архива:
 * - `project.json` — сериализованный объект Project (со схемой, таймлайном, SRT, настройками);
 * - `manifest.json` — реестр всех ресурсов (имя, путь, размер, MIME, SHA-256, дата импорта);
 * - `images/<index>.<ext>` — бинарные изображения страниц;
 * - `audio/<slot>.mp3` — бинарные аудиофайлы панелей, интро и аутро.
 *
 * Использует стандартный формат PKZIP (метод Store + CRC32 + UTF-8 флаг),
 * совместимый как со стандартными архиваторами ОС, так и с round-trip импортом в браузере и Node.
 */

import { Project, appendProjectEvent } from './db';
import {
  ResourceManifestEntry,
  computeBlobSha256,
  createResourceManifestEntry,
} from './resourceIntegrity';
import { migrateProjectSchema } from './schemaMigration';
import { DEFAULT_PANEL_GAP, rebuildSrt } from '../pipeline/buildTimeline';

export interface ProjectArchiveResources {
  /** Индекс изображения → Blob или data URL строка. */
  images: ReadonlyMap<number, Blob | string> | Array<Blob | string>;
  /** Панель (или 'intro' / 'outro') → Blob аудио. */
  audio: ReadonlyMap<number | 'intro' | 'outro', Blob>;
}

export interface ProjectArchiveManifestFile {
  format: 'mvs-project-archive';
  version: 1;
  exportedAt: number;
  projectId: string;
  projectName: string;
  entries: Record<string, ResourceManifestEntry>;
}

export interface ImportedProjectArchive {
  project: Project;
  manifest: ProjectArchiveManifestFile;
  images: Map<number, Blob>;
  imageDataUrls: string[];
  audio: Map<number | 'intro' | 'outro', Blob>;
  verifiedCount: number;
}

// ---------------------------------------------------------------------------
// CRC32 и низкоуровневый PKZIP Store кодек
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  path: string;
  data: Uint8Array;
}

/**
 * Собирает стандартный ZIP-архив (метод 0 — Store) из списка файлов.
 */
export function encodeZipArchive(entries: readonly ZipEntryInput[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map(e => {
    const nameBytes = encoder.encode(e.path.replace(/^\/+/, ''));
    const crc = crc32(e.data);
    return { nameBytes, data: e.data, crc };
  });

  let localTotalSize = 0;
  let centralTotalSize = 0;
  for (const item of prepared) {
    localTotalSize += 30 + item.nameBytes.length + item.data.length;
    centralTotalSize += 46 + item.nameBytes.length;
  }

  const totalSize = localTotalSize + centralTotalSize + 22;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  let localOffset = 0;
  const localOffsets: number[] = [];

  for (const item of prepared) {
    localOffsets.push(localOffset);
    view.setUint32(localOffset + 0, 0x04034b50, true); // Local file header signature
    view.setUint16(localOffset + 4, 20, true);         // Version needed to extract (2.0)
    view.setUint16(localOffset + 6, 0x0800, true);     // General purpose bit flag (UTF-8)
    view.setUint16(localOffset + 8, 0, true);          // Compression method (0 = Store)
    view.setUint16(localOffset + 10, 0, true);         // Last mod file time
    view.setUint16(localOffset + 12, 0, true);         // Last mod file date
    view.setUint32(localOffset + 14, item.crc, true);  // CRC-32
    view.setUint32(localOffset + 18, item.data.length, true); // Compressed size
    view.setUint32(localOffset + 22, item.data.length, true); // Uncompressed size
    view.setUint16(localOffset + 26, item.nameBytes.length, true); // File name length
    view.setUint16(localOffset + 28, 0, true);         // Extra field length
    out.set(item.nameBytes, localOffset + 30);
    out.set(item.data, localOffset + 30 + item.nameBytes.length);
    localOffset += 30 + item.nameBytes.length + item.data.length;
  }

  const centralStart = localOffset;
  let centralOffset = centralStart;

  for (let i = 0; i < prepared.length; i++) {
    const item = prepared[i];
    view.setUint32(centralOffset + 0, 0x02014b50, true); // Central directory file header signature
    view.setUint16(centralOffset + 4, 20, true);         // Version made by
    view.setUint16(centralOffset + 6, 20, true);         // Version needed
    view.setUint16(centralOffset + 8, 0x0800, true);     // UTF-8 flag
    view.setUint16(centralOffset + 10, 0, true);         // Compression method (0 = Store)
    view.setUint16(centralOffset + 12, 0, true);         // Time
    view.setUint16(centralOffset + 14, 0, true);         // Date
    view.setUint32(centralOffset + 16, item.crc, true);  // CRC-32
    view.setUint32(centralOffset + 20, item.data.length, true); // Compressed size
    view.setUint32(centralOffset + 24, item.data.length, true); // Uncompressed size
    view.setUint16(centralOffset + 28, item.nameBytes.length, true); // File name length
    view.setUint16(centralOffset + 30, 0, true);         // Extra field length
    view.setUint16(centralOffset + 32, 0, true);         // File comment length
    view.setUint16(centralOffset + 34, 0, true);         // Disk number start
    view.setUint16(centralOffset + 36, 0, true);         // Internal file attributes
    view.setUint32(centralOffset + 38, 0, true);         // External file attributes
    view.setUint32(centralOffset + 42, localOffsets[i], true); // Relative offset of local header
    out.set(item.nameBytes, centralOffset + 46);
    centralOffset += 46 + item.nameBytes.length;
  }

  // End of central directory record (EOCD)
  view.setUint32(centralOffset + 0, 0x06054b50, true);
  view.setUint16(centralOffset + 4, 0, true);
  view.setUint16(centralOffset + 6, 0, true);
  view.setUint16(centralOffset + 8, prepared.length, true);
  view.setUint16(centralOffset + 10, prepared.length, true);
  view.setUint32(centralOffset + 12, centralTotalSize, true);
  view.setUint32(centralOffset + 16, centralStart, true);
  view.setUint16(centralOffset + 20, 0, true);

  return out;
}

/**
 * Распаковывает стандартный ZIP-архив (Store) с проверкой CRC32 каждой записи.
 */
export function decodeZipArchive(zipBytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const decoder = new TextDecoder('utf-8');
  const files = new Map<string, Uint8Array>();

  if (zipBytes.byteLength < 22) {
    throw new Error('Повреждённый ZIP-архив: размер меньше минимального заголовка');
  }

  // Находим EOCD с конца файла
  let eocdOffset = -1;
  const minSearch = Math.max(0, zipBytes.byteLength - 65557);
  for (let pos = zipBytes.byteLength - 22; pos >= minSearch; pos--) {
    if (view.getUint32(pos, true) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Не найден заголовок каталога ZIP (EOCD) — файл не является валидным ZIP-архивом');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (cursor + 46 > zipBytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error(`Повреждённая запись центрального каталога ZIP (индекс ${i})`);
    }
    const compression = view.getUint16(cursor + 10, true);
    if (compression !== 0) {
      throw new Error(`Метод сжатия ZIP (${compression}) не поддерживается встроенным декодером (ожидался Store = 0)`);
    }
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const path = decoder.decode(zipBytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;

    if (localHeaderOffset + 30 > zipBytes.byteLength || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Повреждённый локальный заголовок ZIP для «${path}»`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBytes.byteLength) {
      throw new Error(`Данные файла «${path}» выходят за границы архива`);
    }

    const fileData = zipBytes.slice(dataStart, dataEnd);
    const actualCrc = crc32(fileData);
    if (actualCrc !== expectedCrc) {
      throw new Error(`Ошибка контрольной суммы CRC32 для «${path}» в ZIP-архиве`);
    }

    files.set(path, fileData);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Помощники конвертации DataURL ⇄ Blob
// ---------------------------------------------------------------------------

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) {
    return new Blob([dataUrl], { type: 'application/octet-stream' });
  }
  const header = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mimeMatch = header.match(/data:([^;]+)/i);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const isBase64 = /;base64/i.test(header);

  if (isBase64) {
    if (typeof Buffer !== 'undefined') {
      const buf = Buffer.from(body, 'base64');
      return new Blob([buf], { type: mime });
    }
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mime = blob.type || 'image/png';
  if (typeof Buffer !== 'undefined') {
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

function imageExtFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

function mimeFromImagePath(path: string): string {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// ---------------------------------------------------------------------------
// Высокоуровневый экспорт и импорт проекта (пункты 76, 77)
// ---------------------------------------------------------------------------

/**
 * Экспортирует проект и все его ресурсы (изображения, аудио, project.json, manifest.json) в единый ZIP-архив.
 * Имена файлов изображений внутри архива и в `project.imageFiles` нормализуются к детерминированному виду
 * `${index}.${ext}` (например, `0.png`, `1.jpg`), чтобы исключить коллизии путей при переносе между ОС (P1 п. 16).
 */
export async function exportProjectToZip(
  project: Project,
  resources: ProjectArchiveResources
): Promise<{ blob: Blob; manifest: ProjectArchiveManifestFile }> {
  const encoder = new TextEncoder();
  const entries: ZipEntryInput[] = [];
  const manifestEntries: Record<string, ResourceManifestEntry> = {
    ...(project.resourceManifest ?? {}),
  };

  // 1. Изображения
  const imageEntries: Array<[number, Blob | string]> = Array.isArray(resources.images)
    ? resources.images.map((item, idx) => [idx, item] as [number, Blob | string])
    : [...resources.images.entries()].sort((a, b) => a[0] - b[0]);

  const exportedImagePaths: string[] = [];
  for (const [index, rawImg] of imageEntries) {
    const blob = typeof rawImg === 'string' ? dataUrlToBlob(rawImg) : rawImg;
    const ext = imageExtFromMime(blob.type || 'image/png');
    const fileName = `${index}.${ext}`;
    const archivePath = `images/${fileName}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    entries.push({ path: archivePath, data: bytes });
    exportedImagePaths.push(fileName);

    const id = `image:${index}`;
    manifestEntries[id] = await createResourceManifestEntry({
      id,
      path: archivePath,
      fileName,
      blob,
      originalMime: blob.type || `image/${ext}`,
      normalizedMime: blob.type || `image/${ext}`,
      role: 'image',
      imageIndex: index,
      importedAt: manifestEntries[id]?.importedAt ?? project.updatedAt,
    });
  }

  // 2. Аудиофайлы (панели, интро, аутро)
  const sortedAudio = [...resources.audio.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  for (const [slot, blob] of sortedAudio) {
    const fileName = `${slot}.mp3`;
    const archivePath = `audio/${fileName}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    entries.push({ path: archivePath, data: bytes });

    const id = `audio:${slot}`;
    const panel = typeof slot === 'number' ? project.panels.find(p => p.id === slot) : undefined;
    manifestEntries[id] = await createResourceManifestEntry({
      id,
      path: archivePath,
      fileName: panel?.audioFileName || fileName,
      blob,
      originalMime: panel?.audioOriginalMime || blob.type || 'audio/mpeg',
      normalizedMime: panel?.audioNormalizedMime || blob.type || 'audio/mpeg',
      role: slot === 'intro' ? 'intro-audio' : slot === 'outro' ? 'outro-audio' : 'panel-audio',
      ...(typeof slot === 'number' ? { panelId: slot } : {}),
      importedAt: manifestEntries[id]?.importedAt ?? project.updatedAt,
    });
  }

  const exportedAt = Date.now();
  const manifestFile: ProjectArchiveManifestFile = {
    format: 'mvs-project-archive',
    version: 1,
    exportedAt,
    projectId: project.id,
    projectName: project.name,
    entries: manifestEntries,
  };

  const projectForArchive: Project = {
    ...project,
    imageFiles: exportedImagePaths.length > 0 ? exportedImagePaths : project.imageFiles,
    resourceManifest: manifestEntries,
  };

  entries.unshift(
    { path: 'project.json', data: encoder.encode(JSON.stringify(projectForArchive, null, 2)) },
    { path: 'manifest.json', data: encoder.encode(JSON.stringify(manifestFile, null, 2)) }
  );

  const zipBytes = encodeZipArchive(entries);
  const copy = new Uint8Array(zipBytes.byteLength);
  copy.set(zipBytes);
  return {
    blob: new Blob([copy.buffer as ArrayBuffer], { type: 'application/zip' }),
    manifest: manifestFile,
  };
}

/**
 * Импортирует проект из ZIP-архива, проверяет SHA-256 каждого блоба по manifest.json,
 * мигрирует схему при необходимости и восстанавливает таймлайн и ресурсы.
 */
export async function importProjectFromZip(zipBlob: Blob | ArrayBuffer | Uint8Array): Promise<ImportedProjectArchive> {
  const bytes = zipBlob instanceof Blob
    ? new Uint8Array(await zipBlob.arrayBuffer())
    : zipBlob instanceof Uint8Array
      ? zipBlob
      : new Uint8Array(zipBlob);

  const files = decodeZipArchive(bytes);
  const decoder = new TextDecoder('utf-8');

  const projectRawBytes = files.get('project.json');
  if (!projectRawBytes) {
    throw new Error('В ZIP-архиве отсутствует файл project.json');
  }
  const manifestRawBytes = files.get('manifest.json');
  if (!manifestRawBytes) {
    throw new Error('В ZIP-архиве отсутствует файл manifest.json');
  }

  let rawProject: Project;
  let manifest: ProjectArchiveManifestFile;
  try {
    rawProject = JSON.parse(decoder.decode(projectRawBytes)) as Project;
    manifest = JSON.parse(decoder.decode(manifestRawBytes)) as ProjectArchiveManifestFile;
  } catch (e) {
    throw new Error(`Не удалось разобрать JSON из архива: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (manifest.format !== 'mvs-project-archive') {
    throw new Error('Неподдерживаемый формат манифеста архива');
  }

  // Проверяем все ресурсы из manifest.entries по SHA-256 и собираем блобы
  const images = new Map<number, Blob>();
  const audio = new Map<number | 'intro' | 'outro', Blob>();
  let verifiedCount = 0;

  for (const entry of Object.values(manifest.entries)) {
    const fileBytes = files.get(entry.path);
    if (!fileBytes) {
      throw new Error(`В архиве отсутствует ресурс «${entry.path}» (${entry.fileName}), заявленный в manifest.json`);
    }
    const actualSha = await computeBlobSha256(fileBytes);
    if (actualSha.toLowerCase() !== entry.sha256.toLowerCase()) {
      throw new Error(
        `Повреждён ресурс «${entry.path}» (${entry.fileName}): SHA-256 ${actualSha.slice(0, 12)}… не совпадает с ${entry.sha256.slice(0, 12)}…`
      );
    }
    verifiedCount++;

    const mime = entry.normalizedMime || entry.originalMime || (entry.role === 'image' ? mimeFromImagePath(entry.path) : 'audio/mpeg');
    const copy = new Uint8Array(fileBytes.byteLength);
    copy.set(fileBytes);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: mime });

    if (entry.role === 'image') {
      const idx = entry.imageIndex ?? parseInt(entry.path.replace(/^images\//, ''), 10);
      if (Number.isFinite(idx)) images.set(idx, blob);
    } else if (entry.role === 'intro-audio') {
      audio.set('intro', blob);
    } else if (entry.role === 'outro-audio') {
      audio.set('outro', blob);
    } else if (entry.role === 'panel-audio' && entry.panelId !== undefined) {
      audio.set(entry.panelId, blob);
    }
  }

  // Восстанавливаем dataURL массив для совместимости с режимом без OPFS
  const sortedImageIndices = [...images.keys()].sort((a, b) => a - b);
  const imageDataUrls: string[] = [];
  for (const idx of sortedImageIndices) {
    imageDataUrls.push(await blobToDataUrl(images.get(idx)!));
  }

  const migrated = migrateProjectSchema({
    ...rawProject,
    resourceManifest: manifest.entries,
    images: imageDataUrls.length > 0 ? imageDataUrls : rawProject.images,
  }).project;

  // Пересобираем или верифицируем таймлайн и SRT, чтобы гарантировать целостность
  const panelGap = migrated.settings.panelGap ?? DEFAULT_PANEL_GAP;
  const rebuilt = rebuildSrt({
    panels: migrated.panels,
    audioDurations: migrated.audioDurations ?? {},
    voiceAssignments: migrated.voiceAssignments,
    intro: migrated.intro,
    outro: migrated.outro,
    introDuration: migrated.introDuration,
    outroDuration: migrated.outroDuration,
    panelGap,
    realDurations: migrated.audioDurations ?? {},
  });

  const restoredProject: Project = {
    ...migrated,
    timeline: rebuilt.timeline,
    srt: rebuilt.srt,
    eventLog: appendProjectEvent(migrated.eventLog, {
      type: 'archive-import',
      summary: `Проект импортирован из ZIP (проверено ресурсов: ${verifiedCount})`,
    }),
  };

  return {
    project: restoredProject,
    manifest,
    images,
    imageDataUrls,
    audio,
    verifiedCount,
  };
}
