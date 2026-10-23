"use client";

import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '@/lib/storage/db';
import { buildTimeline, calculateTotalDuration } from '@/lib/pipeline/buildTimeline';
import { formatSEOPackage } from '@/lib/pipeline/generateSEO';
import { concatenateAudioBlobs } from '@/lib/pipeline/assembleVideo';
import { buildTimelineAudioPlacements, type AudioPlacement } from '@/lib/pipeline/audioMix';
import { renderVideo } from '@/lib/pipeline/videoEncoder';
import { buildDiagnosticReportJson, renderExportAudioMixPreviewWav } from '@/lib/pipeline/projectHealth';
import { exportProjectToZip, importProjectFromZip } from '@/lib/storage/projectArchive';
import { loadProjectAudio, saveProjectAudio, saveProjectIntroAudio, saveProjectOutroAudio } from '@/lib/storage/opfs';
import { downloadBlob } from '@/lib/utils';
import { toast } from '@/lib/ui/feedback';
import type { ObjectUrlRegistry } from '@/lib/pipeline/objectUrlRegistry';
import type { RenderSettings } from '@/components/studio/RenderModePanel';

type HealthReport = ReturnType<typeof import('@/lib/pipeline/projectHealth').inspectProjectHealth>;

/**
 * Экспорт (P0-1): mp4/mp3/srt/seo, предпрослушивание микса, диагностический
 * JSON и архивация проекта в .zip.
 */
