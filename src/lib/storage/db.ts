import { openDB, IDBPDatabase } from 'idb';
import { isOPFSSupported, saveProjectImage, loadProjectImageAsDataURL, deleteProjectImages } from './opfs';
import { INFO_IDB_NAME } from './info';
import { getSettings } from './local';
import type { ResourceManifestEntry } from './resourceIntegrity';

export type { ResourceManifestEntry };

const DB_NAME = INFO_IDB_NAME;
const DB_VERSION = 3;
export const PROJECT_TTL_MS = 24 * 60 * 60 * 1000;

/** Текущая версия схемы проекта (Этап 1 п. 5, Этап 8 п. 74). */
export const CURRENT_PROJECT_SCHEMA_VERSION = 2;
/** Текущая версия формата таймлайна (Этап 1 п. 5). */
export const CURRENT_TIMELINE_VERSION = 2;

const SNAPSHOT_PREFIX = '__snapshot__:';

export class StaleProjectRevisionError extends Error {
  readonly currentRevision: number;
  readonly attemptedRevision: number;

  constructor(projectId: string, currentRevision: number, attemptedRevision: number) {
    super(
      `Конфликт ревизий проекта «${projectId}»: в хранилище уже сохранена ревизия ${currentRevision}, а попытка сохранения имела устаревшую ревизию ${attemptedRevision}`
    );
    this.name = 'StaleProjectRevisionError';
    this.currentRevision = currentRevision;
    this.attemptedRevision = attemptedRevision;
  }
}

export interface PanelData {
  id: number;
  bbox: { x: number; y: number; width: number; height: number };
  dialogue: string;
  character: string;
  emotion: string;
  type: 'speech' | 'thought' | 'narration' | 'sfx';
  order: number;
  imageIndex: number;
  /**
   * Панель покрывает всё изображение (режим сценария: один кадр = одно
   * изображение): Preview и экспорт рисуют contain (letterbox) без зума
   * и панорамы, bbox-обводку не рисуют.
   */
  fullFrame?: boolean;
  /**
   * Откуда аудио панели (v1.3.18). 'import' — внешний файл из «Импорт аудио»:
   * «Озвучить всё» его не трогает, «↻ Переозвучить» спрашивает подтверждение.
   * Нет поля — TTS (или аудио ещё нет). Сам файл — по тому же ключу
   * audio/{id}.mp3, длительность — project.audioDurations[id].
   */
  audioSource?: 'tts' | 'import';
  /** Имя импортированного файла — для подписи в UI и повторного импорта. */
  audioFileName?: string;
  /** Исходный MIME файла при импорте/генерации (Этап 3 п. 24). */
  audioOriginalMime?: string;
  /** Нормализованный по сигнатуре MIME файла (Этап 3 п. 21, 24). */
  audioNormalizedMime?: string;
  /** SHA-256 контрольная сумма аудиоблоба (Этап 8 п. 72). */
  audioSha256?: string;
  /** Подрезка начала аудио в секундах (Этап 6 п. 52). */
  trimIn?: number;
  /** Подрезка конца аудио в секундах (Этап 6 п. 52). */
  trimOut?: number;
  /** Явное переопределение длительности показа изображения/панели в секундах (Этап 6 п. 54). */
  durationOverride?: number;
  /** Выключен ли звук этого клипа (Этап 6 п. 57). */
  muted?: boolean;
  /** Соло-режим клипа (Этап 6 п. 57). */
  solo?: boolean;
  /** Коэффициент громкости клипа (0..2, по умолчанию 1) (Этап 6 п. 58). */
  gain?: number;
  /** Плавное нарастание звука, сек (Этап 6 п. 58). */
  fadeIn?: number;
  /** Плавное затухание звука, сек (Этап 6 п. 58). */
  fadeOut?: number;
  /** Идентификатор группы разделённого клипа (split) (Этап 6 п. 53). */
  splitGroupId?: string;
  /** Если панель получена через split, id исходной панели с аудиофайлом в OPFS. */
  sourceAudioPanelId?: number;
}

