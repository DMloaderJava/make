import { openDB, IDBPDatabase } from 'idb';
import { isOPFSSupported, saveProjectImage, loadProjectImageAsDataURL, deleteProjectImages } from './opfs';
import { INFO_IDB_NAME } from './info';
import { getSettings } from './local';

const DB_NAME = INFO_IDB_NAME;
const DB_VERSION = 3;

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

export interface Project {
  id: string;
  name: string;
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

let dbPromise: Promise<IDBPDatabase> | null = null;

export async function getDB(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (oldVersion < 3) {
        // Migration for OPFS support
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
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {}
    dbPromise = null;
  }
}

export async function saveProject(project: Project): Promise<void> {
  const db = await getDB();
  project.updatedAt = Date.now();
  await db.put('projects', project);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const db = await getDB();
  const project = await db.get('projects', id);
  if (!project) return undefined;
  // OPFS images are loaded on demand via getProjectWithImages, not here to save memory
  return project;
}

export async function getProjectWithImages(id: string): Promise<{ project: Project; imageDataUrls: string[] } | undefined> {
  const project = await getProject(id);
  if (!project) return undefined;

  let imageDataUrls: string[] = [];

  if (project.useOPFS && project.imageFiles) {
    // Load from OPFS
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
  const db = await getDB();
  const all = await db.getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('projects', id);
  // Also delete OPFS files
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
  
  let imageFiles: string[] = [];
  let storedImages: string[] = [];

  if (useOPFS) {
    // Save to OPFS
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let blob: Blob;
      if (typeof img === 'string') {
        // data URL to blob
        const res = await fetch(img);
        blob = await res.blob();
      } else {
        blob = img as Blob;
      }
      const filename = await saveProjectImage(id, i, blob);
      imageFiles.push(filename);
    }
    // Don't store base64 in IDB, only filenames
    storedImages = [];
  } else {
    // Fallback: store as data URLs (old behavior)
    for (const img of images) {
      if (typeof img === 'string') {
        storedImages.push(img);
      } else {
        // Blob to data URL
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(img as Blob);
        });
        storedImages.push(dataUrl);
      }
    }
  }

  const project: Project = {
    id,
    name,
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
    settings: {
      ttsProvider: 'gemini',
      llmProvider: 'openrouter',
      visionModel: 'google/gemma-4-31b-it:free',
      musicVolume: 0.15,
      // Канал: дефолты новых проектов — из настроек приложения.
      ...(appSettings.channelName?.trim() ? { channelName: appSettings.channelName.trim() } : {}),
      ...(appSettings.channelTagline?.trim() ? { channelTagline: appSettings.channelTagline.trim() } : {}),
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
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