export function useEditorExport({
  project,
  audioDurations,
  audioBlobs,
  introAudio,
  outroAudio,
  images,
  panelGap,
  tl,
  duration,
  renderSettings,
  introAudioDuration,
  outroAudioDuration,
  healthReport,
  preferredBackend,
  clearExportedFile,
  urlRegistryRef,
  setProject,
  setImages,
  setNotice,
  setAudioWarnings,
  setIsExporting,
  setExportProgress,
  setExportStage,
  setExportEta,
  setExportAbortController,
  setExportedFile,
  setIntroAudio,
  setOutroAudio,
  setAudioBlobs,
  setAudioDurations,
  setShowHealthModal,
}: {
  project: Project | null;
  audioDurations: Map<number, number>;
  audioBlobs: Map<number, Blob>;
  introAudio: Blob | null;
  outroAudio: Blob | null;
  images: string[];
  panelGap: number;
  tl: Project['timeline'];
  duration: number;
  renderSettings: RenderSettings;
  introAudioDuration: number | null;
  outroAudioDuration: number | null;
  healthReport: HealthReport | null;
  preferredBackend: 'auto' | 'webcodecs' | 'canvas';
  clearExportedFile: () => void;
  urlRegistryRef: { current: ObjectUrlRegistry };
  setProject: Dispatch<SetStateAction<Project | null>>;
  setImages: Dispatch<SetStateAction<string[]>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  setAudioWarnings: Dispatch<SetStateAction<string[]>>;
  setIsExporting: Dispatch<SetStateAction<boolean>>;
  setExportProgress: Dispatch<SetStateAction<number>>;
  setExportStage: Dispatch<SetStateAction<string>>;
  setExportEta: Dispatch<SetStateAction<number | null>>;
  setExportAbortController: Dispatch<SetStateAction<AbortController | null>>;
  setExportedFile: Dispatch<SetStateAction<{ blob: Blob; filename: string; url: string } | null>>;
  setIntroAudio: Dispatch<SetStateAction<Blob | null>>;
  setOutroAudio: Dispatch<SetStateAction<Blob | null>>;
  setAudioBlobs: Dispatch<SetStateAction<Map<number, Blob>>>;
  setAudioDurations: Dispatch<SetStateAction<Map<number, number>>>;
  setShowHealthModal: Dispatch<SetStateAction<boolean>>;
}) {
  const handleExport = async (type: 'mp4' | 'mp3' | 'srt' | 'seo' | 'all') => {
    if (!project) return;
    setIsExporting(true);
    try {
      if (type === 'srt' || type === 'all') {
        if (project.srt) downloadBlob(new Blob([project.srt], { type: 'text/plain' }), `${project.name}.srt`);
        else if (type === 'srt') toast('Нет SRT, сначала озвучь', 'error');
      }
      if (type === 'seo' || type === 'all') {
        if (project.seoPackage) downloadBlob(new Blob([formatSEOPackage(project.seoPackage)], { type: 'text/plain' }), `${project.name}-SEO.txt`);
        else if (type === 'seo') toast('Нет SEO пакета', 'error');
      }
      if (type === 'mp3' || type === 'all') {
        const exportTimeline =
          project.timeline.length > 0
            ? project.timeline
            : buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, panelGap);
        const resolvedPanelBlobs = new Map<number, Blob>(audioBlobs);
        for (const p of project.panels) {
          if (!resolvedPanelBlobs.has(p.id)) {
            const fromOpfs = await loadProjectAudio(project.id, p.id);
            if (fromOpfs) resolvedPanelBlobs.set(p.id, fromOpfs);
          }
        }
        const placements = buildTimelineAudioPlacements({
          timeline: exportTimeline,
          panels: project.panels,
          panelBlobs: resolvedPanelBlobs,
          introAudio,
          outroAudio,
          introDuration: project.introDuration,
          outroDuration: project.outroDuration,
        });
        if (placements.length > 0) {
          const totalExportDuration = calculateTotalDuration(
            exportTimeline,
            project.introDuration,
            project.outroDuration
          );
          const mixedWav = await renderExportAudioMixPreviewWav(placements, totalExportDuration);
          if (mixedWav) {
            downloadBlob(mixedWav, `${project.name}.wav`);
          } else {
            const merged = await concatenateAudioBlobs(placements.map(item => item.blob));
            const ext = merged.type.includes('wav') ? 'wav' : merged.type.includes('mpeg') ? 'mp3' : 'bin';
            downloadBlob(merged, `${project.name}.${ext}`);
          }
        } else if (type === 'mp3') toast('Сначала озвучь', 'error');
      }
      if (type === 'mp4') {
        if (images.length === 0) {
          toast('Нет изображений для видео', 'error');
          return;
        }
        const tl = project.timeline.length > 0 ? project.timeline : buildTimeline(project.panels, audioDurations, project.voiceAssignments, project.introDuration, panelGap);

        // Точные позиции аудио на таймлайне с учётом trimIn/trimOut, gain, fadeIn/fadeOut и mute/solo (Этап 9 п. 82, 83)
        const resolvedPanelBlobs = new Map<number, Blob>(audioBlobs);
        for (const p of project.panels) {
          if (!resolvedPanelBlobs.has(p.id)) {
            const fromOpfs = await loadProjectAudio(project.id, p.id);
            if (fromOpfs) resolvedPanelBlobs.set(p.id, fromOpfs);
          }
        }
        const audioPlacements: AudioPlacement[] = buildTimelineAudioPlacements({
          timeline: tl,
          panels: project.panels,
          panelBlobs: resolvedPanelBlobs,
          introAudio,
          outroAudio,
          introDuration: project.introDuration,
          outroDuration: project.outroDuration,
        });

        if (audioPlacements.length === 0) {
          toast('Сначала озвучь — нет аудио для видео. Экспортирую без звука.');
        }

        clearExportedFile();
        setExportProgress(0);
        setExportStage('Подготовка...');
        setExportEta(null);
        const controller = new AbortController();
        setExportAbortController(controller);

        const startTime = Date.now();
        const { blob, mimeType } = await renderVideo({
          images,
          audioBlobs: audioPlacements.map(a => a.blob),
          audioPlacements,
          timeline: tl,
          introText: project.intro,
          outroText: project.outro,
          introDuration: project.introDuration,
          outroDuration: project.outroDuration,
          introAudioDuration,
          outroAudioDuration,
          srtContent: project.srt,
          width: 1920,
          height: 1080,
          fps: 30,
          renderMode: renderSettings.renderMode,
          stripViewport: renderSettings.stripViewport,
          stripGap: renderSettings.stripGap,
          panels: project.panels.map(p => ({ id: p.id, imageIndex: p.imageIndex, bbox: p.bbox, fullFrame: p.fullFrame })),
          onAudioTrimmed: (messages) => setAudioWarnings(messages),
          onProgress: (p, stage) => {
            setExportProgress(p);
            if (stage) setExportStage(stage);
            const elapsed = (Date.now() - startTime) / 1000;
            if (p > 0.01) {
              setExportEta(Math.max(0, Math.round((elapsed / p) * (1 - p))));
            }
          },
          signal: controller.signal,
          preferredBackend: preferredBackend === 'auto' ? undefined : preferredBackend
        });

        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const url = URL.createObjectURL(blob);
        setExportedFile({ blob, filename: `${project.name}.${ext}`, url });
      }
    } catch (e: any) {
      clearExportedFile();
      if (e?.name === 'AbortError') {
        setNotice('Экспорт видео отменён.');
      } else {
        toast(`Ошибка экспорта: ${e.message}`, 'error');
      }
    } finally {
      setIsExporting(false);
      setExportProgress(0);
      setExportStage('');
      setExportEta(null);
      setExportAbortController(null);
    }
  };

  /** Предпрослушивание финального аудиомикса перед экспортом видео (Этап 9 п. 87). */
  const handlePreviewAudioMix = async (): Promise<string | null> => {
    if (!project) return null;
    const resolvedPanelBlobs = new Map<number, Blob>(audioBlobs);
    for (const p of project.panels) {
      if (!resolvedPanelBlobs.has(p.id)) {
        const fromOpfs = await loadProjectAudio(project.id, p.id);
        if (fromOpfs) resolvedPanelBlobs.set(p.id, fromOpfs);
      }
    }
    const placements = buildTimelineAudioPlacements({
      timeline: tl,
      panels: project.panels,
      panelBlobs: resolvedPanelBlobs,
      introAudio,
      outroAudio,
      introDuration: project.introDuration,
      outroDuration: project.outroDuration,
    });
    const wavBlob = await renderExportAudioMixPreviewWav(placements, duration);
    if (!wavBlob) return null;
    return urlRegistryRef.current.acquire('export:mix-preview', wavBlob).url;
  };

  /** Скачивание диагностического JSON-отчёта о проекте и синхронизации (Этап 9 п. 88). */
  const handleDownloadDiagnosticJson = () => {
    if (!project || !healthReport) return;
    const json = buildDiagnosticReportJson(project, healthReport);
    downloadBlob(
      new Blob([json], { type: 'application/json;charset=utf-8' }),
      `${project.name || project.id}-diagnostics.json`
    );
  };

  /** Полный экспорт проекта в .zip с проверкой контрольных сумм (Этап 8 п. 76). */
  const handleExportProjectZip = async () => {
    if (!project) return;
    try {
      const audioMap = new Map<number | 'intro' | 'outro', Blob>();
      for (const [idKey, blob] of audioBlobs.entries()) audioMap.set(idKey, blob);
      if (introAudio) audioMap.set('intro', introAudio);
      if (outroAudio) audioMap.set('outro', outroAudio);
      const { blob } = await exportProjectToZip(project, {
        images,
        audio: audioMap,
      });
      downloadBlob(blob, `${project.name || project.id}.zip`);
    } catch (e) {
      setNotice(`Не удалось экспортировать архив проекта: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /** Восстановление проекта из .zip с верификацией SHA-256 (Этап 8 п. 77). */
  const handleImportProjectZip = async (file: File) => {
    try {
      const restored = await importProjectFromZip(file);
      const nextBlobs = new Map<number, Blob>();
      const nextDurations = new Map<number, number>();
      for (const [slotKey, blob] of restored.audio.entries()) {
        if (slotKey === 'intro') {
          setIntroAudio(blob);
          try { await saveProjectIntroAudio(restored.project.id, blob); } catch {}
        } else if (slotKey === 'outro') {
          setOutroAudio(blob);
          try { await saveProjectOutroAudio(restored.project.id, blob); } catch {}
        } else {
          nextBlobs.set(slotKey, blob);
          try { await saveProjectAudio(restored.project.id, slotKey, blob); } catch {}
        }
      }
      for (const [k, v] of Object.entries(restored.project.audioDurations ?? {})) {
        nextDurations.set(Number(k), v);
      }
      setProject(restored.project);
      setImages(restored.imageDataUrls);
      setAudioBlobs(nextBlobs);
      setAudioDurations(nextDurations);
      setShowHealthModal(false);
      setNotice(`Проект успешно восстановлен из архива (проверено ресурсов: ${restored.verifiedCount}).`);
    } catch (e) {
      setNotice(`Ошибка восстановления из архива: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Memoize timeline to avoid recalculating on every render (perf fix for 30+ panels)
  /** Сценарий текущего проекта текстом: модалка открывается с этим содержимым. */
  return {
    handleExport,
    handlePreviewAudioMix,
    handleDownloadDiagnosticJson,
    handleExportProjectZip,
    handleImportProjectZip,
  };
}
