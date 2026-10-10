'use client';

import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PanelData } from '@/lib/pipeline/extractPanels';
import {
  AUDIO_IMPORT_EXTENSIONS,
  autoImportOptions,
  describeImportMode,
  importViaLabel,
  planAudioImport,
  type ApplyAudioImportReport,
  type AudioImportPlan,
} from '@/lib/pipeline/audioImport';
import { fileExtension, naturalCompare } from '@/lib/pipeline/importPlan';

/**
 * План из состояния модалки — те же аргументы, что в tests/audioImport.test.ts
 * (autoImportOptions). planAudioImport чистая, пересчёт на каждое изменение.
 */
export function useAudioImportPlan(params: {
  files: File[];
  panels: PanelData[];
  manifest: string;
  overwrite: boolean;
  existingAudio: number[];
}): AudioImportPlan {
  const { files, panels, manifest, overwrite, existingAudio } = params;
  return useMemo(
    () => planAudioImport(
      files.map(f => ({ name: f.name, size: f.size })),
      panels,
      autoImportOptions({ manifest, overwrite, existingAudio }),
    ),
    [files, panels, manifest, overwrite, existingAudio],
  );
}

export interface AudioImportApplyControls {
  signal: AbortSignal;
  onProgress: (done: number, total: number) => void;
}

interface AudioImportModalProps {
  open: boolean;
  onClose: () => void;
  panels: PanelData[];
  /** id панелей, у которых сейчас есть аудио (TTS или прошлый импорт). */
  existingAudio: number[];
  /** Применение — в редакторе (OPFS + состояние проекта). */
  onApply: (plan: AudioImportPlan, files: Map<string, File>, controls: AudioImportApplyControls) => Promise<ApplyAudioImportReport>;
}

type Phase = 'edit' | 'applying' | 'done';

const ACCEPT = AUDIO_IMPORT_EXTENSIONS.map(ext => `.${ext}`).join(',') + ',audio/*,.txt';
const MAX_LINES = 6;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

/**
 * «Импорт аудио»: файлы → план «файл → панель» → применение.
 * Сопоставление автоматическое (манифест → якорь в имени → номер/порядок),
 * ошибки плана блокируют «Применить» (как в ScenarioModal). Подтверждение
 * перезаписи — чекбокс, а не confirm(): во встроенном превью (iframe без
 * allow-modals) confirm молча возвращает false.
 *
 * Редактор монтирует модалку только на время показа — каждое открытие
 * начинается с чистого состояния без effect-сброса.
 */
