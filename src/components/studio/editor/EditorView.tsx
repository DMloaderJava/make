"use client";

/**
 * Разметка редактора (P0-1): чистая презентация состояния контроллера.
 *
 * Здесь нет ни одного useEffect и ни одного обращения к хранилищу — только
 * отрисовка того, что вернул useEditorController.
 */

import Link from 'next/link';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { useEditorController } from './useEditorController';
import { EditorModals } from './EditorModals';
import { EditorWorkspace } from './EditorWorkspace';

export type EditorController = ReturnType<typeof useEditorController>;

export function EditorView({ c }: { c: EditorController }) {
  const {

    audioDone,

    audioError,

    audioTotal,
    audioWarnings,

    duration,
    editorImageInputRef,

    handleAddImages,

    healthReport,

    isGeneratingAudio,

    isProjectLoading,
    isUploadingImages,
    notice,

    project,
    projectLoadError,
    reloadProject,

    saveStatus,

    setAudioError,
    setAudioWarnings,

    setNotice,

    setShowAudioImport,
    setShowExport,
    setShowHealthModal,
    setShowIntroOutro,
    setShowScenario,
    setShowVoices,

    updateProject,

  } = c;

  if (isProjectLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 bg-[#0B0B0C] text-[#8A8A93]" role="status" aria-live="polite">
        <Loader2 className="w-6 h-6 animate-spin" />
        <span className="text-sm">Загрузка проекта...</span>
      </div>
    );
  }

  if (projectLoadError || !project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[#0B0B0C] px-4">
        <div className="w-full max-w-lg rounded-[16px] border border-[#26262C] bg-[#16161A] p-6 text-center" role="alert">
          <h1 className="text-lg font-medium">Не удалось открыть проект</h1>
          <p className="mt-2 text-sm text-[#A1A1AA]">{projectLoadError || 'Проект не найден в локальном хранилище.'}</p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={reloadProject}
              className="h-9 rounded-[6px] bg-[#E8B44C] px-4 text-sm font-medium text-[#0B0B0C] hover:bg-[#B88A2E] transition-colors"
            >
              Повторить
            </button>
            <Link href="/" className="h-9 rounded-[6px] border border-[#26262C] px-4 text-sm text-[#F5F5F7] hover:bg-[#1E1E23] transition-colors flex items-center">
              К проектам
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="editor-root"
      data-timeline-version={project.timelineVersion ?? 2}
      data-total-duration={duration.toFixed(3)}
      className="flex-1 bg-[#0B0B0C] flex flex-col h-[100dvh] max-h-[100dvh] overflow-hidden"
    >
      <div className="h-14 px-4 flex items-center justify-between border-b border-[#26262C] bg-[#0B0B0C]/80 backdrop-blur sticky top-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/" className="w-8 h-8 rounded-[6px] bg-[#16161A] border border-[#26262C] flex items-center justify-center hover:bg-[#1E1E23] transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <Input value={project.name} onChange={(e) => updateProject({ name: e.target.value })} className="h-8 bg-transparent border-transparent hover:border-[#26262C] focus:border-[#26262C] text-[14px] font-medium px-2 max-w-[240px]" />
          <span className={`text-[11px] font-mono ${saveStatus === 'saved' ? 'text-[#8A8A93]' : saveStatus === 'saving' ? 'text-[#E8B44C]' : 'text-[#F87171]'}`}>
            {saveStatus === 'saved' ? 'сохранено' : saveStatus === 'saving' ? 'сохранение...' : 'не сохранено'}
          </span>
          {/* Индикатор готовности проекта в шапке редактора (Этап 10 п. 91, 93) */}
          {healthReport && (
            <button
              type="button"
              onClick={() => setShowHealthModal(true)}
              className={`h-6 px-2 rounded-full border text-[10px] font-mono hidden sm:flex items-center gap-1.5 transition-colors ${
                healthReport.status === 'ready'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                  : healthReport.status === 'errors'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                  : 'border-[#594615] bg-[#2A2416] text-[#E8B44C] hover:bg-[#3A311D]'
              }`}
              title="Открыть «Проверку проекта», журнал событий и архивацию (.zip)"
            >
              <span>●</span>
              <span>{healthReport.badgeLabel}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="open-health-btn"
            onClick={() => setShowHealthModal(true)}
            className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap"
            title="Проверка проекта, диагностика синхронизации и экспорт/импорт .zip"
          >
            Проверка
          </button>
          <button data-testid="open-scenario-btn" onClick={() => setShowScenario(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap">
            Сценарий
          </button>
          <button
            onClick={() => editorImageInputRef.current?.click()}
            disabled={isUploadingImages || isGeneratingAudio}
            className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap disabled:opacity-40"
          >
            {isUploadingImages ? 'Загрузка...' : 'Добавить изображения'}
          </button>
          <input
            ref={editorImageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files?.length) void handleAddImages(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            data-testid="open-audio-import-btn"
            onClick={() => setShowAudioImport(true)}
            disabled={isGeneratingAudio || project.panels.length === 0}
            title={project.panels.length === 0 ? 'Сначала создайте панели (сценарий или анализ изображений)' : 'Свои аудиофайлы на панели — по манифесту, якорю в имени, номеру или порядку'}
            className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors whitespace-nowrap disabled:opacity-40 disabled:hover:bg-[#16161A]"
          >
            Импорт аудио
          </button>
          <button data-testid="open-intro-outro-btn" onClick={() => setShowIntroOutro(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Интро/Аутро
          </button>
          <button onClick={() => setShowVoices(true)} className="h-8 px-3 rounded-[6px] bg-[#16161A] border border-[#26262C] text-xs hover:bg-[#1E1E23] transition-colors">
            Голоса
          </button>
          <button data-testid="open-export-btn" onClick={() => setShowExport(true)} className="h-8 px-3 rounded-[6px] bg-[#E8B44C] text-[#0B0B0C] text-xs font-medium hover:bg-[#B88A2E] transition-colors">
            Экспорт
          </button>
        </div>
      </div>

      {isGeneratingAudio && (
        <div className="h-0.5 w-full bg-[#16161A]" role="progressbar" aria-label="Озвучка">
          {/* раньше считалось от audioBlobs.size (обновлялся один раз в конце) — полоса стояла на 0% */}
          <div className="h-full bg-[#E8B44C] transition-all duration-300" style={{ width: `${(audioDone / Math.max(1, audioTotal || project.panels.length)) * 100}%` }} />
        </div>
      )}

      {audioError && (
        <div data-testid="audio-error-alert" className="border-b border-[#3A1414] bg-[#1E1010] px-4 py-2" role="alert" aria-live="assertive">
          <div className="max-w-[960px] mx-auto flex items-start gap-3">
            <span className="text-[13px] leading-5 text-[#E86C4C]" aria-hidden="true">⚠</span>
            <div className="flex-1 space-y-0.5">
              <p className="text-[12px] font-medium text-[#E86C4C]">Озвучка не удалась</p>
              <p className="text-[11px] leading-4 text-[#C97A66] break-words whitespace-pre-wrap">{audioError}</p>
            </div>
            <button
              onClick={() => setAudioError(null)}
              className="h-6 px-2 rounded-[6px] border border-[#3A1414] text-[11px] text-[#C97A66] hover:bg-[#262010] transition-colors"
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      {audioWarnings.length > 0 && (
        <div className="border-b border-[#3A2E14] bg-[#1E1A10] px-4 py-2">
          <div className="max-w-[960px] mx-auto flex items-start gap-3">
            <span className="text-[13px] leading-5 text-[#E8B44C]">⚠</span>
            <div className="flex-1 space-y-0.5">
              <p className="text-[12px] font-medium text-[#E8B44C]">Аудио подогнано под таймлайн</p>
              {audioWarnings.map((line, i) => (
                <p key={i} className="text-[11px] leading-4 text-[#C9B27A]">{line}</p>
              ))}
              <p className="text-[11px] leading-4 text-[#8A8A93]">
                Проверьте длину реплик или сдвиньте паузы — иначе конец фразы может не прозвучать.
              </p>
            </div>
            <button
              onClick={() => setAudioWarnings([])}
              className="h-6 px-2 rounded-[6px] border border-[#3A2E14] text-[11px] text-[#C9B27A] hover:bg-[#262010] transition-colors"
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className="border-b border-[#3A2E14] bg-[#1E1A10] px-4 py-2" role="status" aria-live="polite">
          <div className="max-w-[960px] mx-auto flex items-start gap-3">
            <span className="text-[13px] leading-5 text-[#E8B44C]" aria-hidden="true">ℹ</span>
            <p className="flex-1 text-[11px] leading-4 text-[#C9B27A] break-words whitespace-pre-wrap">{notice}</p>
            <button
              onClick={() => setNotice(null)}
              className="h-6 px-2 rounded-[6px] border border-[#3A2E14] text-[11px] text-[#C9B27A] hover:bg-[#262010] transition-colors"
            >
              Понятно
            </button>
          </div>
        </div>
      )}

      <EditorWorkspace c={c} />
      <EditorModals c={c} />
    </div>
  );
}
