"use client";

import { useState } from 'react';
import { BackendCapabilities } from '@/lib/pipeline/videoEncoder';
import type { ProjectHealthReport } from '@/lib/pipeline/projectHealth';

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  onExport: (type: 'mp4' | 'mp3' | 'srt' | 'seo' | 'all') => void;
  hasAudio: boolean;
  hasSRT: boolean;
  /** SRT собран из оценочных длительностей (озвучка ещё не готова) — «черновик». */
  srtDraft?: boolean;
  hasSEO: boolean;
  duration: number;
  backendCaps: BackendCapabilities | null;
  preferredBackend: string;
  onBackendChange: (b: 'auto' | 'webcodecs' | 'canvas') => void;
  isExporting: boolean;
  costEstimate: { characters: number; cost: string } | null;
  onGenerateSEO?: () => void;
  generatingSEO?: boolean;
  /** Отчёт предэкспортной проверки ресурсов, синхронизации и длительностей (Этап 9 п. 84–89). */
  healthReport?: ProjectHealthReport;
  /** Генерация WAV URL для предпрослушивания финального аудиомикса перед рендером (Этап 9 п. 87). */
  onPreviewAudioMix?: () => Promise<string | null>;
  /** Скачивание диагностического JSON-отчёта (Этап 9 п. 88). */
  onDownloadDiagnosticJson?: () => void;
}

