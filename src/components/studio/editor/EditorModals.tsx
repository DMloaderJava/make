"use client";

import { ScenarioModal } from '@/components/studio/modals/ScenarioModal';
import { AudioImportModal } from '@/components/studio/modals/AudioImportModal';
import { IntroOutroModal } from '@/components/studio/modals/IntroOutroModal';
import { VoicesModal } from '@/components/studio/modals/VoicesModal';
import { ExportModal } from '@/components/studio/modals/ExportModal';
import { ProjectHealthModal } from '@/components/studio/modals/ProjectHealthModal';
import { getSettings } from '@/lib/storage/local';
import type { EditorController } from './EditorView';

/**
 * Все модальные окна редактора в одном месте.
 *
 * Раньше они были дописаны в конец `EditorView`, из-за чего основной экран не
 * помещался в один экран правки. Пропсы берутся из общего контроллера `c`.
 */
export function EditorModals({ c }: { c: EditorController }) {
  const {
    applyIntroOutroChange,
    audioBlobs,
    backendCaps,
    costEstimate,
    currentScenarioText,
    duration,
    existingAudioIds,
    exportAbortController,
    exportEta,
    exportProgress,
    exportStage,
    exportedFile,
    generatingSEO,
    handleApplyScenario,
    handleClearIntroAudio,
    handleClearIntroOutro,
    handleClearOutroAudio,
    handleDownloadDiagnosticJson,
    handleExport,
    handleExportProjectZip,
    handleGenerateSEO,
    handleImportAudio,
    handleImportIntroAudio,
    handleImportOutroAudio,
    handleImportProjectZip,
    handleIntroOutroAI,
    handleJumpToHealthIssue,
    handlePreviewAudioMix,
    handleTranslateScenario,
    handleUndoLastAudioImport,
    handleVoiceIntroOutro,
    healthReport,
    images,
    introAudio,
    isExporting,
    isGeneratingIntro,
    lastImportUndo,
    opfsActive,
    outroAudio,
    preferredBackend,
    project,
    setExportedFile,
    setPreferredBackend,
    setShowAudioImport,
    setShowExport,
    setShowHealthModal,
    setShowIntroOutro,
    setShowScenario,
    setShowVoices,
    showAudioImport,
    showExport,
    showHealthModal,
    showIntroOutro,
    showScenario,
    showVoices,
    srtDraft,
    updateProject,
    voicingIntroOutro,
  } = c;

  // Модалки открываются только при загруженном проекте.
  if (!project) return null;


  return (
    <>
  <ScenarioModal
    open={showScenario}
    onClose={() => setShowScenario(false)}
    imagesCount={images.length}
    existingPanels={project.panels.length}
    ttsLanguage={project.settings.ttsLanguage || 'ru'}
    currentScenario={currentScenarioText}
    llmProviderId={project.settings.llmProvider || getSettings().defaultLLMProvider || 'openrouter'}
    chatModel={project.settings.chatModel}
    onSettingsChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
    onApply={handleApplyScenario}
    onTranslate={handleTranslateScenario}
  />

  {showAudioImport && <AudioImportModal
    open
    onClose={() => setShowAudioImport(false)}
    panels={project.panels}
    existingAudio={existingAudioIds}
    onApply={handleImportAudio}
    canUndoLastImport={Boolean(lastImportUndo)}
    onUndoLastImport={() => void handleUndoLastAudioImport()}
  />}

  <IntroOutroModal
    open={showIntroOutro}
    onClose={() => setShowIntroOutro(false)}
    intro={project.intro}
    outro={project.outro}
    introDuration={project.introDuration}
    outroDuration={project.outroDuration}
    introAudio={introAudio}
    outroAudio={outroAudio}
    onIntroAudioUpload={handleImportIntroAudio}
    onOutroAudioUpload={handleImportOutroAudio}
    onClearIntroAudio={handleClearIntroAudio}
    onClearOutroAudio={handleClearOutroAudio}
    onApply={(patch) => { applyIntroOutroChange(patch); setShowIntroOutro(false); }}
    onGenerateAI={() => void handleIntroOutroAI()}
    onVoice={() => void handleVoiceIntroOutro()}
    onClear={handleClearIntroOutro}
    generating={isGeneratingIntro}
    voicing={voicingIntroOutro}
  />

  <VoicesModal
    open={showVoices}
    onClose={() => setShowVoices(false)}
    characters={project.characters}
    assignments={project.voiceAssignments}
    onChange={(a) => updateProject({ voiceAssignments: a })}
    onCharactersChange={(chars) => updateProject({ characters: chars as any })}
    settings={project.settings}
    onSettingsChange={(patch) => updateProject({ settings: { ...project.settings, ...patch } })}
    onPanelsRename={(renameMap) => {
      if (!project) return;
      const newPanels = project.panels.map(p => renameMap[p.character] ? { ...p, character: renameMap[p.character] } : p);
      const newAssignments: Record<string, string> = {};
      for (const [oldName, newName] of Object.entries(renameMap)) {
        if (project.voiceAssignments[oldName] && !newAssignments[newName]) newAssignments[newName] = project.voiceAssignments[oldName];
      }
      const mergedAssignments = { ...project.voiceAssignments, ...newAssignments };
      // Clean old keys that were merged away
      for (const oldName of Object.keys(renameMap)) {
        if (renameMap[oldName] !== oldName) delete (mergedAssignments as any)[oldName];
      }
      updateProject({ panels: newPanels, voiceAssignments: mergedAssignments });
    }}
  />

  <ExportModal
    open={showExport}
    onClose={() => {
      if (!isExporting) {
        if (exportedFile) {
          try { URL.revokeObjectURL(exportedFile.url); } catch {}
        }
        setShowExport(false);
        setExportedFile(null);
      }
    }}
    onExport={handleExport}
    hasAudio={audioBlobs.size > 0 || !!introAudio}
    hasSRT={!!project.srt}
    srtDraft={srtDraft}
    hasSEO={!!project.seoPackage}
    duration={duration}
    backendCaps={backendCaps}
    preferredBackend={preferredBackend}
    onBackendChange={setPreferredBackend}
    isExporting={isExporting}
    exportProgress={exportProgress}
    exportStage={exportStage}
    exportEta={exportEta}
    onCancelExport={() => exportAbortController?.abort()}
    exportedFile={exportedFile}
    costEstimate={costEstimate}
    onGenerateSEO={handleGenerateSEO}
    generatingSEO={generatingSEO}
    healthReport={healthReport ?? undefined}
    onPreviewAudioMix={handlePreviewAudioMix}
    onDownloadDiagnosticJson={handleDownloadDiagnosticJson}
  />

  {showHealthModal && healthReport && (
    <ProjectHealthModal
      healthReport={healthReport}
      eventLog={project.eventLog ?? []}
      storageBackendLabel={project.useOPFS && opfsActive ? 'OPFS + IDB' : 'IDB fallback'}
      onClose={() => setShowHealthModal(false)}
      onJumpToIssue={handleJumpToHealthIssue}
      onDownloadDiagnosticJson={handleDownloadDiagnosticJson}
      onExportProjectZip={() => void handleExportProjectZip()}
      onImportProjectZip={(file) => void handleImportProjectZip(file)}
    />
      )}
    </>
  );
}
