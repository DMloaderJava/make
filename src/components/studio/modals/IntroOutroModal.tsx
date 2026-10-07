'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface IntroOutroModalProps {
  open: boolean;
  onClose: () => void;
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  /** Применить значения модалки к проекту (SRT пересоберётся в редакторе). */
  onApply: (patch: { intro: string; outro: string; introDuration: number; outroDuration: number }) => void;
  /** «Сгенерировать AI»: LLM-текст при наличии ключа, иначе — шаблоны + notice. */
  onGenerateAI: () => void;
  /** «Озвучить интро/аутро»: TTS для текстов (операция редактора). */
  onVoice: () => void;
  onClear: () => void;
  generating: boolean;
  voicing: boolean;
}

const DEFAULT_INTRO_DURATION = 8;
const DEFAULT_OUTRO_DURATION = 5;

/**
 * «Интро и аутро» — отдельные сущности ролика: текст + длительность.
 * Независимы от сценария (применение сценария их не трогает).
 */
export function IntroOutroModal({ open, onClose, intro, outro, introDuration, outroDuration, onApply, onGenerateAI, onVoice, onClear, generating, voicing }: IntroOutroModalProps) {
  const [introText, setIntroText] = useState(intro);
  const [outroText, setOutroText] = useState(outro);
  const [introDur, setIntroDur] = useState<string>(String(introDuration || DEFAULT_INTRO_DURATION));
  const [outroDur, setOutroDur] = useState<string>(String(outroDuration || DEFAULT_OUTRO_DURATION));

  // При открытии — синхронизация с проектом (и сброс черновиков).
  useEffect(() => {
    if (open) {
      setIntroText(intro);
      setOutroText(outro);
      setIntroDur(String(introDuration || DEFAULT_INTRO_DURATION));
      setOutroDur(String(outroDuration || DEFAULT_OUTRO_DURATION));
    }
  }, [open, intro, outro, introDuration, outroDuration]);

  if (!open) return null;

  const parseDur = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(60, n) : fallback;
  };

  const handleApply = () => {
    onApply({
      intro: introText,
      outro: outroText,
      introDuration: parseDur(introDur, DEFAULT_INTRO_DURATION),
      outroDuration: parseDur(outroDur, DEFAULT_OUTRO_DURATION),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0B0C]/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[520px] bg-[#16161A] border border-[#26262C] rounded-[16px] shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-[#26262C] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-medium">Интро и аутро</h2>
            <p className="text-[11px] text-[#8A8A93] mt-0.5">Подводка и концовка ролика. Сценарий их не трогает.</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-[6px] bg-[#1E1E23] hover:bg-[#26262C] flex items-center justify-center text-[#8A8A93]">×</button>
        </div>

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-[#8A8A93]">Текст интро</label>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[#8A8A93]">длительность, сек</span>
                <Input
                  type="number"
                  value={introDur}
                  onChange={(e) => setIntroDur(e.target.value)}
                  min={0} max={60} step={0.5}
                  className="w-20 h-7 bg-[#0B0B0C] border-[#26262C] text-xs"
                />
              </div>
            </div>
            <textarea
              value={introText}
              onChange={(e) => setIntroText(e.target.value)}
              rows={3}
              placeholder="Например: Добро пожаловать в новый разбор манги…"
              className="w-full rounded-[8px] bg-[#0B0B0C] border border-[#26262C] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#5A5A63] resize-y"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[12px] text-[#8A8A93]">Текст аутро</label>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[#8A8A93]">длительность, сек</span>
                <Input
                  type="number"
                  value={outroDur}
                  onChange={(e) => setOutroDur(e.target.value)}
                  min={0} max={60} step={0.5}
                  className="w-20 h-7 bg-[#0B0B0C] border-[#26262C] text-xs"
                />
              </div>
            </div>
            <textarea
              value={outroText}
              onChange={(e) => setOutroText(e.target.value)}
              rows={3}
              placeholder="Например: Спасибо за просмотр, подпишитесь…"
              className="w-full rounded-[8px] bg-[#0B0B0C] border border-[#26262C] px-3 py-2 text-[13px] text-[#F5F5F7] placeholder:text-[#5A5A63] resize-y"
            />
          </div>

          <p className="text-[11px] leading-4 text-[#8A8A93]">
            «Сгенерировать AI» пишет оба текста по панелям проекта (нужен ключ LLM).
            «Озвучить» сохранит интро/аутро в OPFS — в превью они проигрываются перед первой
            и после последней панели, в SRT появятся как отдельные сегменты.
          </p>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-[#26262C]">
            <Button variant="outline" size="sm" onClick={onGenerateAI} disabled={generating || voicing} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
              {generating ? 'Генерация…' : 'Сгенерировать AI'}
            </Button>
            <Button variant="outline" size="sm" onClick={onVoice} disabled={generating || voicing} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
              {voicing ? 'Озвучка…' : 'Озвучить интро/аутро'}
            </Button>
            <Button variant="outline" size="sm" onClick={onClear} disabled={generating || voicing} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
              Очистить
            </Button>
            <Button size="sm" onClick={handleApply} disabled={generating || voicing} className="ml-auto h-8 text-xs bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E]">
              Применить
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
