"use client";

import { useEffect, useRef, useState } from 'react';
import { PanelData } from '@/lib/pipeline/extractPanels';
import { SyncTimeline } from '@/lib/storage/db';

interface PreviewProps {
  images: string[];
  panels: PanelData[];
  currentPanelIndex: number;
  timeline: SyncTimeline[];
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
}

export function Preview({ images, panels, currentPanelIndex, timeline, currentTime, duration, isPlaying, onPlayPause, onSeek }: PreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState<Map<string, HTMLImageElement>>(new Map());

  useEffect(() => {
    const load = async () => {
      const map = new Map<string, HTMLImageElement>();
      for (const src of images) {
        if (!src) continue;
        if (map.has(src)) continue;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = src;
        await new Promise<void>((res) => {
          img.onload = () => res();
          img.onerror = () => res();
          setTimeout(() => res(), 2000);
        });
        map.set(src, img);
      }
      setLoaded(map);
    };
    load();
  }, [images]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const w = 1280;
    const h = 720;
    canvas.width = w;
    canvas.height = h;

    const currentPanel = panels[currentPanelIndex];
    if (!currentPanel) {
      ctx.fillStyle = '#0B0B0C';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#8A8A93';
      ctx.font = '14px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillText('Нет панелей', w/2, h/2);
      return;
    }

    const img = loaded.get(images[currentPanel.imageIndex]);
    ctx.fillStyle = '#0B0B0C';
    ctx.fillRect(0, 0, w, h);

    if (img) {
      const seg = timeline.find(t => t.panelId === currentPanel.id);
      const progress = seg ? Math.min(1, Math.max(0, (currentTime - seg.audioStart) / (seg.audioEnd - seg.audioStart || 1))) : 0;
      const scale = 1 + progress * 0.08;
      
      const imgAspect = img.width / img.height;
      const canvasAspect = w / h;
      let dw, dh, ox, oy;
      if (imgAspect > canvasAspect) {
        dh = h * scale;
        dw = dh * imgAspect;
        const maxXOffset = (dw - w) / 2;
        ox = (w - dw) / 2 - Math.min(progress * 20, maxXOffset);
        oy = (h - dh) / 2;
        ox = Math.max(w - dw, Math.min(0, ox));
        oy = Math.max(h - dh, Math.min(0, oy));
      } else {
        dw = w * scale;
        dh = dw / imgAspect;
        const maxYOffset = (dh - h) / 2;
        ox = (w - dw) / 2;
        oy = (h - dh) / 2 - Math.min(progress * 10, maxYOffset);
        ox = Math.max(w - dw, Math.min(0, ox));
        oy = Math.max(h - dh, Math.min(0, oy));
      }
      ctx.drawImage(img, ox, oy, dw, dh);
    }

    ctx.fillStyle = 'rgba(11,11,12,0.25)';
    ctx.fillRect(0, 0, w, h);

    const bbox = currentPanel.bbox;
    const bx = (bbox.x / 100) * w;
    const by = (bbox.y / 100) * h;
    const bw = (bbox.width / 100) * w;
    const bh = (bbox.height / 100) * h;

    ctx.strokeStyle = '#E8B44C';
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 6);
    else ctx.rect(bx, by, bw, bh);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = '#16161A';
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect(bx, Math.max(4, by - 22), Math.min(160, ctx.measureText(currentPanel.character).width + 20), 18, 20);
    else ctx.rect(bx, Math.max(4, by - 22), 160, 18);
    ctx.fill();
    ctx.fillStyle = '#F5F5F7';
    ctx.font = '12px Inter';
    ctx.textAlign = 'left';
    ctx.fillText(currentPanel.character, bx + 10, Math.max(4, by - 22) + 12);

    ctx.fillStyle = 'rgba(22,22,26,0.92)';
    const boxY = h * 0.78;
    const boxH = h * 0.18;
    ctx.beginPath();
    // @ts-ignore
    if (ctx.roundRect) ctx.roundRect(w * 0.08, boxY, w * 0.84, boxH, 10);
    else ctx.rect(w * 0.08, boxY, w * 0.84, boxH);
    ctx.fill();

    ctx.fillStyle = '#F5F5F7';
    ctx.font = '18px Inter';
    ctx.textAlign = 'center';
    const maxW = w * 0.76;
    const words = currentPanel.dialogue.split(' ');
    let lines: string[] = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? `${cur} ${word}` : word;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = word;
      } else cur = test;
    }
    if (cur) lines.push(cur);
    let y = boxY + 32;
    for (const line of lines.slice(0, 2)) {
      ctx.fillText(line, w/2, y);
      y += 26;
    }

    if (duration > 0 && isFinite(duration)) {
      const pw = (currentTime / duration) * w;
      ctx.fillStyle = '#E8B44C';
      ctx.fillRect(0, h - 2, Math.max(0, Math.min(w, pw)), 2);
    }
  }, [loaded, panels, currentPanelIndex, timeline, currentTime, duration]);

  const formatTime = (s: number) => {
    if (!isFinite(s) || s <= 0) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  };

  return (
    <div className="w-full">
      <div className="relative aspect-video bg-[#0B0B0C] rounded-[16px] overflow-hidden border border-[#26262C] group">
        <canvas ref={canvasRef} className="w-full h-full" />
        
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-[150ms] bg-[#0B0B0C]/20">
          <button
            onClick={onPlayPause}
            className="w-12 h-12 rounded-full bg-[#16161A] border border-[#26262C] flex items-center justify-center text-[#F5F5F7] hover:bg-[#1E1E23] transition-colors duration-[150ms]"
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
        </div>

        <div className="absolute bottom-0 left-0 right-0 h-10 px-4 flex items-center justify-between bg-gradient-to-t from-[#0B0B0C]/80 to-transparent">
          <div className="flex items-center gap-3">
            <button onClick={onPlayPause} className="text-[#F5F5F7] text-sm hover:text-[#E8B44C] transition-colors">
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <span className="font-mono text-[12px] text-[#8A8A93]">{formatTime(currentTime)} / {formatTime(duration)}</span>
          </div>
          <span className="font-mono text-[11px] text-[#8A8A93]">Панель {currentPanelIndex + 1} из {panels.length}</span>
        </div>
      </div>
    </div>
  );
}
