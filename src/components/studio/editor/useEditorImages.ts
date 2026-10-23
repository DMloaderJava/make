"use client";

import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import { isOPFSSupported, saveProjectImage } from '@/lib/storage/opfs';

/**
 * Добавление изображений в существующий проект (P0-1).
 *
 * Дублирует путь загрузки с главной, но с докачкой в OPFS и без пересоздания
 * проекта: раньше жило прямо в контроллере редактора.
 */
export function useEditorImages({
  project,
  images,
  updateProject,
  setImages,
  setNotice,
  setIsUploadingImages,
}: {
  project: Project | null;
  images: string[];
  updateProject: (updates: Partial<Project>) => void;
  setImages: Dispatch<SetStateAction<string[]>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setIsUploadingImages: Dispatch<SetStateAction<boolean>>;
}) {
  const handleAddImages = async (fileList: FileList | File[]) => {
    if (!project) return;
    const files = Array.from(fileList).filter(file => file.type.startsWith('image/'));
    if (files.length === 0) {
      setNotice('Выберите файлы изображений.');
      return;
    }
    setIsUploadingImages(true);
    try {
      const nextImages: string[] = [];
      const nextFiles = [...(project.imageFiles || [])];
      const useOPFS = project.useOPFS && await isOPFSSupported();
      for (const [offset, file] of files.entries()) {
        const index = images.length + offset;
        if (useOPFS) {
          nextFiles.push(await saveProjectImage(project.id, index, file));
        } else {
          nextImages.push(await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error(`Не удалось прочитать ${file.name}`));
            reader.readAsDataURL(file);
          }));
        }
      }
      const combinedImages = useOPFS ? images : [...images, ...nextImages];
      setImages(combinedImages);
      updateProject({
        images: useOPFS ? project.images : [...project.images, ...nextImages],
        imageFiles: useOPFS ? nextFiles : project.imageFiles,
        useOPFS,
      });
      setNotice(`Добавлено изображений: ${files.length}. Всего в проекте: ${combinedImages.length}.`);
    } catch (error) {
      setNotice(`Не удалось добавить изображения: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsUploadingImages(false);
    }
  };

  return { handleAddImages };
}
