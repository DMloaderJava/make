"use client";

import { SEOPackage } from '@/lib/storage/db';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Copy, Download, Sparkles, Eye } from 'lucide-react';
import { useState } from 'react';
import { formatSEOPackage } from '@/lib/pipeline/generateSEO';
import { downloadBlob } from '@/lib/utils';

interface SEOViewerProps {
  seo: SEOPackage | null;
  onGenerate?: () => void;
  generating?: boolean;
}

export function SEOViewer({ seo, onGenerate, generating }: SEOViewerProps) {
  const [copied, setCopied] = useState<string | null>(null);

  const handleCopy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDownload = () => {
    if (!seo) return;
    const text = formatSEOPackage(seo);
    const blob = new Blob([text], { type: 'text/plain' });
    downloadBlob(blob, 'youtube-seo-package.txt');
  };

  if (!seo) {
    return (
      <Card className="bg-zinc-900 border-zinc-800 border-dashed">
        <CardContent className="p-6 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-indigo-500/20 flex items-center justify-center mx-auto">
            <Sparkles className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-white">SEO-пакет для YouTube</p>
            <p className="text-xs text-zinc-500 mt-1">Заголовки, описание, теги, превью, тайм-коды</p>
          </div>
          {onGenerate && (
            <Button onClick={onGenerate} disabled={generating} size="sm" className="w-full">
              <Sparkles className="w-4 h-4 mr-2" />
              {generating ? 'Генерация...' : 'Сгенерировать SEO-пакет'}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Eye className="w-4 h-4 text-emerald-400" />
              YouTube SEO-пакет
            </CardTitle>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleDownload}>
                <Download className="w-3 h-3" />
              </Button>
              {onGenerate && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGenerate} disabled={generating}>
                  <Sparkles className="w-3 h-3 mr-1" />
                  Перегенерировать
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Title */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-300">Заголовок (основной)</label>
              <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => handleCopy(seo.title.main, 'title')}>
                {copied === 'title' ? 'Скопировано!' : <><Copy className="w-3 h-3 mr-1" /> Копировать</>}
              </Button>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-white">
              {seo.title.main}
            </div>
            <div className="text-[11px] text-zinc-500">{seo.title.main.length}/70 символов</div>
            
            <div className="space-y-1">
              <label className="text-[11px] text-zinc-500">Альтернативы:</label>
              {seo.title.alternatives.map((alt, i) => (
                <div key={i} className="text-xs text-zinc-400 bg-zinc-800/50 p-2 rounded flex justify-between items-start gap-2">
                  <span>{i + 1}. {alt}</span>
                  <button onClick={() => handleCopy(alt, `alt-${i}`)} className="text-zinc-500 hover:text-white flex-shrink-0">
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-zinc-300">Описание</label>
              <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => handleCopy(`${seo.description.hook}\n\n${seo.description.body}\n\n${seo.description.hashtags.join(' ')}`, 'desc')}>
                {copied === 'desc' ? 'Скопировано!' : <><Copy className="w-3 h-3 mr-1" /> Копировать всё</>}
              </Button>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-800 border border-zinc-700 space-y-2">
              <div className="text-sm text-white font-medium">{seo.description.hook}</div>
              <div className="text-xs text-zinc-400 whitespace-pre-wrap">{seo.description.body}</div>
              <div className="text-xs text-indigo-400">{seo.description.hashtags.join(' ')}</div>
            </div>
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-300">Теги ({seo.tags.length})</label>
            <div className="flex flex-wrap gap-1.5">
              {seo.tags.map((tag, i) => (
                <span key={i} className="text-[11px] bg-zinc-800 text-zinc-300 px-2 py-1 rounded-full border border-zinc-700">
                  {tag}
                </span>
              ))}
            </div>
            <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => handleCopy(seo.tags.join(', '), 'tags')}>
              {copied === 'tags' ? 'Скопировано!' : 'Копировать теги'}
            </Button>
          </div>

          {/* Thumbnail */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-300">Превью</label>
            <div className="p-2.5 rounded-lg bg-zinc-800 border border-zinc-700 space-y-2">
              <div>
                <span className="text-[11px] text-zinc-500">Промт (EN):</span>
                <p className="text-xs text-zinc-300 mt-1">{seo.thumbnail.prompt}</p>
              </div>
              <div className="flex gap-4">
                <div>
                  <span className="text-[11px] text-zinc-500">Текст:</span>
                  <p className="text-xs text-white font-bold">{seo.thumbnail.textOverlay}</p>
                </div>
                <div>
                  <span className="text-[11px] text-zinc-500">Эмоция:</span>
                  <p className="text-xs text-zinc-300">{seo.thumbnail.emotion}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Chapters */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-300">Тайм-коды</label>
            <div className="bg-zinc-800 rounded-lg p-2 space-y-1">
              {seo.chapters.map((ch, i) => (
                <div key={i} className="flex gap-3 text-xs">
                  <span className="text-indigo-400 font-mono">{ch.time}</span>
                  <span className="text-zinc-300">{ch.title}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Other */}
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="bg-zinc-800/50 p-2 rounded">
              <span className="text-zinc-500">Публикация:</span>
              <p className="text-white mt-1">{seo.publishTime}</p>
            </div>
            <div className="bg-zinc-800/50 p-2 rounded">
              <span className="text-zinc-500">Закреп. коммент:</span>
              <p className="text-zinc-300 mt-1 line-clamp-3">{seo.pinnedComment}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
