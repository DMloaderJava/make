"use client";

import { PanelData } from '@/lib/pipeline/extractPanels';
import { TTS_PROVIDERS, Voice } from '@/lib/providers/tts';
import { useState, useEffect } from 'react';
import { getAllKeys } from '@/lib/storage/local';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface ContextPanelProps {
  selected: { type: 'panel'; data: PanelData; index: number } | { type: 'intro'; text: string; duration: number } | { type: 'outro'; text: string; duration: number } | null;
  onUpdatePanel: (id: number, updates: Partial<PanelData>) => void;
  onUpdateIntro: (text: string, duration: number) => void;
  onUpdateOutro: (text: string, duration: number) => void;
  voiceAssignments: Record<string, string>;
  onVoiceChange: (character: string, voiceId: string) => void;
  onGenerateIntro?: () => void;
  onGenerateOutro?: () => void;
  generating?: boolean;
  onRegeneratePanel?: (panelId: number) => void;
  regenerating?: boolean;
}

export function ContextPanel({ selected, onUpdatePanel, onUpdateIntro, onUpdateOutro, voiceAssignments, onVoiceChange, onGenerateIntro, onGenerateOutro, generating, onRegeneratePanel, regenerating }: ContextPanelProps) {
  const [voices, setVoices] = useState<Voice[]>([]);

  useEffect(() => {
    const load = async () => {
      const keys = getAllKeys();
      const settings = (() => {
        try {
          const s = localStorage.getItem('mvs-info:settings') || localStorage.getItem('manga-voice-settings');
          return s ? JSON.parse(s) : {};
        } catch { return {}; }
      })();
      const defaultProviderId = settings.defaultTTSProvider || 'gemini';
      try {
        const provider = TTS_PROVIDERS.find(p => p.id === defaultProviderId) || TTS_PROVIDERS.find(p => p.id === 'gemini');
        if (provider) {
          const v = await provider.getVoices(keys[provider.id] || '');
          setVoices(v);
        }
      } catch {
        const provider = TTS_PROVIDERS.find(p => p.id === 'gemini');
        if (provider) {
          const v = await provider.getVoices('');
          setVoices(v);
        }
      }
    };
    load();
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key.includes('manga-voice-settings') || e.key.includes('mvs-info:settings') || e.key.includes('manga-voice-keys') || e.key.includes('mvs-info:keys')) load();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('manga-voice-settings-changed' as any, load);
    window.addEventListener('mvs-info:settings-changed' as any, load);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('manga-voice-settings-changed' as any, load);
      window.removeEventListener('mvs-info:settings-changed' as any, load);
    };
  }, []);

  if (!selected) {
    return (
      <div className="w-full bg-[#16161A] rounded-[10px] border border-[#26262C] p-6 text-center">
        <p className="text-[13px] text-[#8A8A93]">Кликни на сегмент таймлайна чтобы редактировать</p>
        <p className="text-[11px] text-[#8A8A93]/70 mt-1">Интро · Панель · Аутро · Голоса</p>
      </div>
    );
  }

  if (selected.type === 'intro') {
    return (
      <div className="w-full bg-[#16161A] rounded-[10px] border border-[#26262C] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium">Интро · {selected.duration}с</h4>
          <span className="font-mono text-[11px] text-[#8A8A93]">{selected.text.length} симв. · ~{Math.ceil(selected.text.length/14)}с</span>
        </div>
        <Textarea
          value={selected.text}
          onChange={(e) => onUpdateIntro(e.target.value, selected.duration)}
          placeholder="Вы когда-нибудь задумывались..."
          className="min-h-[80px] bg-[#0B0B0C] border-[#26262C] text-[13px]"
        />
        <div className="flex gap-2">
          <Input type="number" value={selected.duration} onChange={(e) => onUpdateIntro(selected.text, Number(e.target.value) || 0)} className="w-20 h-8 bg-[#0B0B0C] border-[#26262C] text-xs" />
          <span className="text-[11px] text-[#8A8A93] self-center">сек</span>
          {onGenerateIntro && (
            <Button variant="outline" size="sm" onClick={onGenerateIntro} disabled={generating} className="ml-auto h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
              {generating ? '...' : '✦ Сгенерировать'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (selected.type === 'outro') {
    return (
      <div className="w-full bg-[#16161A] rounded-[10px] border border-[#26262C] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium">Аутро · {selected.duration}с</h4>
          <span className="font-mono text-[11px] text-[#8A8A93]">{selected.text.length} симв.</span>
        </div>
        <Textarea
          value={selected.text}
          onChange={(e) => onUpdateOutro(e.target.value, selected.duration)}
          placeholder="Спасибо за просмотр..."
          className="min-h-[60px] bg-[#0B0B0C] border-[#26262C] text-[13px]"
        />
        <div className="flex gap-2">
          <Input type="number" value={selected.duration} onChange={(e) => onUpdateOutro(selected.text, Number(e.target.value) || 0)} className="w-20 h-8 bg-[#0B0B0C] border-[#26262C] text-xs" />
          <span className="text-[11px] text-[#8A8A93] self-center">сек</span>
          {onGenerateOutro && (
            <Button variant="outline" size="sm" onClick={onGenerateOutro} disabled={generating} className="ml-auto h-8 text-xs bg-[#0B0B0C] border-[#26262C]">
              {generating ? '...' : '✦ Сгенерировать'}
            </Button>
          )}
        </div>
      </div>
    );
  }

  const panel = selected.data;
  const assignedVoice = voiceAssignments[panel.character] || '';

  return (
    <div className="w-full bg-[#16161A] rounded-[10px] border border-[#26262C] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[13px] font-medium">Панель {selected.index + 1} · {panel.character} · {panel.emotion}</h4>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-[#8A8A93]">{panel.type}</span>
          {onRegeneratePanel && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRegeneratePanel(panel.id)}
              disabled={regenerating}
              title="Удалить кэш аудио панели и озвучить заново (текст/голос будут применены)"
              className="h-7 text-[11px] bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]"
            >
              ↻ Переозвучить
            </Button>
          )}
        </div>
      </div>

      <Textarea
        value={panel.dialogue}
        onChange={(e) => onUpdatePanel(panel.id, { dialogue: e.target.value })}
        className="min-h-[64px] bg-[#0B0B0C] border-[#26262C] text-[13px] leading-relaxed"
        placeholder="Текст реплики..."
      />

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-[#8A8A93]">Персонаж</Label>
          <Input
            value={panel.character}
            onChange={(e) => onUpdatePanel(panel.id, { character: e.target.value })}
            className="h-8 bg-[#0B0B0C] border-[#26262C] text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-[#8A8A93]">Эмоция</Label>
          <select
            value={panel.emotion}
            onChange={(e) => onUpdatePanel(panel.id, { emotion: e.target.value })}
            className="flex h-8 w-full rounded-[6px] border border-[#26262C] bg-[#0B0B0C] px-2 text-xs"
          >
            <option value="neutral">нейтр.</option>
            <option value="happy">радость</option>
            <option value="sad">грусть</option>
            <option value="angry">злость</option>
            <option value="surprised">удивление</option>
            <option value="scared">страх</option>
            <option value="thoughtful">задумч.</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-[#8A8A93]">Голос</Label>
          <select
            value={assignedVoice}
            onChange={(e) => onVoiceChange(panel.character, e.target.value)}
            className="flex h-8 w-full rounded-[6px] border border-[#26262C] bg-[#0B0B0C] px-2 text-xs"
          >
            <option value="">по умолч.</option>
            {voices.map(v => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
