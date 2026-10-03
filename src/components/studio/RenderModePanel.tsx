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

/** Настройки ленты хранятся в координатах кадра 1080p. */
const EXPORT_FRAME_H = 1080;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.7;

function zoomOf(stripViewport: number): number {
  return EXPORT_FRAME_H / Math.max(1, stripViewport);
}

/**
 * Переключатель режима рендера. «Лента» склеивает страницы в вертикальную
 * полосу и ведёт по ней окно просмотра, синхронно с озвучкой.
 *
 * Масштаб подписан в человеческих процентах (100 % — ширина страницы совпадает
 * с шириной кадра); раньше здесь было «Зона просмотра · 1.00×», где увеличение
 * ползунка вправо уменьшало страницу.
 */
export function RenderModePanel({ renderMode, stripViewport, stripGap, onChange }: RenderModePanelProps) {
  const isStrip = renderMode === 'strip';
  const zoom = zoomOf(stripViewport);
  const pageCount = 3;

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
        <div className="flex gap-4">
          <div className="flex-1 space-y-3">
            <div className="space-y-1">
              <Label className="text-[11px] text-[#8A8A93]" htmlFor="strip-zoom">
                Масштаб страницы · {Math.round(zoom * 100)}%
              </Label>
              <input
                id="strip-zoom"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.05}
                value={zoom}
                onChange={(e) => onChange({ stripViewport: Math.round(EXPORT_FRAME_H / Number(e.target.value)) })}
                className="w-full accent-[#E8B44C]"
              />
              <p className="text-[10px] leading-snug text-[#8A8A93]">
                100 % — ширина страницы совпадает с шириной кадра. Влево — мельче и видно больше,
                вправо — крупнее для чтения мелкого текста.
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
                Показывается фоном между страницами при прокрутке.
              </p>
            </div>
          </div>

          <StripSchematic zoom={zoom} gap={stripGap} pageCount={pageCount} />
        </div>
      )}
    </div>
  );
}

/**
 * Схема ленты: страницы разной высоты и окно просмотра в тех же пропорциях,
 * что и в экспорте. Нужна, чтобы настройку не приходилось подбирать вслепую.
 */
export function StripSchematic({ zoom, gap, pageCount = 3 }: { zoom: number; gap: number; pageCount?: number }) {
  const width = 76;
  const height = 96;
  // Пропорции как в кадре: ширина ленты = ширине кадра × zoom.
  const stripWidth = Math.min(width, width * zoom);
  const viewportHeight = height; // окно всегда во всю высоту схемы
  const pageHeights = [0.5, 0.9, 0.7].slice(0, pageCount).map(r => viewportHeight * r * zoom);
  const gapPx = Math.min(10, gap / 6);

  let y = 0;
  const pages = pageHeights.map(h => {
    const page = { y, h, clipped: y + h > viewportHeight };
    y += h + gapPx;
    return page;
  });

  return (
    <div className="shrink-0" title="Схема: рамка — кадр, полосы — страницы ленты">
      <svg width={width} height={height} className="rounded-[6px] border border-[#26262C] bg-[#0B0B0C]">
        <g>
          {pages.map((page, i) => (
            <rect
              key={i}
              x={(width - stripWidth) / 2}
              y={page.y}
              width={stripWidth}
              height={Math.max(1, Math.min(page.h, viewportHeight - page.y))}
              fill={i === 0 ? '#E8B44C' : '#3A3A42'}
              opacity={i === 0 ? 0.85 : 0.9}
            />
          ))}
        </g>
        {/* окно просмотра = весь кадр; подписываем только рамку */}
        <rect x={0.5} y={0.5} width={width - 1} height={height - 1} fill="none" stroke="#8A8A93" strokeDasharray="3 3" />
      </svg>
      <p className="mt-1 text-center text-[9px] text-[#8A8A93]">кадр</p>
    </div>
  );
}

export const RENDER_DEFAULTS: RenderSettings = {
  renderMode: 'panels',
  stripViewport: 1080,
  stripGap: STRIP_DEFAULTS.gap,
};