export function AudioImportModal({ open, onClose, panels, existingAudio, onApply }: AudioImportModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [manifest, setManifest] = useState('');
  const [manifestOpen, setManifestOpen] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [phase, setPhase] = useState<Phase>('edit');
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [report, setReport] = useState<ApplyAudioImportReport | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const plan = useAudioImportPlan({ files, panels, manifest, overwrite, existingAudio });
  const mode = describeImportMode(plan);
  const canApply = phase === 'edit' && plan.errors.length === 0 && plan.matches.length > 0;

  if (!open) return null;

  /** Новые файлы: повторное имя заменяет прежний файл; .txt — это манифест. */
  const addFiles = async (list: FileList | File[]) => {
    const incoming = Array.from(list);
    const manifests = incoming.filter(f => fileExtension(f.name) === 'txt');
    const audio = incoming.filter(f => fileExtension(f.name) !== 'txt');
    if (manifests.length > 0) {
      const texts = await Promise.all(manifests.map(f => f.text()));
      setManifest(prev => [prev.trim(), ...texts.map(t => t.trim())].filter(Boolean).join('\n'));
      setManifestOpen(true);
    }
    if (audio.length > 0) {
      setFiles(prev => {
        const incomingNames = new Set(audio.map(f => f.name.normalize('NFC')));
        return [...prev.filter(f => !incomingNames.has(f.name.normalize('NFC'))), ...audio];
      });
    }
  };

  const removeFile = (name: string) => setFiles(prev => prev.filter(f => f.name !== name));

  const handleApply = async () => {
    if (!canApply) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('applying');
    setApplyError(null);
    setProgress({ done: 0, total: plan.matches.length });
    try {
      const byName = new Map(files.map(f => [f.name, f]));
      const result = await onApply(plan, byName, {
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setReport(result);
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      abortRef.current = null;
      setPhase('done');
    }
  };

  const close = () => {
    if (phase === 'applying') return; // сначала «Отменить»
    onClose();
  };

  const sortedFiles = [...files].sort((a, b) => naturalCompare(a.name.normalize('NFC'), b.name.normalize('NFC')));
  const matchByFile = new Map([...plan.matches, ...plan.skipped].map(m => [m.file, m]));
  const skippedFiles = new Set(plan.skipped.map(m => m.file));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0B0C]/80 backdrop-blur-sm" onClick={close} />
      <div className="relative w-full max-w-[640px] bg-[#16161A] border border-[#26262C] rounded-[16px] shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-[#26262C] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-medium">Импорт аудио</h2>
            <p className="text-[11px] text-[#8A8A93] mt-0.5">
              Свои записи на панели · по манифесту, якорю в имени («Изображение 1 [0..30%].mp3»), номеру или порядку
            </p>
          </div>
          <button onClick={close} disabled={phase === 'applying'} className="w-8 h-8 rounded-[6px] bg-[#1E1E23] hover:bg-[#26262C] flex items-center justify-center text-[#8A8A93] disabled:opacity-40">×</button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {phase === 'edit' && (
            <>
              <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
                className={`rounded-[10px] border border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${dragOver ? 'border-[#E8B44C] bg-[#1E1A10]' : 'border-[#26262C] bg-[#0B0B0C] hover:bg-[#121214]'}`}
              >
                <p className="text-[12px] text-[#F5F5F7]">Перетащите аудиофайлы или <span className="text-[#E8B44C]">выберите</span></p>
                <p className="text-[11px] text-[#8A8A93] mt-1">mp3, wav, ogg/opus, m4a/aac, flac, webm · .txt — манифест</p>
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="hidden"
                  onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }}
                />
              </div>

              <details open={manifestOpen} onToggle={(e) => setManifestOpen((e.target as HTMLDetailsElement).open)} className="rounded-[10px] bg-[#0B0B0C] border border-[#26262C] px-4 py-3">
                <summary className="cursor-pointer text-[12px] text-[#A1A1AA] select-none">
                  Манифест{manifest.trim() ? ' · используется' : ' (необязательно)'}
                </summary>
                <textarea
                  value={manifest}
                  onChange={(e) => setManifest(e.target.value)}
                  spellCheck={false}
                  placeholder={'# якорь = файл, как заголовки в «Сценарии»\nИзображение 1 [0..30%] = voice1.mp3\nИзображение 2 = voice2.wav'}
                  className="mt-3 w-full min-h-[90px] max-h-[200px] rounded-[8px] bg-[#16161A] border border-[#26262C] px-3 py-2 font-mono text-[12px] leading-5 text-[#F5F5F7] placeholder:text-[#8A8A93]/50 resize-y"
                />
              </details>

              <label className="flex items-start gap-2 cursor-pointer">
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} className="mt-0.5 accent-[#E8B44C]" />
                <span className="text-[11px] leading-4 text-[#A1A1AA]">
                  Перезаписать существующее аудио панелей (TTS и прошлый импорт)
                  {existingAudio.length > 0 && <span className="text-[#8A8A93]"> · сейчас с аудио: {existingAudio.length}</span>}
                </span>
              </label>

              {files.length > 0 && (
                <div className="rounded-[10px] bg-[#0B0B0C] border border-[#26262C] px-4 py-3 space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-[#8A8A93]">
                    <span>
                      Файлов: <span className="text-[#F5F5F7]">{files.length}</span> · к применению: <span className="text-[#F5F5F7]">{plan.matches.length}</span>
                      {plan.skipped.length > 0 && <> · пропущено: <span className="text-[#F5F5F7]">{plan.skipped.length}</span></>}
                      {' '}· сопоставление: <span className="text-[#F5F5F7]">{mode}</span>
                    </span>
                    <button onClick={() => setFiles([])} className="text-[#8A8A93] hover:text-[#F5F5F7]">Очистить</button>
                  </div>
                  <div className="max-h-[220px] overflow-y-auto space-y-1 pr-1">
                    {sortedFiles.map((file, i) => {
                      const match = matchByFile.get(file.name);
                      const skipped = skippedFiles.has(file.name);
                      return (
                        <div key={file.name + i} className="flex items-baseline gap-2 text-[11px] leading-5">
                          <span className="font-mono text-[#8A8A93] shrink-0">{String(i + 1).padStart(2, '0')}</span>
                          <span className="truncate max-w-[40%] text-[#F5F5F7]" title={`${file.name} · ${formatSize(file.size)}`}>{file.name}</span>
                          <span className="text-[#8A8A93] shrink-0">→</span>
                          {match ? (
                            <span className={`truncate font-mono ${skipped ? 'text-[#8A8A93] line-through' : 'text-[#E8B44C]'}`} title={importViaLabel(match.via)}>
                              {match.label}
                            </span>
                          ) : (
                            <span className="text-[#C97A66]">не сопоставлен</span>
                          )}
                          <span className="ml-auto shrink-0 text-[#8A8A93]">
                            {match ? (skipped ? 'аудио есть' : importViaLabel(match.via)) : ''}
                          </span>
                          <button onClick={() => removeFile(file.name)} title="Убрать файл" className="shrink-0 text-[#8A8A93] hover:text-[#F5F5F7]">×</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {plan.errors.length > 0 && (
                <div className="space-y-1" role="alert">
                  {plan.errors.slice(0, MAX_LINES).map((err, i) => (
                    <p key={i} className="text-[11px] leading-4 text-[#E86C4C]">• {err}</p>
                  ))}
                  {plan.errors.length > MAX_LINES && <p className="text-[11px] text-[#C97A66]">…ещё ошибок: {plan.errors.length - MAX_LINES}</p>}
                </div>
              )}
              {plan.warnings.length > 0 && (
                <div className="space-y-1">
                  {plan.warnings.slice(0, MAX_LINES).map((w, i) => (
                    <p key={i} className="text-[11px] leading-4 text-[#C9B27A]">⚠ {w}</p>
                  ))}
                  {plan.warnings.length > MAX_LINES && <p className="text-[11px] text-[#8A8A93]">…ещё предупреждений: {plan.warnings.length - MAX_LINES}</p>}
                </div>
              )}
            </>
          )}

          {phase === 'applying' && (
            <div className="space-y-2" aria-live="polite">
              <p className="text-[12px] text-[#F5F5F7]">Импорт: {progress.done} из {progress.total}…</p>
              <div className="h-1 w-full rounded bg-[#0B0B0C]" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                <div className="h-full rounded bg-[#E8B44C] transition-all duration-200" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
              <p className="text-[11px] text-[#8A8A93]">Файлы декодируются для проверки и пишутся в хранилище проекта по одному — отмена сохранит уже записанные.</p>
            </div>
          )}

          {phase === 'done' && (
            <div className="space-y-2" aria-live="polite">
              {applyError ? (
                <p className="text-[12px] text-[#E86C4C]">Импорт не удался: {applyError}</p>
              ) : report?.blocked ? (
                <p className="text-[12px] text-[#E86C4C]">Импорт не начат: {report.blocked}</p>
              ) : report && (
                <>
                  <p className="text-[12px] text-[#F5F5F7]">
                    {report.aborted ? 'Импорт отменён. ' : 'Готово. '}
                    Применено: <span className="text-[#E8B44C]">{report.applied.length}</span>
                    {report.failed.length > 0 && <> · с ошибкой: <span className="text-[#E86C4C]">{report.failed.length}</span></>}
                    {report.notStarted.length > 0 && <> · не начато: {report.notStarted.length}</>}
                  </p>
                  {report.failed.slice(0, MAX_LINES).map((f, i) => (
                    <p key={i} className="text-[11px] leading-4 text-[#E86C4C]">• {f.file}: {f.reason}</p>
                  ))}
                  {report.failed.length > MAX_LINES && <p className="text-[11px] text-[#C97A66]">…ещё {report.failed.length - MAX_LINES}</p>}
                  {report.applied.length > 0 && (
                    <p className="text-[11px] text-[#8A8A93]">«Озвучить всё» эти панели не тронет; переозвучить одну — «↻» в карточке панели.</p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            {phase === 'applying' ? (
              <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()} className="ml-auto h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
                Отменить
              </Button>
            ) : phase === 'done' ? (
              <Button size="sm" onClick={onClose} className="ml-auto h-8 text-xs bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E]">
                Закрыть
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
                  Отмена
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleApply()}
                  disabled={!canApply}
                  className="ml-auto h-8 text-xs bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E] disabled:opacity-50"
                >
                  {`Применить${plan.matches.length ? ` · ${plan.matches.length}` : ''}`}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