export function ExportModal({
  open,
  onClose,
  onExport,
  hasAudio,
  hasSRT,
  srtDraft,
  hasSEO,
  duration,
  backendCaps,
  preferredBackend,
  onBackendChange,
  isExporting,
  costEstimate,
  onGenerateSEO,
  generatingSEO,
  healthReport,
  onPreviewAudioMix,
  onDownloadDiagnosticJson,
}: ExportModalProps) {
  const [mixPreviewUrl, setMixPreviewUrl] = useState<string | null>(null);
  const [buildingMixPreview, setBuildingMixPreview] = useState(false);

  if (!open) return null;

  const exactDuration = healthReport?.exactDuration ?? duration;

  const formatTime = (s: number) => {
    if (!isFinite(s) || s <= 0) return '00:00.0';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const tenth = Math.floor((s % 1) * 10);
    return `${m}:${String(sec).padStart(2, '0')}.${tenth}`;
  };

  const handlePreviewMix = async () => {
    if (!onPreviewAudioMix || buildingMixPreview) return;
    setBuildingMixPreview(true);
    try {
      const url = await onPreviewAudioMix();
      setMixPreviewUrl(url);
    } finally {
      setBuildingMixPreview(false);
    }
  };

  const blockingErrors = healthReport?.issues.filter(i => i.severity === 'error') ?? [];
  const exportWarnings = healthReport?.issues.filter(i => i.severity === 'warning') ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0B0C]/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[460px] bg-[#16161A] border border-[#26262C] rounded-[16px] shadow-2xl overflow-hidden max-h-[88vh] flex flex-col">
        <div className="p-5 border-b border-[#26262C] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-medium">Экспорт</h2>
            <p className="text-[11px] text-[#8A8A93] font-mono mt-0.5">
              Точная длительность (Timeline = SRT): {formatTime(exactDuration)} ({exactDuration.toFixed(2)} с)
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-[6px] bg-[#1E1E23] hover:bg-[#26262C] flex items-center justify-center text-[#8A8A93]"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {backendCaps && (
            <div className="bg-[#0B0B0C] border border-[#26262C] rounded-[10px] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">Видео бэкенд</span>
                <span className="font-mono text-[11px] text-[#8A8A93]">
                  {backendCaps.h264 ? 'MP4 готов' : 'WEBM fallback'}
                </span>
              </div>
              <select
                value={preferredBackend}
                onChange={e => onBackendChange(e.target.value as any)}
                className="flex h-8 w-full rounded-[6px] border border-[#26262C] bg-[#16161A] px-2 text-xs"
              >
                <option value="auto">Авто ({backendCaps.h264 ? 'MP4 H.264' : 'WEBM VP9'})</option>
                <option value="webcodecs">MP4 H.264+AAC (WebCodecs)</option>
                <option value="canvas">WEBM VP9 (Canvas)</option>
              </select>
              <div className="flex gap-1.5 text-[10px]">
                <span
                  className={`px-1.5 py-0.5 rounded ${
                    backendCaps.h264 ? 'bg-[#4ADE80]/10 text-[#4ADE80]' : 'bg-[#26262C] text-[#8A8A93]'
                  }`}
                >
                  H.264 {backendCaps.h264 ? '✅' : '❌'}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded ${
                    backendCaps.mediabunny ? 'bg-[#4ADE80]/10 text-[#4ADE80]' : 'bg-[#26262C] text-[#8A8A93]'
                  }`}
                >
                  mediabunny {backendCaps.mediabunny ? '✅' : '❌'}
                </span>
              </div>
            </div>
          )}

          {/* Предэкспортная диагностика ресурсов и длительностей клипов (Этап 9 п. 84, 86, 89) */}
          {blockingErrors.length > 0 && (
            <div className="rounded-[10px] bg-red-500/10 border border-red-500/30 p-3 space-y-1 text-[11px] text-red-200">
              <div className="font-semibold text-red-300">Ошибки перед экспортом ({blockingErrors.length}):</div>
              {blockingErrors.slice(0, 4).map(err => (
                <div key={err.id}>• {err.message}</div>
              ))}
            </div>
          )}

          {exportWarnings.length > 0 && (
            <div className="rounded-[10px] bg-amber-500/10 border border-amber-500/25 p-3 space-y-1 text-[11px] text-amber-200">
              <div className="font-semibold text-amber-300">Предупреждения ({exportWarnings.length}):</div>
              {exportWarnings.slice(0, 3).map(w => (
                <div key={w.id}>⚠ {w.message}</div>
              ))}
            </div>
          )}

          {/* Предпрослушивание финального аудиомикса перед рендером видео (Этап 9 п. 87) */}
          {onPreviewAudioMix && hasAudio && (
            <div className="bg-[#0B0B0C] border border-[#26262C] rounded-[10px] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#F5F5F7]">Предпрослушивание аудиомикса</span>
                <button
                  type="button"
                  onClick={() => void handlePreviewMix()}
                  disabled={buildingMixPreview || isExporting}
                  className="px-2.5 py-1 rounded bg-[#1E1E23] hover:bg-[#26262C] text-[11px] text-[#E8B44C] disabled:opacity-50"
                >
                  {buildingMixPreview ? 'Сборка микса...' : mixPreviewUrl ? '↻ Обновить микс' : '▶ Собрать превью микса'}
                </button>
              </div>
              {mixPreviewUrl && (
                <audio src={mixPreviewUrl} controls className="w-full h-8" preload="metadata" />
              )}
            </div>
          )}

          <div className="space-y-2">
            <button
              onClick={() => onExport('mp4')}
              disabled={isExporting || blockingErrors.length > 0}
              className={`w-full p-3 rounded-[10px] border text-left transition-colors duration-[150ms] disabled:opacity-50 ${
                hasAudio
                  ? 'bg-[#0B0B0C] border-[#26262C] hover:border-[#E8B44C]/50 hover:bg-[#1E1E23]'
                  : 'bg-[#0B0B0C] border-[#F87171]/20 hover:bg-[#1E1E23]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">
                  🎬 {backendCaps?.h264 ? 'MP4' : 'WEBM'} — 1920×1080
                </span>
                <span className="font-mono text-[11px] text-[#8A8A93]">{formatTime(exactDuration)}</span>
              </div>
              <p className={`text-[11px] mt-1 ${hasAudio ? 'text-[#8A8A93]' : 'text-[#F87171]'}`}>
                {hasAudio
                  ? backendCaps?.h264
                    ? 'H.264 + AAC, готово для YouTube (импортированное аудио пишется напрямую без TTS)'
                    : 'VP9, конвертируй в MP4 через FFmpeg'
                  : '⚠ Сначала озвучь — нет аудио, но можно попробовать'}
              </p>
            </button>

            <button
              onClick={() => onExport('mp3')}
              disabled={isExporting}
              className={`w-full p-3 rounded-[10px] border text-left transition-colors disabled:opacity-50 ${
                hasAudio
                  ? 'bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]'
                  : 'bg-[#0B0B0C] border-[#26262C] opacity-60'
              }`}
            >
              <span className="text-[13px] font-medium">🎵 MP3 — только аудио</span>
              <p className="text-[11px] text-[#8A8A93] mt-1">
                Склейка из OPFS кэша с учётом Trim/Gain/Fade {hasAudio ? '' : '(нет аудио)'}
              </p>
            </button>

            <button
              onClick={() => onExport('srt')}
              disabled={isExporting}
              className={`w-full p-3 rounded-[10px] border text-left transition-colors disabled:opacity-50 ${
                hasSRT
                  ? 'bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]'
                  : 'bg-[#0B0B0C] border-[#26262C] opacity-60'
              }`}
            >
              <span className="text-[13px] font-medium">
                📝 SRT — субтитры
                {srtDraft ? <span className="text-[#8A8A93] font-normal"> · черновик</span> : ''}
              </span>
              <p className="text-[11px] text-[#8A8A93] mt-1">
                Из таймлайна ({formatTime(exactDuration)}) {hasSRT ? '' : '(нет SRT)'}
                {srtDraft ? ' · точные тайминги после озвучки' : ''}
              </p>
            </button>

            <button
              onClick={() => onExport('seo')}
              disabled={isExporting}
              className={`w-full p-3 rounded-[10px] border text-left transition-colors disabled:opacity-50 ${
                hasSEO
                  ? 'bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]'
                  : 'bg-[#0B0B0C] border-[#26262C] opacity-60'
              }`}
            >
              <span className="text-[13px] font-medium">📄 SEO — YouTube пакет</span>
              <p className="text-[11px] text-[#8A8A93] mt-1">
                Title, tags, thumbnail {hasSEO ? '' : '(нет SEO)'}
              </p>
            </button>

            {onGenerateSEO && (
              <button
                onClick={onGenerateSEO}
                disabled={isExporting || generatingSEO}
                className="w-full p-3 rounded-[10px] border border-dashed border-[#26262C] bg-[#0B0B0C] text-left transition-colors hover:border-[#E8B44C]/50 hover:bg-[#1E1E23] disabled:opacity-50"
              >
                <span className="text-[13px] font-medium">
                  ✨ {generatingSEO ? 'Генерирую SEO...' : hasSEO ? 'Перегенерировать SEO' : 'Сгенерировать SEO'}
                </span>
                <p className="text-[11px] text-[#8A8A93] mt-1">
                  Модель соберёт title/описание/теги/тайм-коды; без ключа — шаблон
                </p>
              </button>
            )}

            {onDownloadDiagnosticJson && (
              <button
                type="button"
                onClick={onDownloadDiagnosticJson}
                className="w-full p-2.5 rounded-[10px] border border-[#26262C] bg-[#0B0B0C] hover:bg-[#1E1E23] text-left transition-colors"
              >
                <span className="text-[12px] font-medium text-[#A1A1AA]">
                  🩺 Скачать диагностический JSON-отчёт проекта
                </span>
              </button>
            )}

            <button
              onClick={() => onExport('all')}
              disabled={isExporting}
              className="w-full p-3 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E] text-left transition-colors font-medium disabled:opacity-50"
            >
              <span className="text-[13px]">📦 Всё сразу (MP3+SRT+SEO)</span>
            </button>
          </div>

          {costEstimate && (
            <div className="pt-3 border-t border-[#26262C] text-[11px] text-[#8A8A93] space-y-1">
              <p>
                ⏱ Оценка: ~{Math.ceil(isFinite(exactDuration) ? exactDuration : 0)}с · {costEstimate.characters} симв. ·{' '}
                {costEstimate.cost}
              </p>
              <p className="text-[#4ADE80]">✅ OPFS кэш — повторная озвучка бесплатна</p>
            </div>
          )}
          {isExporting && (
            <div className="flex items-center gap-2 text-[12px] text-[#E8B44C]">
              <div className="w-4 h-4 border-2 border-[#26262C] border-t-[#E8B44C] rounded-full animate-spin" />
              Экспорт...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