export interface Character {
  name: string;
  appearance: string;
  voiceId: string;
  emotion: string;
  /** Пол персонажа из сценария: (Жен.) → 'female', (Муж.) → 'male'. */
  gender?: 'female' | 'male';
}

export interface SyncTimeline {
  panelId: number;
  imageIndex: number;
  audioStart: number;
  audioEnd: number;
  panelBbox: { x: number; y: number; width: number; height: number };
  voiceId: string;
  text: string;
  character: string;
  /** Источник аудио для визуализации и плана экспорта (Этап 5 п. 47, Этап 9 п. 82). */
  audioSource?: 'tts' | 'import';
  /** Признак оценочной длительности (true, пока нет реального аудиофайла) (Этап 1 п. 2, 4). */
  isEstimated?: boolean;
  trimIn?: number;
  trimOut?: number;
  muted?: boolean;
  solo?: boolean;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface SEOPackage {
  title: { main: string; alternatives: string[] };
  description: { hook: string; body: string; hashtags: string[] };
  tags: string[];
  thumbnail: { prompt: string; textOverlay: string; emotion: string };
  chapters: Array<{ time: string; title: string }>;
  publishTime: string;
  pinnedComment: string;
}

export interface LastAudioImportSnapshot {
  id: string;
  createdAt: number;
  appliedPanelIds: number[];
  previousPanels: PanelData[];
  previousAudioDurations: Record<number, number>;
  previousTimeline: SyncTimeline[];
  previousSrt: string;
  previousManifestEntries?: Record<string, ResourceManifestEntry>;
  /** Панели, у которых до этого импорта не было аудио (при отмене их файлы удаляются из OPFS). */
  newlyCreatedAudioPanelIds: number[];
}

export type ProjectEventType =
  | 'create'
  | 'import-audio'
  | 'undo-import-audio'
  | 'import-images'
  | 'replace-audio'
  | 'delete-audio'
  | 'trim'
  | 'split'
  | 'reorder'
  | 'gap-change'
  | 'scenario-apply'
  | 'tts-generate'
  | 'export'
  | 'archive-export'
  | 'archive-import'
  | 'migration'
  | 'health-check';

export interface ProjectEventEntry {
  id: string;
  timestamp: number;
  type: ProjectEventType;
  summary: string;
  details?: Record<string, unknown>;
}

export interface Project {
  id: string;
  name: string;
  /** Версия схемы проекта (Этап 1 п. 5, Этап 8 п. 74). */
  schemaVersion?: number;
  /** Версия формата таймлайна (Этап 1 п. 5). */
  timelineVersion?: number;
  /** Монотонный номер ревизии для optimistic locking (Этап 8 п. 80). */
  revision?: number;
  images: string[]; // Now: either data URLs (legacy) or OPFS filenames
  imageFiles?: string[]; // OPFS filenames if using OPFS
  useOPFS?: boolean;
  panels: PanelData[];
  characters: Character[];
  voiceAssignments: Record<string, string>;
  timeline: SyncTimeline[];
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  audioDurations?: Record<number, number>; // panelId -> duration, persisted
  /**
   * Снимок текста каждой панели на момент последней генерации аудио.
   * Нужен для мягкой миграции: у аудио до v1.3.2 нет .sig-подписи, и без снимка
   * нельзя отличить «текст не менялся» от «менялся, но файл остался старым».
   */
  audioTexts?: Record<number, string>;
  /** Манифест ресурсов проекта: контрольные суммы, MIME, размеры (Этап 8 п. 72, 73). */
  resourceManifest?: Record<string, ResourceManifestEntry>;
  /** Снимок для отмены последнего импорта аудио (Этап 2 п. 20). */
  lastAudioImportUndo?: LastAudioImportSnapshot | null;
  /** Журнал событий проекта (Этап 10 п. 99). */
  eventLog?: ProjectEventEntry[];
  srt: string;
  seoPackage: SEOPackage | null;
  settings: {
    ttsProvider: string;
    llmProvider: string;
    visionModel: string;
    /** Модель TTS для проекта (например eleven_multilingual_v2). */
    ttsModel?: string;
    /**
     * Отдельная модель для текста (перевод сценария и т.п.). Пусто — дефолт
     * провайдера. Отдельно от visionModel: перевод не требует vision, а
     * дефолт провайдера может быть vision-моделью.
     */
    chatModel?: string;
    /** Язык озвучки проекта: 'ru' | 'en' | ... */
    ttsLanguage?: string;
    /** Скорость речи (1.0 — обычная). */
    ttsSpeed?: number;
    /** Режим рендера: постранично ('panels', по умолчанию) или вертикальная лента ('strip'). */
    renderMode?: 'panels' | 'strip';
    /** Сколько px ленты видно в кадре по высоте (по умолчанию — высота кадра, 1080). */
    stripViewport?: number;
    /** Отступ между страницами ленты, px. */
    stripGap?: number;
    /**
     * Пауза (сек) между репликами: после завершения чтения — переход к
     * следующему изображению. По умолчанию 0,3; формат сценария задаёт 0,6.
     */
    panelGap?: number;
    /** Блокировка видеодорожки от изменений (Этап 6 п. 56). */
    videoTrackLocked?: boolean;
    /** Блокировка аудиодорожки от изменений (Этап 6 п. 56). */
    audioTrackLocked?: boolean;
    /** Отображать ли debug-оверлей (bbox и проценты) в Preview (Этап 7 п. 63). */
    debugOverlay?: boolean;
    /** Название канала (для fallback-интро/аутро и SEO). Пусто — настройки приложения → siteName. */
    channelName?: string;
    /** Подпись канала (опционально, для текстов). */
    channelTagline?: string;
    backgroundMusic?: string;
    musicVolume: number;
  };
  createdAt: number;
  updatedAt: number;
  sceneDescription?: string;
  // For task queue persistence
  taskProgress?: {
    completed: number;
    total: number;
    lastImageIndex: number;
  };
}

const MAX_EVENT_LOG_ENTRIES = 200;

/**
 * Добавляет запись в журнал событий проекта (чистая функция, возвращает новый массив).
 */
export function appendProjectEvent(
  existingLog: readonly ProjectEventEntry[] | undefined,
  entry: { type: ProjectEventType; summary: string; details?: Record<string, unknown>; timestamp?: number }
): ProjectEventEntry[] {
  const nextEntry: ProjectEventEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: entry.timestamp ?? Date.now(),
    type: entry.type,
    summary: entry.summary,
    ...(entry.details ? { details: entry.details } : {}),
  };
  const base = existingLog ? [...existingLog] : [];
  base.push(nextEntry);
  if (base.length > MAX_EVENT_LOG_ENTRIES) {
    return base.slice(base.length - MAX_EVENT_LOG_ENTRIES);
  }
  return base;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
/** In-memory хранилище для среды без IndexedDB (Node-тесты). */
const memoryStore = new Map<string, Project>();
/** Очередь сериализации сохранений по project.id для защиты от гонки при параллельных saveProject. */
const saveLocks = new Map<string, Promise<unknown>>();

function withProjectSaveLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = saveLocks.get(projectId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  saveLocks.set(
    projectId,
    next.then(
      () => undefined,
      () => undefined
    )
  );
  return next;
}

function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

export async function getDB(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (oldVersion < 3) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
      }
    }
  });
  return dbPromise;
}

