import { useRef } from 'react';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock,
  FileJson,
  Info,
  ShieldAlert,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type { ProjectEventEntry } from '@/lib/storage/db';
import type { ProjectHealthIssue, ProjectHealthReport } from '@/lib/pipeline/projectHealth';

interface ProjectHealthModalProps {
  healthReport: ProjectHealthReport;
  eventLog: ProjectEventEntry[];
  storageBackendLabel: string;
  onClose: () => void;
  onJumpToIssue: (issue: ProjectHealthIssue) => void;
  onDownloadDiagnosticJson: () => void;
  onExportProjectZip: () => void;
  onImportProjectZip?: (file: File) => void;
}

export function ProjectHealthModal({
  healthReport,
  eventLog,
  storageBackendLabel,
  onClose,
  onJumpToIssue,
  onDownloadDiagnosticJson,
  onExportProjectZip,
  onImportProjectZip,
}: ProjectHealthModalProps) {
  const zipInputRef = useRef<HTMLInputElement>(null);

  const errorCount = healthReport.issues.filter(i => i.severity === 'error').length;
  const warningCount = healthReport.issues.filter(i => i.severity === 'warning').length;

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Проверка проекта и диагностика"
    >
      <div className="bg-[#141418] border border-white/10 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2.5">
            {errorCount > 0 ? (
              <XCircle className="w-5 h-5 text-red-400" />
            ) : warningCount > 0 ? (
              <AlertTriangle className="w-5 h-5 text-amber-400" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            )}
            <div>
              <h3 className="text-sm font-semibold text-white">Проверка проекта и диагностика</h3>
              <p className="text-[11px] text-zinc-400">
                Статус: <span className="text-zinc-200 font-medium">{healthReport.badgeLabel}</span> · Точная длительность:{' '}
                <span className="font-mono text-zinc-200">{healthReport.exactDuration.toFixed(2)} с</span> · Хранилище:{' '}
                <span className="text-zinc-200">{storageBackendLabel}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors"
            aria-label="Закрыть окно проверки проекта"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {/* Сводка */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-black/40 border border-white/5 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Озвучено реплик</div>
              <div className="text-base font-semibold text-zinc-100 mt-0.5">
                {healthReport.voicedPanelsCount} / {healthReport.totalDialoguePanelsCount}
              </div>
            </div>
            <div className="bg-black/40 border border-white/5 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Ошибки / Предупреждения</div>
              <div className="text-base font-semibold text-zinc-100 mt-0.5">
                <span className={errorCount > 0 ? 'text-red-400' : 'text-emerald-400'}>{errorCount}</span>
                {' / '}
                <span className={warningCount > 0 ? 'text-amber-400' : 'text-zinc-300'}>{warningCount}</span>
              </div>
            </div>
            <div className="bg-black/40 border border-white/5 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-500">Готовность к экспорту</div>
              <div className="text-xs font-medium mt-1">
                {healthReport.readyForExport ? (
                  <span className="text-emerald-400">Экспорт разрешён</span>
                ) : (
                  <span className="text-red-400">Требуется исправление</span>
                )}
              </div>
            </div>
          </div>

          {/* Кликабельный список проблем (Этап 10 п. 92) */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2">
              Результаты проверки ({healthReport.issues.length})
            </h4>
            {healthReport.issues.length === 0 ? (
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 text-xs text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                Все проверки синхронизации, диапазонов [X..Y%], изображений и озвучки пройдены без замечаний.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {healthReport.issues.map(issue => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => onJumpToIssue(issue)}
                    className={`w-full text-left p-2.5 rounded-lg border transition-colors flex items-start gap-2.5 ${
                      issue.severity === 'error'
                        ? 'bg-red-500/10 border-red-500/25 hover:bg-red-500/15 text-red-200'
                        : issue.severity === 'warning'
                        ? 'bg-amber-500/10 border-amber-500/25 hover:bg-amber-500/15 text-amber-200'
                        : 'bg-zinc-800/60 border-white/10 hover:bg-zinc-800 text-zinc-200'
                    }`}
                  >
                    {issue.severity === 'error' ? (
                      <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                    ) : issue.severity === 'warning' ? (
                      <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    ) : (
                      <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs leading-snug">{issue.message}</div>
                      <div className="text-[10px] opacity-75 mt-1 flex items-center gap-2 font-mono">
                        <span>[{issue.code}]</span>
                        {issue.panelId !== undefined && <span>Панель #{issue.panelId}</span>}
                        {issue.imageIndex !== undefined && <span>Стр. {issue.imageIndex + 1}</span>}
                        {issue.seekTime !== undefined && <span>→ {issue.seekTime.toFixed(2)}s (нажмите для перехода)</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Журнал событий проекта (Этап 10 п. 99) */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Журнал событий проекта ({eventLog.length})
            </h4>
            {eventLog.length === 0 ? (
              <p className="text-xs text-zinc-500 bg-black/30 rounded-lg p-3 border border-white/5">
                События текущей сессии пока не зафиксированы.
              </p>
            ) : (
              <div className="bg-black/40 border border-white/5 rounded-lg max-h-40 overflow-y-auto divide-y divide-white/5">
                {[...eventLog].reverse().map(ev => (
                  <div key={ev.id} className="px-3 py-2 text-[11px] flex items-center justify-between gap-2">
                    <span className="text-zinc-300 truncate">{ev.summary}</span>
                    <span className="text-zinc-500 font-mono shrink-0 text-[10px]">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Архивация и диагностический отчёт (Этап 8 п. 76–77, Этап 9 п. 88) */}
        <div className="px-5 py-3.5 border-t border-white/10 bg-black/40 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onDownloadDiagnosticJson}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-zinc-200 flex items-center gap-1.5 transition-colors"
            >
              <FileJson className="w-3.5 h-3.5 text-indigo-400" />
              Диагностический JSON
            </button>
            <button
              type="button"
              onClick={onExportProjectZip}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-zinc-200 flex items-center gap-1.5 transition-colors"
            >
              <Archive className="w-3.5 h-3.5 text-emerald-400" />
              Экспорт архива (.zip)
            </button>
            {onImportProjectZip && (
              <>
                <input
                  ref={zipInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) onImportProjectZip(f);
                    e.currentTarget.value = '';
                  }}
                />
                <button
                  type="button"
                  onClick={() => zipInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-xs text-zinc-200 flex items-center gap-1.5 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5 text-amber-400" />
                  Восстановить из .zip
                </button>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition-colors"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
