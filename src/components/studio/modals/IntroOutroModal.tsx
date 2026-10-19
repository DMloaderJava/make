'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface IntroOutroModalProps {
  open: boolean;
  onClose: () => void;
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  introAudio?: Blob | null;
  outroAudio?: Blob | null;
  onIntroAudioUpload: (file: File) => Promise<void>;
  onOutroAudioUpload: (file: File) => Promise<void>;
  onClearIntroAudio: () => Promise<void>;
  onClearOutroAudio: () => Promise<void>;
  onApply: (patch: { intro: string; outro: string; introDuration: number; outroDuration: number }) => void;
  onGenerateAI: () => void;
  onVoice: () => void;
  onClear: () => void;
  generating: boolean;
  voicing: boolean;
}

const DEFAULT_INTRO_DURATION = 8;
const DEFAULT_OUTRO_DURATION = 5;

export function IntroOutroModal({
  open, onClose, intro, outro, introDuration, outroDuration,
  introAudio, outroAudio, onIntroAudioUpload, onOutroAudioUpload,
  onClearIntroAudio, onClearOutroAudio, onApply, onGenerateAI, onVoice, onClear, generating, voicing,
}: IntroOutroModalProps) {
  const [introText, setIntroText] = useState(intro);
  const [outroText, setOutroText] = useState(outro);
  const [introDur, setIntroDur] = useState<string>(String(introDuration || DEFAULT_INTRO_DURATION));
  const [outroDur, setOutroDur] = useState<string>(String(outroDuration || DEFAULT_OUTRO_DURATION));
  const [busyAudio, setBusyAudio] = useState<'intro' | 'outro' | null>(null);
  const introInputRef = useRef<HTMLInputElement>(null);
  const outroInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setIntroText(intro);
      setOutroText(outro);
      setIntroDur(String(introDuration || DEFAULT_INTRO_DURATION));
      setOutroDur(String(outroDuration || DEFAULT_OUTRO_DURATION));
    }
  }, [open, intro, outro, introDuration, outroDuration]);

  if (!open) return null;

  const parseDur = (value: string, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.min(60, n) : fallback;
  };

  const handleApply = () => onApply({
    intro: introText,
    outro: outroText,
    introDuration: parseDur(introDur, DEFAULT_INTRO_DURATION),
    outroDuration: parseDur(outroDur, DEFAULT_OUTRO_DURATION),
  });

  const importAudio = async (kind: 'intro' | 'outro', file: File) => {
    setBusyAudio(kind);
    try {
      if (kind === 'intro') await onIntroAudioUpload(file);
      else await onOutroAudioUpload(file);
    } finally {
      setBusyAudio(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0B0C]/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[560px] bg-[#16161A] border border-[#26262C] rounded-[16px] shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-[#26262C] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-medium">Интро и аутро</h2>
            <p className="text-[11px] text-[#8A8A93] mt-0.5">Текст и аудио хранятся отдельно от панелей.</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-[6px] bg-[#1E1E23] hover:bg-[#26262C] flex items-center justify-center text-[#8A8A93]">×</button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-[#8A8A93]">Текст интро</label>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[#8A8A93]">длительность, сек</span>
                <Input data-testid="intro-duration-input" type="number" value={introDur} onChange={(e) => setIntroDur(e.target.value)} min={0} max={60} step={0.5} className="w-20 h-7 bg-[#0B0B0C] border-[#26262C] text-xs" />
              </div>
            </div>
            <textarea data-testid="intro-text-input" value={introText} onChange={(e) => setIntroText(e.target.value)} rows={3} placeholder="Например: Добро пожаловать в новый разбор манги…" className="w-full rounded-[8px] bg-[#0B0B0C] border border-[#26262C] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#5A5A63] resize-y" />
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => introInputRef.current?.click()} disabled={busyAudio !== null || generating || voicing} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C]">{busyAudio === 'intro' ? 'Загрузка…' : 'Загрузить аудио интро'}</Button>
              <input ref={introInputRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void importAudio('intro', file); e.target.value = ''; }} />
              <span className="text-[11px] text-[#8A8A93]">{introAudio ? 'аудио загружено' : 'аудио не задано'}</span>
              {introAudio && <button onClick={() => void onClearIntroAudio()} disabled={busyAudio !== null} className="text-[11px] text-[#C97A66] hover:text-[#F87171]">удалить</button>}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-[#8A8A93]">Текст аутро</label>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[#8A8A93]">длительность, сек</span>
                <Input data-testid="outro-duration-input" type="number" value={outroDur} onChange={(e) => setOutroDur(e.target.value)} min={0} max={60} step={0.5} className="w-20 h-7 bg-[#0B0B0C] border-[#26262C] text-xs" />
              </div>
            </div>
            <textarea data-testid="outro-text-input" value={outroText} onChange={(e) => setOutroText(e.target.value)} rows={3} placeholder="Например: Спасибо за просмотр, подпишитесь…" className="w-full rounded-[8px] bg-[#0B0B0C] border border-[#26262C] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#5A5A63] resize-y" />
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => outroInputRef.current?.click()} disabled={busyAudio !== null || generating || voicing} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C]">{busyAudio === 'outro' ? 'Загрузка…' : 'Загрузить аудио аутро'}</Button>
              <input ref={outroInputRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void importAudio('outro', file); e.target.value = ''; }} />
              <span className="text-[11px] text-[#8A8A93]">{outroAudio ? 'аудио загружено' : 'аудио не задано'}</span>
              {outroAudio && <button onClick={() => void onClearOutroAudio()} disabled={busyAudio !== null} className="text-[11px] text-[#C97A66] hover:text-[#F87171]">удалить</button>}
            </div>
          </section>

          <p className="text-[11px] leading-4 text-[#8A8A93]">Если загружено аудио, его реальная длительность используется для перехода дальше. Если аудио нет, используется длительность текстового сегмента.</p>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#26262C]">
            <Button variant="outline" size="sm" onClick={onGenerateAI} disabled={generating || voicing || busyAudio !== null} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C]">{generating ? 'Генерация…' : 'Сгенерировать AI'}</Button>
            <Button variant="outline" size="sm" onClick={onVoice} disabled={generating || voicing || busyAudio !== null} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C]">{voicing ? 'Озвучка…' : 'Озвучить текст'}</Button>
            <Button variant="outline" size="sm" onClick={onClear} disabled={generating || voicing || busyAudio !== null} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C]">Очистить текст</Button>
            <Button data-testid="intro-outro-apply-btn" size="sm" onClick={handleApply} disabled={generating || voicing || busyAudio !== null} className="ml-auto h-8 text-xs bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E]">Применить</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