/** Закрывает открытое соединение (нужно перед clearAllInfo/deleteDatabase). */
export async function closeDB(): Promise<void> {
  memoryStore.clear();
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {}
    dbPromise = null;
  }
}

export interface SaveProjectOptions {
  /**
   * Ожидаемая ревизия проекта (optimistic locking, Этап 8 п. 80).
   * Если в базе лежит более новая ревизия, сохранение бросает StaleProjectRevisionError.
   */
  expectedRevision?: number;
  /** Принудительная перезапись поверх любой ревизии (например, импорт ZIP или ручной откат). */
  allowStale?: boolean;
}

/**
 * Атомарное сохранение проекта с контролем ревизий (Этап 8, п. 71 и п. 80):
 * 1. Проверяет, что ревизия сохраняемого снимка не старше уже записанной в БД.
 * 2. Записывает временный snapshot (`__snapshot__:<id>`).
 * 3. Заменяет основную запись проекта с увеличенным номером `revision`.
 * 4. Удаляет временный snapshot.
 */
export async function saveProject(project: Project, options?: SaveProjectOptions): Promise<Project> {
  return withProjectSaveLock(project.id, async () => {
    const snapshotKey = `${SNAPSHOT_PREFIX}${project.id}`;
    const now = Date.now();

    if (!hasIndexedDB()) {
      const existing = memoryStore.get(project.id);
      const currentRev = existing?.revision ?? 0;
      if (!options?.allowStale) {
        if (options?.expectedRevision !== undefined) {
          const effectiveRev = Math.max(currentRev, project.revision ?? 0);
          if (effectiveRev > options.expectedRevision) {
            throw new StaleProjectRevisionError(project.id, effectiveRev, options.expectedRevision);
          }
        } else if (project.revision !== undefined && currentRev > project.revision) {
          throw new StaleProjectRevisionError(project.id, currentRev, project.revision);
        }
      }
      const nextRevision = currentRev + 1;
      project.updatedAt = now;
      project.revision = nextRevision;
      project.schemaVersion = project.schemaVersion ?? CURRENT_PROJECT_SCHEMA_VERSION;
      project.timelineVersion = project.timelineVersion ?? CURRENT_TIMELINE_VERSION;

      const cloned = structuredClone(project);
      memoryStore.set(snapshotKey, { ...cloned, id: snapshotKey });
      memoryStore.set(project.id, cloned);
      memoryStore.delete(snapshotKey);
      return project;
    }

    const db = await getDB();
    const existing = (await db.get('projects', project.id)) as Project | undefined;
    const currentRev = existing?.revision ?? 0;
    if (!options?.allowStale) {
      if (options?.expectedRevision !== undefined) {
        const effectiveRev = Math.max(currentRev, project.revision ?? 0);
        if (effectiveRev > options.expectedRevision) {
          throw new StaleProjectRevisionError(project.id, effectiveRev, options.expectedRevision);
        }
      } else if (project.revision !== undefined && currentRev > project.revision) {
        throw new StaleProjectRevisionError(project.id, currentRev, project.revision);
      }
    }

    const nextRevision = currentRev + 1;
    project.updatedAt = now;
    project.revision = nextRevision;
    project.schemaVersion = project.schemaVersion ?? CURRENT_PROJECT_SCHEMA_VERSION;
    project.timelineVersion = project.timelineVersion ?? CURRENT_TIMELINE_VERSION;

    // Step 1: Write temporary snapshot
    await db.put('projects', { ...project, id: snapshotKey });
    // Step 2: Replace main project entry
    await db.put('projects', project);
    // Step 3: Remove temporary snapshot
    try {
      await db.delete('projects', snapshotKey);
    } catch {}

    return project;
  });
}

