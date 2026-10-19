/**
 * Детерминированный менеджер истории (Undo / Redo) для всех правок таймлайна и сценария
 * (Этап 6, пункт 60; Этап 10, пункт 95).
 */

import type { PanelData, SyncTimeline } from '../storage/db';

export interface NleHistorySnapshot {
  label: string;
  timestamp: number;
  panels: PanelData[];
  audioDurations: Record<number, number>;
  timeline: SyncTimeline[];
  srt: string;
  panelGap?: number;
  videoTrackLocked?: boolean;
  audioTrackLocked?: boolean;
}

function cloneSnapshot(snap: NleHistorySnapshot): NleHistorySnapshot {
  return {
    label: snap.label,
    timestamp: snap.timestamp,
    panels: snap.panels.map(p => ({ ...p, bbox: { ...p.bbox } })),
    audioDurations: { ...snap.audioDurations },
    timeline: snap.timeline.map(s => ({ ...s })),
    srt: snap.srt,
    panelGap: snap.panelGap,
    videoTrackLocked: snap.videoTrackLocked,
    audioTrackLocked: snap.audioTrackLocked,
  };
}

export class HistoryManager {
  private undoStack: NleHistorySnapshot[] = [];
  private redoStack: NleHistorySnapshot[] = [];
  private maxDepth: number;

  constructor(maxDepth = 50) {
    this.maxDepth = Math.max(1, maxDepth);
  }

  /**
   * Записывает текущее состояние перед применением новой операции и очищает стек Redo.
   */
  record(snapshot: NleHistorySnapshot): void {
    this.undoStack.push(cloneSnapshot(snapshot));
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getUndoDepth(): number {
    return this.undoStack.length;
  }

  getRedoDepth(): number {
    return this.redoStack.length;
  }

  getLastUndoLabel(): string | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  getLastRedoLabel(): string | null {
    return this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  /**
   * Выполняет отмену (Undo): сохраняет `currentState` в стек Redo и возвращает предыдущий снимок.
   */
  undo(currentState: NleHistorySnapshot): NleHistorySnapshot | null {
    if (this.undoStack.length === 0) return null;
    const prev = this.undoStack.pop()!;
    this.redoStack.push(cloneSnapshot(currentState));
    return cloneSnapshot(prev);
  }

  /**
   * Выполняет повтор (Redo): сохраняет `currentState` в стек Undo и возвращает отменённый снимок.
   */
  redo(currentState: NleHistorySnapshot): NleHistorySnapshot | null {
    if (this.redoStack.length === 0) return null;
    const next = this.redoStack.pop()!;
    this.undoStack.push(cloneSnapshot(currentState));
    return cloneSnapshot(next);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
