"use client";

import { Preview } from '@/components/studio/Preview';
import { Timeline } from '@/components/studio/Timeline';
import { ContextPanel } from '@/components/studio/ContextPanel';
import { RenderModePanel } from '@/components/studio/RenderModePanel';
import { formatTime } from '@/lib/utils';
import { rebuildSrt } from '@/lib/pipeline/buildTimeline';
import { Loader2 } from 'lucide-react';
import type { EditorController } from './EditorView';

/**
 * Рабочая область редактора (P0-1): превью, режим рендера, таймлайн и
 * инспектор панели. Вынесена из `EditorView`, чтобы верхний файл занимался
 * только шапкой, баннерами и модалками.
 */
export function EditorWorkspace({ c }: { c: EditorController }) {
  const {
    applyIntroOutroChange,
    audioDurations,
    audioProgress,
    buildCurrentHistorySnapshot,
    clockInstance,
    clockRef,
    contextValue,
    costEstimate,
    currentPanelIdx,
    currentTime,
    existingAudioIds,
    handleDeleteActiveClip,
    handleDuplicateActiveClip,
    handleGapChange,
    handleGenerateAudio,
    handleGenerateIntro,
    handleGenerateOutro,
    handleMoveActiveClip,
    handleRedo,
    handleRegeneratePanel,
    handleReorderClip,
    handleSeek,
    handleSetPanelAudioGainAndFades,
    handleSetPanelAudioTrim,
    handleSetPanelDurationOverride,
    handleSplitActiveClip,
    handleTogglePanelMute,
    handleTogglePanelSolo,
    handleToggleTrackLock,
    handleUndo,
    historyAvail,
    historyRef,
    images,
    introAudioDuration,
    isGeneratingAudio,
    isGeneratingIntro,
    isPlaying,
    opfsActive,
    outroAudioDuration,
    panelGap,
    project,
    renderSettings,
    tl,
    duration,
    selectedId,
    setCurrentPanelIdx,
    setSelectedId,
    syncHistoryAvail,
    updateProject,
    voiceButton,
  } = c;

  // Рабочая область имеет смысл только при загруженном проекте.
  if (!project) return null;

  return (
    <div className="flex-1 overflow-y-auto min-h-0" data-scroll-area>
      <div className="max-w-[1180px] mx-auto p-3 sm:p-4 md:p-6">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px] items-start">
          <div className="min-w-0 space-y-5">
            <Preview
              images={images}
              panels={project.panels}
              currentPanelIndex={currentPanelIdx}
              timeline={tl}
              currentTime={currentTime}
              duration={duration}
              isPlaying={isPlaying}
              onPlayPause={() => clockRef.current.togglePlayPause()}
              clock={clockInstance}
              renderMode={renderSettings.renderMode}
              stripViewport={renderSettings.stripViewport}
              stripGap={renderSettings.stripGap}
              onSeek={handleSeek}
              onSelectPanel={(panelId) => {
                setSelectedId(panelId);
                const idx = project.panels.findIndex(p => p.id === panelId);
                if (idx !== -1) setCurrentPanelIdx(idx);
              }}
              selectedPanelId={typeof selectedId === 'number' ? selectedId : null}
              audioPanelIds={existingAudioIds}
              introText={project.intro}
              outroText={project.outro}
              introDuration={project.introDuration}
              outroDuration={project.outroDuration}
              introAudioDuration={introAudioDuration}
              outroAudioDuration={outroAudioDuration}
              debugOverlay={project.settings.debugOverlay}
              onToggleDebugOverlay={(next) =>
                updateProject({ settings: { ...project.settings, debugOverlay: next } })
              }
            />

            <RenderModePanel
              {...renderSettings}
              onChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
            />

            <Timeline
              images={images}
              timeline={tl}
              panels={project.panels}
              currentTime={currentTime}
              duration={duration}
              onSeek={handleSeek}
              onSelectPanel={(id) => {
                setSelectedId(id);
                const idx = project.panels.findIndex(p => p.id === id);
                if (idx !== -1) setCurrentPanelIdx(idx);
              }}
              onSelectIntro={() => setSelectedId('intro')}
              onSelectOutro={() => setSelectedId('outro')}
              selectedId={selectedId}
              introDuration={project.introDuration}
              outroDuration={project.outroDuration}
              panelGap={panelGap}
              onGapChange={handleGapChange}
              audioPanelIds={existingAudioIds}
              isPlaying={isPlaying}
              onSplitActiveClip={handleSplitActiveClip}
              onDeleteActiveClip={handleDeleteActiveClip}
              onDuplicateActiveClip={handleDuplicateActiveClip}
              onMoveActiveClipLeft={() => handleMoveActiveClip(-1)}
              onMoveActiveClipRight={() => handleMoveActiveClip(1)}
              onReorderPanel={handleReorderClip}
              onReorderClip={(fromIdx, toIdx) => {
                const sorted = [...project.panels].sort((a, b) => a.order - b.order || a.id - b.id);
                const moved = sorted[fromIdx];
                if (moved) handleReorderClip(moved.id, toIdx);
              }}
              onTrimPanel={handleSetPanelAudioTrim}
              onSetPanelTrim={handleSetPanelAudioTrim}
              onTogglePanelMute={handleTogglePanelMute}
              onTogglePanelSolo={handleTogglePanelSolo}
              videoTrackLocked={project.locks?.videoTrackLocked ?? false}
              audioTrackLocked={project.locks?.audioTrackLocked ?? false}
              onToggleTrackLock={handleToggleTrackLock}
              canUndo={historyAvail.canUndo}
              canRedo={historyAvail.canRedo}
              onUndo={handleUndo}
              onRedo={handleRedo}
            />

            <div className="pt-2">
              {/* needsAttention: панели появились или аудио удалено/устарело —
                  подсвечиваем кнопку, пока всё не озвучено (связка с остальным UI) */}
              <button
                onClick={handleGenerateAudio}
                disabled={isGeneratingAudio}
                className={`w-full h-11 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[14px] hover:bg-[#B88A2E] transition-colors duration-[150ms] disabled:opacity-50 flex items-center justify-center gap-2 ${voiceButton.needsAttention && !isGeneratingAudio ? 'shadow-[0_0_18px_rgba(232,180,76,0.35)]' : ''}`}
              >
                {isGeneratingAudio ? <><Loader2 className="w-4 h-4 animate-spin" /> {audioProgress}</> : voiceButton.label}
              </button>
              {costEstimate && !isGeneratingAudio && (
                <p className="text-center font-mono text-[11px] text-[#8A8A93] mt-2">{costEstimate.characters} симв. · {costEstimate.cost} · OPFS кэш — повтор бесплатно</p>
              )}
              {voiceButton.hint && !isGeneratingAudio && (
                <p className="text-center text-[11px] text-[#E8B44C] mt-1">{voiceButton.hint}</p>
              )}
              {project.panels.length === 0 && (
                <div className="mt-6 p-8 rounded-[16px] border border-dashed border-[#26262C] bg-[#16161A]/50 text-center">
                  <p className="text-[14px] font-medium">Проект пустой</p>
                  <p className="text-xs text-[#8A8A93] mt-1">Добавь изображения на главной или нажми «Озвучить» чтобы услышать интро/аутро</p>
                </div>
              )}
            </div>
          </div>

          <aside className="min-w-0 lg:sticky lg:top-20">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[12px] uppercase tracking-[0.14em] text-[#8A8A93]">Инспектор панели</h2>
              <span className="text-[10px] text-[#8A8A93]">выберите сегмент</span>
            </div>
            <ContextPanel
              selected={contextValue as any}
              onUpdatePanel={(id, updates) => {
                if (
                  updates.trimIn !== undefined ||
                  updates.trimOut !== undefined
                ) {
                  const p = project.panels.find(item => item.id === id);
                  handleSetPanelAudioTrim(
                    id,
                    updates.trimIn ?? p?.trimIn ?? 0,
                    updates.trimOut ?? p?.trimOut ?? 0
                  );
                  if (Object.keys(updates).every(k => k === 'trimIn' || k === 'trimOut')) return;
                }
                if ('durationOverride' in updates) {
                  handleSetPanelDurationOverride(id, updates.durationOverride);
                  if (Object.keys(updates).every(k => k === 'durationOverride')) return;
                }
                if (
                  updates.gain !== undefined ||
                  updates.fadeIn !== undefined ||
                  updates.fadeOut !== undefined
                ) {
                  handleSetPanelAudioGainAndFades(id, {
                    gain: updates.gain,
                    fadeIn: updates.fadeIn,
                    fadeOut: updates.fadeOut,
                  });
                  if (Object.keys(updates).every(k => k === 'gain' || k === 'fadeIn' || k === 'fadeOut')) return;
                }
                const snap = buildCurrentHistorySnapshot(`Правка панели #${id}`);
                if (snap) historyRef.current.record(snap);
                const newPanels = project.panels.map(p => p.id === id ? { ...p, ...updates } : p);
                // Любое изменение панели немедленно инвалидирует и пересобирает устаревший таймлайн + SRT (Этап 1 п. 9)
                const rebuilt = rebuildSrt({
                  panels: newPanels,
                  audioDurations,
                  voiceAssignments: project.voiceAssignments,
                  intro: project.intro,
                  outro: project.outro,
                  introDuration: project.introDuration,
                  outroDuration: project.outroDuration,
                  panelGap,
                  realDurations: project.audioDurations,
                });
                updateProject({
                  panels: newPanels,
                  timeline: rebuilt.timeline,
                  srt: rebuilt.srt,
                  timelineVersion: (project.timelineVersion ?? 2) + 1,
                });
                syncHistoryAvail();
              }}
              onUpdateIntro={(text, dur) => applyIntroOutroChange({ intro: text, introDuration: dur })}
              onUpdateOutro={(text, dur) => applyIntroOutroChange({ outro: text, outroDuration: dur })}
              voiceAssignments={project.voiceAssignments}
              onVoiceChange={(char, voiceId) => updateProject({ voiceAssignments: { ...project.voiceAssignments, [char]: voiceId } })}
              onGenerateIntro={handleGenerateIntro}
              onGenerateOutro={handleGenerateOutro}
              generating={isGeneratingIntro}
              onRegeneratePanel={handleRegeneratePanel}
              regenerating={isGeneratingAudio}
            />
          </aside>
        </div>

        <div className="pt-8 pb-4 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-[#8A8A93]/60">
          <span>
            {project.useOPFS && opfsActive ? 'OPFS + IDB' : 'IDB fallback'} · {images.length} изобр. · {formatTime(duration)}
          </span>
          <span className="flex flex-wrap gap-3">
            <span>Space / K play</span>
            <span>J / L / ←→ ±5s</span>
            <span>S split</span>
            <span>⌘Z / ⇧⌘Z undo/redo</span>
            <span>⌘S save</span>
            <span>⌘E export</span>
          </span>
        </div>
      </div>
    </div>
  );
}