export async function getProject(id: string): Promise<Project | undefined> {
  const snapshotKey = `${SNAPSHOT_PREFIX}${id}`;
  let project: Project | undefined;

  if (!hasIndexedDB()) {
    project = memoryStore.get(id);
    if (!project) {
      const recovered = memoryStore.get(snapshotKey);
      if (recovered) {
        project = { ...recovered, id };
        memoryStore.set(id, project);
        memoryStore.delete(snapshotKey);
      }
    }
    if (!project) return undefined;
  } else {
    const db = await getDB();
    project = await db.get('projects', id);
    if (!project) {
      // Восстановление из временного snapshot, если вкладка закрылась между шагами
      const recovered = await db.get('projects', snapshotKey);
      if (recovered) {
        project = { ...recovered, id };
        await db.put('projects', project);
        try { await db.delete('projects', snapshotKey); } catch {}
      }
    }
    if (!project) return undefined;
  }

  const lastChanged = Number(project.updatedAt) || Number(project.createdAt) || 0;
  if (lastChanged + PROJECT_TTL_MS <= Date.now()) {
    await deleteProject(id);
    return undefined;
  }
  return hasIndexedDB() ? project : structuredClone(project);
}

export async function getProjectWithImages(id: string): Promise<{ project: Project; imageDataUrls: string[] } | undefined> {
  const project = await getProject(id);
  if (!project) return undefined;

  let imageDataUrls: string[] = [];

  if (project.useOPFS && project.imageFiles) {
    try {
      for (const filename of project.imageFiles) {
        const dataUrl = await loadProjectImageAsDataURL(project.id, filename);
        imageDataUrls.push(dataUrl);
      }
    } catch (e) {
      console.error('Failed to load images from OPFS, falling back to stored data URLs', e);
      imageDataUrls = project.images;
    }
  } else {
    imageDataUrls = project.images;
  }

  return { project, imageDataUrls };
}

