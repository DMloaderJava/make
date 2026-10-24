"use client";

/**
 * Определение длительности аудио для редактора.
 *
 * Живёт вне компонента: функции не трогают состояние React, а раньше занимали
 * верх `src/app/editor/[id]/page.tsx` (P0-1).
 */

let editorAudioContext: AudioContext | null = null;

export function getEditorAudioContext(): AudioContext {
  if (!editorAudioContext || editorAudioContext.state === 'closed') {
    editorAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return editorAudioContext;
}

export async function getAudioDuration(blob: Blob): Promise<number> {
  try {
    const ctx = getEditorAudioContext();
    const ab = await blob.arrayBuffer();
    const dec = await ctx.decodeAudioData(ab.slice(0));
    if (isFinite(dec.duration) && dec.duration > 0) return dec.duration;
    return 2;
  } catch {
    return 2;
  }
}

export async function getImportedAudioDuration(blob: Blob): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const duration = await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve(audio.duration);
      audio.onerror = () => reject(new Error('Формат аудио не поддержан браузером или файл повреждён'));
      audio.src = url;
    });
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность аудио');
    return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
}
