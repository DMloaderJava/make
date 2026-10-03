"use client";

import { Label } from '@/components/ui/label';
import { STRIP_DEFAULTS } from '@/lib/pipeline/mangaStrip';

export interface RenderSettings {
  renderMode: 'panels' | 'strip';
  stripViewport: number;
  stripGap: number;
}

interface RenderModePanelProps extends RenderSettings {
  onChange: (patch: Partial<RenderSettings>) => void;
}

/**
 * Переключатель режима рендера. «Лента» склеивает страницы в вертикальную
 * полосу и ведёт по ней окно просмотра, синхронно с озвучкой.
 */
export function RenderModePanel({ renderMode, stripViewport, stripGap, onChange }: RenderModePanelProps) {
  const isStrip = renderMode === 'strip';
  const viewportRatio = stripViewport / 1080;

  return (
    <div className="w-full bg-[#16161A] rounded-[10px] border border-[#26262C] px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">Режим рендера</span>
          <span className="font-mono text-[11px] text-[#8A8A93]">
            {isStrip ? 'вебтун-скролл' : 'постранично'}
          </span>
        </div>
        <div className="flex rounded-[6px] border border-[#26262C] overflow-hidden">
          <button
            onClick={() => onChange({ renderMode: 'panels' })}
            className={`h-7 px-3 text-[11px] transition-colors ${!isStrip ? 'bg-[#E8B44C] text-[#0B0B0C] font-medium' : 'bg-[#0B0B0C] text-[#8A8A93] hover:text-[#F5F5F7]'}`}
          >
            Панели
          </button>
          <button
            onClick={() => onChange({ renderMode: 'strip' })}
            className={`h-7 px-3 text-[11px] transition-colors ${isStrip ? 'bg-[#E8B44C] text-[#0B0B0C] font-medium' : 'bg-[#0B0B0C] text-[#8A8A93] hover:text-[#F5F5F7]'}`}
          >
            Лента
          </button>
        </div>
      </div>

      {isStrip && (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-[11px] text-[#8A8A93]" htmlFor="strip-viewport">
              Зона просмотра · {viewportRatio.toFixed(2)}×
            </Label>
            <input
              id="strip-viewport"
              type="range"
              min={0.6}
              max={2}
              step={0.05}
              value={viewportRatio}
              onChange={(e) => onChange({ stripViewport: Math.round(Number(e.target.value) * 1080) })}
              className="w-full accent-[#E8B44C]"
            />
            <p className="text-[10px] leading-snug text-[#8A8A93]">
              Меньше — крупнее кадр (сильнее зум), больше — видно больше страниц сразу.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-[#8A8A93]" htmlFor="strip-gap">
              Отступ между страницами · {stripGap}px
            </Label>
            <input
              id="strip-gap"
              type="range"
              min={0}
              max={64}
              step={4}
              value={stripGap}
              onChange={(e) => onChange({ stripGap: Number(e.target.value) })}
              className="w-full accent-[#E8B44C]"
            />
            <p className="text-[10px] leading-snug text-[#8A8A93]">
              Показывается фон между страницами при прокрутке.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export const RENDER_DEFAULTS: RenderSettings = {
  renderMode: 'panels',
  stripViewport: 1080,
  stripGap: STRIP_DEFAULTS.gap,
};