export async function getAllProjects(): Promise<Project[]> {
  const allRaw: Project[] = hasIndexedDB()
    ? await (await getDB()).getAll('projects')
    : [...memoryStore.values()].map(p => structuredClone(p));

  const all = allRaw.filter(p => !String(p.id).startsWith(SNAPSHOT_PREFIX));
  const cutoff = Date.now() - PROJECT_TTL_MS;
  const expired = all.filter(project => (Number(project.updatedAt) || Number(project.createdAt) || 0) <= cutoff);
  for (const project of expired) {
    await deleteProject(project.id);
  }
  return all
    .filter(project => (Number(project.updatedAt) || Number(project.createdAt) || 0) > cutoff)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  const snapshotKey = `${SNAPSHOT_PREFIX}${id}`;
  if (!hasIndexedDB()) {
    memoryStore.delete(id);
    memoryStore.delete(snapshotKey);
  } else {
    const db = await getDB();
    await db.delete('projects', id);
    try { await db.delete('projects', snapshotKey); } catch {}
  }
  try {
    if (await isOPFSSupported()) {
      await deleteProjectImages(id);
    }
  } catch {}
}

export async function createProject(name: string, images: string[] | Blob[]): Promise<Project> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const useOPFS = await isOPFSSupported();
  const appSettings = getSettings();

  const imageFiles: string[] = [];
  let storedImages: string[] = [];

  if (useOPFS) {
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let blob: Blob;
      if (typeof img === 'string') {
        const res = await fetch(img);
        blob = await res.blob();
      } else {
        blob = img as Blob;
      }
      const filename = await saveProjectImage(id, i, blob);
      imageFiles.push(filename);
    }
    storedImages = [];
  } else {
    for (const img of images) {
      if (typeof img === 'string') {
        storedImages.push(img);
      } else {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(img as Blob);
        });
        storedImages.push(dataUrl);
      }
    }
  }

  const now = Date.now();
  const project: Project = {
    id,
    name,
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    timelineVersion: CURRENT_TIMELINE_VERSION,
    revision: 0,
    images: storedImages,
    imageFiles: useOPFS ? imageFiles : undefined,
    useOPFS,
    panels: [],
    characters: [],
    voiceAssignments: {},
    timeline: [],
    intro: '',
    outro: '',
    introDuration: 8,
    outroDuration: 5,
    srt: '',
    seoPackage: null,
    resourceManifest: {},
    lastAudioImportUndo: null,
    eventLog: appendProjectEvent([], {
      type: 'create',
      summary: `Проект «${name}» создан (изображений: ${images.length})`,
      timestamp: now,
    }),
    settings: {
      ttsProvider: 'gemini',
      llmProvider: 'openrouter',
      visionModel: 'google/gemma-4-31b-it:free',
      musicVolume: 0.15,
      ...(appSettings.channelName?.trim() ? { channelName: appSettings.channelName.trim() } : {}),
      ...(appSettings.channelTagline?.trim() ? { channelTagline: appSettings.channelTagline.trim() } : {}),
    },
    createdAt: now,
    updatedAt: now,
    audioDurations: {},
  };
  await saveProject(project);
  return project;
}

// Helper to load images on demand without storing in memory all at once
export async function loadProjectImagesOnDemand(project: Project): Promise<string[]> {
  if (project.useOPFS && project.imageFiles) {
    const urls: string[] = [];
    for (const filename of project.imageFiles) {
      try {
        const dataUrl = await loadProjectImageAsDataURL(project.id, filename);
        urls.push(dataUrl);
      } catch (e) {
        console.error(`Failed to load image ${filename}`, e);
      }
    }
    return urls;
  }
  return project.images;
}
