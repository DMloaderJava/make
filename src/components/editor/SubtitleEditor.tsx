"use client";

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Subtitles, Download, Wand2 } from 'lucide-react';

interface SubtitleEditorProps {
  srt: string;
  onChange: (srt: string) => void;
  onGenerate?: () => void;
  generating?: boolean;
}

export function SubtitleEditor({ srt, onChange, onGenerate, generating }: SubtitleEditorProps) {
  const handleDownload = () => {
    const blob = new Blob([srt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subtitles.srt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const cues = srt ? srt.split('\n\n').filter(Boolean) : [];

  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Subtitles className="w-4 h-4" />
            Субтитры (SRT)
          </CardTitle>
          <div className="flex gap-1">
            {onGenerate && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGenerate} disabled={generating}>
                <Wand2 className="w-3 h-3 mr-1" />
                {generating ? '...' : 'Авто-генерация'}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={handleDownload} disabled={!srt}>
              <Download className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-[11px] text-zinc-500">
          {cues.length} реплик • Генерируются из таймлайна или через Whisper (OpenAI / локально)
        </div>
        
        <Textarea
          value={srt}
          onChange={(e) => onChange(e.target.value)}
          placeholder={`1
00:00:00,000 --> 00:00:03,500
Привет! Это пример субтитров...

2
00:00:03,500 --> 00:00:06,000
Они синхронизированы с аудио.`}
          className="min-h-[200px] font-mono text-xs"
        />

        {cues.length > 0 && (
          <div className="max-h-40 overflow-y-auto space-y-1 bg-zinc-950 rounded-lg p-2 border border-zinc-800">
            {cues.slice(0, 20).map((cue, idx) => {
              const lines = cue.split('\n');
              return (
                <div key={idx} className="text-[11px] flex gap-2">
                  <span className="text-zinc-600 font-mono">{lines[1]?.split(' ')[0] || ''}</span>
                  <span className="text-zinc-400 truncate">{lines.slice(2).join(' ')}</span>
                </div>
              );
            })}
            {cues.length > 20 && (
              <div className="text-[10px] text-zinc-600 text-center">...и ещё {cues.length - 20} реплик</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
