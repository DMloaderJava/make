"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyncTimeline } from '@/lib/storage/db';

interface TimelineProps {
  images: string[];
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
  panelGap?: number;
  onGapChange?: (gap: number) => void;
  audioPanelIds?: number[];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const TRACK_OFFSET = 72;

function formatTime(s: number): string {
  if (!isFinite(s) || s <= 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function waveform(panelId: number, count = 32): number[] {
  return Array.from({ length: count }, (_, i) => {
    const value = Math.abs(Math.sin((panelId + 1) * 7.31 + i * 1.83) * 0.58 + Math.cos(i * 0.71 + panelId) * 0.24);
    return clamp(0.18 + value, 0.16, 0.95);
  });
}

export function Timeline({
  images,
  timeline,
  currentTime,
  duration,
  onSeek,
  onSelectPanel,
  onSelectIntro,
  onSelectOutro,
  selectedId,
  introDuration = 8,
  outroDuration = 5,
  panelGap = 0.3,
  onGapChange,
  audioPanelIds = [],
}: TimelineProps) {
  const [localGap, setLocalGap] = useState(panelGap);
  const [zoom, setZoom] = useState(1);
  const [dragging, setDragging] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const audioSet = useMemo(() => new Set(audioPanelIds), [audioPanelIds]);
  const safeDuration = isFinite(duration) && duration > 0 ? duration : 1;
  const contentWidth = Math.max(760, Math.round(960 * zoom));
  const trackWidth = Math.max(1, contentWidth - TRACK_OFFSET);

  useEffect(() => setLocalGap(panelGap), [panelGap]);

  const commitGap = () => {
    if (onGapChange && Math.abs(localGap - panelGap) > 0.001) onGapChange(localGap);
  };

  const seekFromClientX = (clientX: number) => {
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return;
    // contentRect уже учитывает горизонтальный scroll. Считаем от начала
    // track-area, а не от общего контейнера с лейблами «Видео/Аудио».
    const x = clamp(clientX - rect.left - TRACK_OFFSET, 0, trackWidth);
    onSeek((x / trackWidth) * safeDuration);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input')) return;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromClientX(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) seekFromClientX(event.clientX);
  };

  const handlePointerUp = () => setDragging(false);

  return (
    <section className="w-full min-h-[300px] rounded-[12px] border border-[#26262C] bg-[#111114] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#26262C] px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-[#F5F5F7]">Монтажная лента</h3>
          <span className="rounded bg-[#1E1E23] px-1.5 py-0.5 text-[10px] text-[#8A8A93]">кадры + аудио</span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2" title="Пауза между репликами">
            <span className="font-mono text-[10px] text-[#8A8A93]">пауза {localGap.toFixed(2).replace(/\.?0+$/, '').replace('.', ',')} с</span>
            <input type="range" min={0} max={1.5} step={0.05} value={localGap} onChange={(e) => setLocalGap(Number(e.target.value))} onMouseUp={commitGap} onTouchEnd={commitGap} onKeyUp={commitGap} onBlur={commitGap} className="w-20 accent-[#E8B44C]" />
          </label>
          <div className="flex items-center gap-1 rounded-md border border-[#26262C] bg-[#0B0B0C] px-1">
            <button type="button" onClick={() => setZoom(z => clamp(Number((z - 0.25).toFixed(2)), 0.75, 4))} className="h-6 w-6 text-[#A1A1AA] hover:text-[#F5F5F7]" title="Уменьшить масштаб">−</button>
            <span className="w-10 text-center font-mono text-[10px] text-[#8A8A93]">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom(z => clamp(Number((z + 0.25).toFixed(2)), 0.75, 4))} className="h-6 w-6 text-[#A1A1AA] hover:text-[#F5F5F7]" title="Увеличить масштаб">+</button>
          </div>
          <span className="font-mono text-[11px] text-[#8A8A93]">{formatTime(currentTime)} / {formatTime(duration)}</span>
        </div>
      </div>

      <div ref={scrollerRef} data-scroll-area className="overflow-x-auto overflow-y-hidden px-3 pb-3">
        <div ref={contentRef} className="relative min-w-0 pt-7" style={{ width: contentWidth }} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}>
          <div className="pointer-events-none absolute top-0 h-6 border-b border-[#26262C]" style={{ left: TRACK_OFFSET, right: 0 }}>
            {Array.from({ length: Math.max(2, Math.ceil(safeDuration / 5) + 1) }).map((_, i) => (
              <span key={i} className="absolute top-1 -translate-x-1/2 font-mono text-[9px] text-[#666672]" style={{ left: `${(Math.min(i * 5, safeDuration) / safeDuration) * 100}%` }}>{formatTime(Math.min(i * 5, safeDuration))}</span>
            ))}
          </div>

          <div className="grid grid-cols-[72px_1fr] gap-2 border-b border-[#26262C] py-3">
            <div className="flex items-center text-[10px] uppercase tracking-wider text-[#8A8A93]">Видео</div>
            <div className="relative h-24 rounded-md bg-[#0B0B0C]">
              <button type="button" onClick={() => { onSelectIntro(); onSeek(0); }} className={`absolute top-1 bottom-1 overflow-hidden rounded border text-left ${selectedId === 'intro' ? 'border-[#F5D27A] bg-[#594615]' : 'border-[#3A321F] bg-[#2A2416]'}`} style={{ left: 0, width: `${Math.max(1.5, (introDuration / safeDuration) * 100)}%` }} title="Интро">
                <span className="block px-1.5 pt-1 text-[10px] text-[#E8B44C]">Интро</span>
              </button>
              {timeline.map((seg) => {
                const left = (seg.audioStart / safeDuration) * 100;
                const width = Math.max(1.2, ((seg.audioEnd - seg.audioStart) / safeDuration) * 100);
                const selected = selectedId === seg.panelId;
                return (
                  <button key={seg.panelId} type="button" onClick={() => { onSelectPanel(seg.panelId); onSeek(seg.audioStart); }} className={`absolute top-1 bottom-1 overflow-hidden rounded border text-left transition-colors ${selected ? 'border-[#F5D27A] ring-1 ring-[#E8B44C] bg-[#3A311D]' : 'border-[#34343C] bg-[#24242B] hover:border-[#77736A]'}`} style={{ left: `${left}%`, width: `${width}%` }} title={`Изображение ${seg.imageIndex + 1}`}>
                    {images[seg.imageIndex] ? <img src={images[seg.imageIndex]} alt="" className="h-full w-full object-cover opacity-75" /> : <span className="text-[10px] text-[#8A8A93]">Кадр {seg.imageIndex + 1}</span>}
                    <span className="absolute inset-x-1 bottom-0 truncate bg-black/55 px-1 text-[9px] text-white">Кадр {seg.imageIndex + 1}</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => { onSelectOutro(); onSeek(Math.max(0, safeDuration - outroDuration)); }} className={`absolute top-1 bottom-1 overflow-hidden rounded border px-1 text-left ${selectedId === 'outro' ? 'border-[#F5D27A] bg-[#594615]' : 'border-[#3A321F] bg-[#2A2416]'}`} style={{ left: `${Math.max(0, ((timeline[timeline.length - 1]?.audioEnd ?? introDuration) / safeDuration) * 100)}%`, width: `${Math.max(1.5, (outroDuration / safeDuration) * 100)}%` }} title="Аутро">
                <span className="text-[10px] text-[#E8B44C]">Аутро</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-[72px_1fr] gap-2 py-3">
            <div className="flex items-center text-[10px] uppercase tracking-wider text-[#E8B44C]">Аудио</div>
            <div className="relative h-24 rounded-md border border-[#3A321F] bg-[#0B0B0C]">
              {timeline.map((seg) => {
                const left = (seg.audioStart / safeDuration) * 100;
                const width = Math.max(1.2, ((seg.audioEnd - seg.audioStart) / safeDuration) * 100);
                const hasAudio = audioSet.has(seg.panelId);
                const selected = selectedId === seg.panelId;
                return (
                  <button key={seg.panelId} type="button" onClick={() => { onSelectPanel(seg.panelId); onSeek(seg.audioStart); }} className={`absolute top-1 bottom-1 overflow-hidden rounded border px-1 text-left ${selected ? 'border-[#F5D27A] bg-[#57451B]' : hasAudio ? 'border-[#806522] bg-[#332915] hover:bg-[#463719]' : 'border-[#34343C] bg-[#202025] hover:border-[#77736A]'}`} style={{ left: `${left}%`, width: `${width}%` }} title={hasAudio ? `Аудио панели ${seg.panelId}` : `Нет аудио панели ${seg.panelId}`}>
                    <div className="flex h-full items-center gap-px px-1 opacity-90">
                      {waveform(seg.panelId, 48).map((height, i) => <i key={i} className={`min-w-[2px] flex-1 rounded-full ${hasAudio ? 'bg-[#E8B44C]' : 'bg-[#666672]'}`} style={{ height: `${height * 76}%` }} />)}
                    </div>
                    {!hasAudio && <span className="absolute inset-x-1 bottom-0 truncate bg-black/45 text-[8px] text-[#A1A1AA]">нет файла</span>}
                  </button>
                );
              })}
              <button type="button" onClick={() => { onSelectIntro(); onSeek(0); }} className="absolute top-1 bottom-1 rounded border border-[#3A321F] bg-[#2A2416] px-1 text-[9px] text-[#C9B27A]" style={{ left: 0, width: `${Math.max(1.5, (introDuration / safeDuration) * 100)}%` }}>Интро</button>
            </div>
          </div>

          <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-[#F5D27A] shadow-[0_0_8px_rgba(232,180,76,0.8)]" style={{ left: `${TRACK_OFFSET + (clamp(currentTime, 0, safeDuration) / safeDuration) * trackWidth}px` }}>
            <span className="absolute -left-1.5 -top-1 h-3 w-3 rotate-45 rounded-[2px] bg-[#F5D27A]" />
          </div>
        </div>
      </div>
    </section>
  );
}
