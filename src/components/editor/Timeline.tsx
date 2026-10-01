"use client";

import { PanelData } from '@/lib/pipeline/extractPanels';
import { SyncTimeline } from '@/lib/storage/db';
import { formatTime } from '@/lib/utils';

interface TimelineProps {
  panels: PanelData[];
  timeline: SyncTimeline[];
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  onPanelClick?: (panelId: number) => void;
}

export function Timeline({ panels, timeline, currentTime, duration, onSeek, onPanelClick }: TimelineProps) {
  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = x / rect.width;
    const time = pct * duration;
    onSeek(time);
  };

  return (
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">Таймлайн</h3>
        <span className="text-xs text-zinc-500 font-mono">{formatTime(currentTime)} / {formatTime(duration)}</span>
      </div>

      {/* Time ruler */}
      <div className="relative h-12 bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden cursor-pointer" onClick={handleTimelineClick}>
        {/* Background grid */}
        <div className="absolute inset-0 flex">
          {Array.from({ length: Math.ceil(duration) }).map((_, i) => (
            <div key={i} className="flex-1 border-r border-zinc-800/50 relative">
              {i % 5 === 0 && (
                <span className="absolute -top-0 left-1 text-[9px] text-zinc-600">{formatTime(i)}</span>
              )}
            </div>
          ))}
        </div>

        {/* Timeline segments */}
        <div className="absolute inset-0 top-4 bottom-1 flex gap-0.5 px-0.5">
          {timeline.map((seg, idx) => {
            const left = (seg.audioStart / duration) * 100;
            const width = ((seg.audioEnd - seg.audioStart) / duration) * 100;
            const isActive = currentTime >= seg.audioStart && currentTime < seg.audioEnd;
            
            return (
              <div
                key={seg.panelId}
                className={`absolute h-full rounded flex items-center justify-center text-[10px] font-medium truncate px-1 transition-all cursor-pointer
                  ${isActive ? 'bg-indigo-600 text-white ring-1 ring-indigo-400 z-10' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}
                `}
                style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(seg.audioStart);
                  onPanelClick?.(seg.panelId);
                }}
                title={`${seg.character}: ${seg.text.slice(0, 100)}`}
              >
                {width > 3 ? `${seg.character}` : ''}
              </div>
            );
          })}
        </div>

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
          style={{ left: `${(currentTime / duration) * 100}%` }}
        >
          <div className="absolute -top-1 -left-1.5 w-3 h-3 bg-red-500 rounded-full" />
        </div>
      </div>

      {/* Panels list */}
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {timeline.map((seg, idx) => {
          const isActive = currentTime >= seg.audioStart && currentTime < seg.audioEnd;
          const panel = panels.find(p => p.id === seg.panelId);
          return (
            <div
              key={seg.panelId}
              className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors ${
                isActive ? 'bg-indigo-600/20 border border-indigo-500/30' : 'bg-zinc-800/50 hover:bg-zinc-800 border border-transparent'
              }`}
              onClick={() => {
                onSeek(seg.audioStart);
                onPanelClick?.(seg.panelId);
              }}
            >
              <div className="text-[10px] font-mono text-zinc-500 w-8">{formatTime(seg.audioStart)}</div>
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isActive ? 'bg-indigo-400 animate-pulse' : 'bg-zinc-600'}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-white truncate">{seg.character}</span>
                  <span className="text-[10px] text-zinc-500">{panel?.emotion}</span>
                  <span className="text-[10px] bg-zinc-700 text-zinc-300 px-1 rounded">{panel?.type}</span>
                </div>
                <p className="text-xs text-zinc-400 truncate">{seg.text}</p>
              </div>
              <div className="text-[10px] text-zinc-500 font-mono">{(seg.audioEnd - seg.audioStart).toFixed(1)}s</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
