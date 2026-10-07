"use client";

import { SyncTimeline } from '@/lib/storage/db';

interface TimelineProps {
  timeline: SyncTimeline[];
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  onSelectPanel: (panelId: number) => void;
  onSelectIntro: () => void;
  onSelectOutro: () => void;
  selectedId: number | 'intro' | 'outro' | null;
  introDuration?: number;
  outroDuration?: number;
  /** Пауза между репликами (сек): сценарий ставит 0,6, дефолт 0,3 — и её можно менять. */
  panelGap?: number;
  onGapChange?: (gap: number) => void;
}

export function Timeline({ timeline, currentTime, duration, onSeek, onSelectPanel, onSelectIntro, onSelectOutro, selectedId, introDuration = 8, outroDuration = 5, panelGap = 0.3, onGapChange }: TimelineProps) {
  const formatTime = (s: number) => {
    if (!isFinite(s) || s <= 0) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || duration <= 0 || !isFinite(duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.min(1, Math.max(0, x / rect.width));
    onSeek(pct * duration);
  };

  const safeDuration = isFinite(duration) && duration > 0 ? duration : 1;
  const rulerCount = Math.max(1, Math.min(60, Math.ceil(safeDuration)));

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-[#F5F5F7]">Таймлайн</h3>
        <div className="flex items-center gap-3">
          {onGapChange && (
            <label className="flex items-center gap-2" title="Пауза после реплики до перехода к следующему изображению">
              <span className="font-mono text-[10px] text-[#8A8A93] whitespace-nowrap">
                пауза {panelGap.toFixed(2).replace(/\.?0+$/, '').replace('.', ',')} с
              </span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={panelGap}
                onChange={(e) => onGapChange(Number(e.target.value))}
                className="w-24 accent-[#E8B44C]"
              />
            </label>
          )}
          <span className="font-mono text-[11px] text-[#8A8A93]">{formatTime(currentTime)} / {formatTime(duration)}</span>
        </div>
      </div>

      <div className="relative h-[64px] bg-[#16161A] rounded-[10px] border border-[#26262C] overflow-hidden cursor-pointer" onClick={handleClick}>
        <div className="absolute top-0 left-0 right-0 h-5 flex border-b border-[#26262C]/50">
          {Array.from({ length: rulerCount }).map((_, i) => (
            <div key={i} className="flex-1 relative">
              {i % 5 === 0 && (
                <span className="absolute left-1 top-0.5 font-mono text-[9px] text-[#8A8A93]">{formatTime(i)}</span>
              )}
            </div>
          ))}
        </div>

        <div className="absolute top-6 bottom-2 left-1 right-1 flex gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onSelectIntro(); onSeek(0); }}
            className={`relative h-full rounded-[6px] flex items-center justify-center px-2 text-[11px] font-medium transition-colors duration-[150ms] ${
              selectedId === 'intro' ? 'bg-[#E8B44C] text-[#0B0B0C]' : 'bg-[#1E1E23] text-[#8A8A93] hover:bg-[#26262C] hover:text-[#F5F5F7]'
            }`}
            style={{ width: `${Math.max(6, (introDuration / safeDuration) * 100)}%` }}
          >
            Интро
          </button>

          {timeline.map((seg) => {
            const widthPct = ((seg.audioEnd - seg.audioStart) / safeDuration) * 100;
            const isSelected = selectedId === seg.panelId;
            const isActive = currentTime >= seg.audioStart && currentTime < seg.audioEnd;
            
            return (
              <button
                key={seg.panelId}
                onClick={(e) => { e.stopPropagation(); onSelectPanel(seg.panelId); onSeek(seg.audioStart); }}
                className={`relative h-full rounded-[6px] px-2 text-left overflow-hidden transition-colors duration-[150ms] flex flex-col justify-center ${
                  isSelected ? 'bg-[#E8B44C] text-[#0B0B0C]' : isActive ? 'bg-[#1E1E23] text-[#F5F5F7] ring-1 ring-[#E8B44C]/50' : 'bg-[#1E1E23] text-[#8A8A93] hover:bg-[#26262C]'
                }`}
                style={{ width: `${Math.max(widthPct, 3)}%` }}
                title={`${seg.character}: ${seg.text.slice(0,80)}`}
              >
                <span className="text-[11px] font-medium truncate">{seg.character}</span>
                <span className="text-[10px] opacity-70 truncate hidden md:block">{seg.text.slice(0,20)}</span>
              </button>
            );
          })}

          <button
            onClick={(e) => { e.stopPropagation(); onSelectOutro(); onSeek(Math.max(0, safeDuration - 2)); }}
            className={`relative h-full rounded-[6px] flex items-center justify-center px-2 text-[11px] font-medium transition-colors duration-[150ms] ${
              selectedId === 'outro' ? 'bg-[#E8B44C] text-[#0B0B0C]' : 'bg-[#1E1E23] text-[#8A8A93] hover:bg-[#26262C] hover:text-[#F5F5F7]'
            }`}
            style={{ width: `${Math.max(6, (outroDuration / safeDuration) * 100)}%` }}
          >
            Аутро
          </button>
        </div>

        <div className="absolute top-0 bottom-0 w-px bg-[#E8B44C] pointer-events-none" style={{ left: `${safeDuration > 0 ? (currentTime / safeDuration) * 100 : 0}%` }}>
          <div className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-[#E8B44C]" />
        </div>
      </div>
    </div>
  );
}
