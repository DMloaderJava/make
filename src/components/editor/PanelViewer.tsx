"use client";

import { useEffect, useRef, useState } from 'react';
import { PanelData } from '@/lib/pipeline/extractPanels';
import { SyncTimeline } from '@/lib/storage/db';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Play, Pause, SkipBack, SkipForward, Volume2 } from 'lucide-react';

interface PanelViewerProps {
  images: string[];
  panels: PanelData[];
  currentPanelIndex: number;
  timeline: SyncTimeline[];
  isPlaying?: boolean;
  onPlayPause?: () => void;
  currentTime?: number;
  duration?: number;
}

export function PanelViewer({ images, panels, currentPanelIndex, timeline, isPlaying, onPlayPause, currentTime = 0, duration = 0 }: PanelViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loadedImages, setLoadedImages] = useState<HTMLImageElement[]>([]);

  useEffect(() => {
    const loadImages = async () => {
      const imgs: HTMLImageElement[] = [];
      for (const src of images) {
        const img = new Image();
        img.src = src;
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = res;
        });
        imgs.push(img);
      }
      setLoadedImages(imgs);
    };
    loadImages();
  }, [images]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loadedImages.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 1280;
    const height = 720;
    canvas.width = width;
    canvas.height = height;

    // Find current panel
    const currentPanel = panels[currentPanelIndex] || panels[0];
    const currentTimeline = timeline.find(t => t.panelId === currentPanel?.id) || timeline[0];

    // Background
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, height);

    if (!currentPanel) {
      ctx.fillStyle = '#fff';
      ctx.font = '24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Нет панелей', width / 2, height / 2);
      return;
    }

    const imgIndex = currentPanel.imageIndex;
    const img = loadedImages[imgIndex];
    if (!img) return;

    // Calculate Ken Burns - simple zoom
    const progress = currentTimeline ? Math.min(1, Math.max(0, (currentTime - currentTimeline.audioStart) / (currentTimeline.audioEnd - currentTimeline.audioStart || 1))) : 0;
    const scale = 1 + progress * 0.15;
    
    // Draw image with object-fit cover
    const imgAspect = img.width / img.height;
    const canvasAspect = width / height;
    let drawWidth, drawHeight, offsetX, offsetY;

    if (imgAspect > canvasAspect) {
      drawHeight = height * scale;
      drawWidth = drawHeight * imgAspect;
      offsetX = (width - drawWidth) / 2;
      offsetY = (height - drawHeight) / 2;
    } else {
      drawWidth = width * scale;
      drawHeight = drawWidth / imgAspect;
      offsetX = (width - drawWidth) / 2;
      offsetY = (height - drawHeight) / 2;
    }

    ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);

    // Dark overlay
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, width, height);

    // Highlight bbox
    const bbox = currentPanel.bbox;
    const bx = (bbox.x / 100) * width;
    const by = (bbox.y / 100) * height;
    const bw = (bbox.width / 100) * width;
    const bh = (bbox.height / 100) * height;

    // Glow effect
    ctx.shadowColor = '#6366f1';
    ctx.shadowBlur = 20;
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Character badge
    ctx.fillStyle = 'rgba(99, 102, 241, 0.9)';
    const badgeText = currentPanel.character;
    ctx.font = 'bold 14px Inter, sans-serif';
    const textMetrics = ctx.measureText(badgeText);
    const badgeWidth = textMetrics.width + 24;
    ctx.beginPath();
    ctx.roundRect(bx, Math.max(0, by - 32), badgeWidth, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(badgeText, bx + 12, Math.max(0, by - 32) + 16);

    // Dialogue box
    const dialogue = currentPanel.dialogue;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    const boxY = height * 0.72;
    const boxHeight = height * 0.23;
    ctx.beginPath();
    ctx.roundRect(width * 0.03, boxY, width * 0.94, boxHeight, 12);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.font = '20px Inter, sans-serif';
    ctx.textAlign = 'center';
    
    // Word wrap
    const maxWidth = width * 0.85;
    const words = dialogue.split(' ');
    let lines: string[] = [];
    let currentLine = '';
    for (const word of words) {
      const test = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    let y = boxY + 36;
    for (const line of lines.slice(0, 3)) {
      ctx.fillText(line, width / 2, y);
      y += 28;
    }

    // Progress bar at bottom
    if (duration > 0) {
      const progressWidth = (currentTime / duration) * width;
      ctx.fillStyle = '#6366f1';
      ctx.fillRect(0, height - 4, progressWidth, 4);
    }

  }, [loadedImages, panels, currentPanelIndex, timeline, currentTime, duration]);

  return (
    <div className="w-full space-y-3">
      <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-zinc-800">
        <canvas ref={canvasRef} className="w-full h-full object-contain" />
        
        {/* Overlay controls */}
        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 to-transparent opacity-0 hover:opacity-100 transition-opacity">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Button size="icon" variant="secondary" className="h-8 w-8" onClick={onPlayPause}>
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </Button>
              <span className="text-xs text-white font-mono">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <div className="text-xs text-zinc-400">
              Панель {currentPanelIndex + 1} / {panels.length} • {panels[currentPanelIndex]?.character || ''}
            </div>
          </div>
        </div>

        <div className="absolute top-3 left-3 bg-black/60 backdrop-blur px-2.5 py-1 rounded-full text-xs text-white flex items-center gap-1.5">
          <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
          16:9 PREVIEW
        </div>
      </div>

      {/* Panel strip */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {panels.map((panel, idx) => (
          <button
            key={panel.id}
            onClick={() => {
              // handled by parent via timeline seek
            }}
            className={`relative flex-shrink-0 w-20 h-14 rounded-lg overflow-hidden border-2 transition-all ${
              idx === currentPanelIndex ? 'border-indigo-500 ring-2 ring-indigo-500/30' : 'border-zinc-800 hover:border-zinc-600'
            }`}
          >
            {images[panel.imageIndex] && (
              <img src={images[panel.imageIndex]} alt="" className="w-full h-full object-cover" />
            )}
            <div className="absolute inset-0 bg-black/40" />
            <div className="absolute bottom-0 left-0 right-0 p-1">
              <p className="text-[8px] text-white truncate">{panel.character}</p>
            </div>
            <div className="absolute top-0.5 left-0.5 bg-black/70 text-white text-[8px] px-1 rounded">
              {idx + 1}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
