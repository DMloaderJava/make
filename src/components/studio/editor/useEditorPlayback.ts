"use client";

import { useEffect, useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import { ProjectClock } from '@/lib/pipeline/projectClock';
import { UnifiedAudioPlayer } from '@/lib/pipeline/audioPlayer';
import type { ObjectUrlRegistry } from '@/lib/pipeline/objectUrlRegistry';

/**
 * Воспроизведение (P0-1): подписка на ProjectClock, синхронизация плеера,
 * горячие клавиши и seek.
 *
 * Единственное место, где вызывается setCurrentTime: rAF-тики часов (60 fps)
 * не проходят через React-состояние — превью рисует кадры собственным rAF,
 * таймлайн двигает плейхед императивно, а дерево React перерисовывается только
 * на дискретных событиях (seek/play/pause/горячие клавиши/конец воспроизведения).
 */
export function useEditorPlayback({
  project,
  tl,
  duration,
  audioBlobs,
  introAudio,
  outroAudio,
  isPlaying,
  currentTime,
  currentTimeRef,
  clockRef,
  playerRef,
  urlRegistryRef,
  setCurrentTime,
  setIsPlaying,
  setAudioError,
  setShowExport,
  setCurrentPanelIdx,
  setSelectedId,
}: {
  project: Project | null;
  tl: Project['timeline'];
  duration: number;
  audioBlobs: Map<number, Blob>;
  introAudio: Blob | null;
  outroAudio: Blob | null;
  isPlaying: boolean;
  currentTime: number;
  currentTimeRef: { current: number };
  clockRef: { current: ProjectClock };
  playerRef: { current: UnifiedAudioPlayer | null };
  urlRegistryRef: { current: ObjectUrlRegistry };
  setCurrentTime: Dispatch<SetStateAction<number>>;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  setAudioError: Dispatch<SetStateAction<string | null>>;
  setShowExport: Dispatch<SetStateAction<boolean>>;
  setCurrentPanelIdx: Dispatch<SetStateAction<number>>;
  setSelectedId: Dispatch<SetStateAction<number | 'intro' | 'outro' | null>>;
}) {
  // Синхронизируем ref в эффекте: к моменту старта воспроизведения значение
  // уже актуально.
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime, currentTimeRef]);

  // Единая подписка на ProjectClock (Задача 1: единственный вызов setCurrentTime в EditorPage;
  // P1 п. 14: rAF-тики троттлятся для React-дерева EditorPage до ~20 Гц, в то время как Preview
  // читает clock.getTime() напрямую в своём Canvas rAF на полных 60 fps)
  useEffect(() => {
    const clock = clockRef.current;
    const player = new UnifiedAudioPlayer({
      clock,
      registry: urlRegistryRef.current,
      onError: (formatted) => {
        if (formatted.kind === 'aborted') return;
        setAudioError(formatted.message);
      },
    });
    playerRef.current = player;

    let lastPlayingState = clock.getIsPlaying();

    const unsubscribe = clock.subscribe((snap) => {
      // ref обновляется на каждом тике (60 Гц), чтобы не-React потребители
      // (hotkeys, NLE) всегда видели актуальное время без перерисовки дерева.
      currentTimeRef.current = snap.currentTime;
      if (snap.isPlaying !== lastPlayingState) {
        lastPlayingState = snap.isPlaying;
        setIsPlaying(snap.isPlaying);
      }
      // Высокочастотные события (rAF-тики, ручная прокрутка ленты колесом и
      // перетаскиванием) не должны будить React-дерево 60 раз в секунду:
      // Preview рисует кадры собственным rAF, а Timeline двигает плейхед
      // императивно по своей подписке на эти же часы. В React-состояние время
      // пишем только на дискретных событиях (seek, play, pause, hotkey, конец);
      // колесо/drag досинхронизируют состояние финальным onSeek при остановке.
      if (snap.reason === 'raf' || snap.reason === 'wheel' || snap.reason === 'drag') {
        return;
      }
      setCurrentTime(snap.currentTime);
    });

    return () => {
      unsubscribe();
      player.dispose();
      playerRef.current = null;
      urlRegistryRef.current.revokeAll();
    };
  }, []);

  // ЕДИНЫЙ источник времени превью: таймлайн, по которому считаются и
  // длительность (clock), и сегменты Timeline, и траектория скролла ленты.
  // Раньше duration строился ОТДЕЛЬНО (fresh buildTimeline), а tl брал
  // сохранённый project.timeline — при рассинхроне часы и лента разъезжались.

  useEffect(() => {
    clockRef.current.setDuration(duration);
  }, [duration]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !project) return;
    if (!isPlaying) {
      player.pause();
      return;
    }
    if (!duration || duration <= 0 || !isFinite(duration)) {
      clockRef.current.pause('pause');
      return;
    }

    const effectiveBlobs = new Map<number, Blob>(audioBlobs);
    for (const p of project.panels) {
      if (!effectiveBlobs.has(p.id) && p.sourceAudioPanelId !== undefined) {
        const parentBlob = audioBlobs.get(p.sourceAudioPanelId);
        if (parentBlob) effectiveBlobs.set(p.id, parentBlob);
      }
    }

    void player.syncPlayback({
      timeline: tl,
      introDuration: project.introDuration,
      outroDuration: project.outroDuration,
      introAudio,
      outroAudio,
      panelBlobs: effectiveBlobs,
    });
  }, [isPlaying, duration, tl, introAudio, outroAudio, audioBlobs, project]);

  // Актуальный handleSave для хоткеев: эффект ниже намеренно без deps,
  // поэтому состояние берём из ref. Ref объявлен до эффекта — читать его

  const handleSaveRef = useRef<() => Promise<void>>(async () => {});
  const handleUndoRef = useRef<() => void>(() => {});
  const handleRedoRef = useRef<() => void>(() => {});
  const handleSplitRef = useRef<() => void>(() => {});

  // Hotkeys with input guard (Space, J/K/L, arrows, S for split, Ctrl+Z / Ctrl+Shift+Z, Этап 10 п. 95; Задача 1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (isInput) {
        if (!((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'e'))) return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) handleRedoRef.current();
        else handleUndoRef.current();
        return;
      }
      if (e.code === 'Space' || (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        clockRef.current.togglePlayPause();
      } else if (e.code === 'ArrowLeft' || (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'j')) {
        e.preventDefault();
        clockRef.current.seek(Math.max(0, clockRef.current.getTime() - 5), 'seek');
      } else if (e.code === 'ArrowRight' || (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'l')) {
        e.preventDefault();
        clockRef.current.seek(Math.min(duration, clockRef.current.getTime() + 5), 'seek');
      } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSplitRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void handleSaveRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'e') {
        e.preventDefault();
        setShowExport(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [duration]);


  const handleSeek = useCallback((t: number) => {
    if (!isFinite(t)) return;
    playerRef.current?.pause();
    clockRef.current.pause('pause');
    clockRef.current.seek(t, 'seek');
    if (!project) return;
    const seg = tl.find(s => t >= s.audioStart && t < s.audioEnd);
    if (seg) {
      const idx = project.panels.findIndex(p => p.id === seg.panelId);
      if (idx !== -1) {
        setCurrentPanelIdx(idx);
        setSelectedId(seg.panelId);
      }
    }
  }, [project, tl]);

  return {
    handleSeek,
    handleSaveRef,
    handleUndoRef,
    handleRedoRef,
    handleSplitRef,
  };
}
