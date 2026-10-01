"use client";

import { useEffect, useState } from 'react';
import { Character } from '@/lib/storage/db';
import { TTS_PROVIDERS, Voice, getTTSProvider } from '@/lib/providers/tts';
import { getAllKeys } from '@/lib/storage/local';
import { Button } from '@/components/ui/button';
import { normalizeCharactersWithMap } from '@/lib/validators';
import { CORS_BLOCKED_PROVIDERS, getAudioMimeType } from '@/lib/providers/tts/cors';

interface VoicesModalProps {
  open: boolean;
  onClose: () => void;
  characters: Character[];
  assignments: Record<string, string>;
  onChange: (assignments: Record<string, string>) => void;
  onCharactersChange?: (chars: Character[]) => void;
  onPanelsRename?: (renameMap: Record<string, string>) => void;
}

export function VoicesModal({ open, onClose, characters, assignments, onChange, onCharactersChange, onPanelsRename }: VoicesModalProps) {
  const [voicesByProvider, setVoicesByProvider] = useState<Record<string, Voice[]>>({});
  const [selectedProvider, setSelectedProvider] = useState('gemini');
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      const keys = getAllKeys();
      const map: Record<string, Voice[]> = {};
      for (const p of TTS_PROVIDERS) {
        try {
          map[p.id] = await p.getVoices(keys[p.id] || '');
        } catch {
          map[p.id] = [];
        }
      }
      setVoicesByProvider(map);
    };
    load();
  }, [open]);

  const handleMerge = () => {
    const { merged: normalized, renameMap } = normalizeCharactersWithMap(characters.map(c => ({ name: c.name, appearance: c.appearance })));
    if (normalized.length < characters.length) {
      const newChars = normalized.map(n => ({
        name: n.name,
        appearance: n.appearance,
        voiceId: assignments[n.name] || n.aliases.map((a: string) => assignments[a]).find(Boolean) || '',
        emotion: 'neutral'
      }));
      onCharactersChange?.(newChars as any);
      const newAssignments: Record<string, string> = {};
      for (const n of normalized) {
        const existingVoice = assignments[n.name] || n.aliases.map((a: string) => assignments[a]).find(Boolean) || '';
        newAssignments[n.name] = existingVoice;
      }
      onChange(newAssignments);
      onPanelsRename?.(renameMap);
    } else {
      alert(`Уже оптимально: ${normalized.length} персонажей`);
    }
  };

  const handlePreview = async (voiceId: string) => {
    const keys = getAllKeys();
    const apiKey = keys[selectedProvider];
    if (!apiKey) {
      alert(`Добавь ключ для ${selectedProvider} в Провайдерах (/settings)`);
      return;
    }
    setLoadingPreview(voiceId);
    try {
      let blob: Blob;
      if (CORS_BLOCKED_PROVIDERS.has(selectedProvider)) {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            providerId: selectedProvider,
            text: 'Привет! Это тест голоса для манги.',
            voice: voiceId,
            apiKey,
            language: 'ru'
          })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `Ошибка ${res.status}`);
        }
        blob = await res.blob();
        const correctMime = getAudioMimeType(selectedProvider, blob.type);
        if (blob.type !== correctMime) {
          blob = new Blob([blob], { type: correctMime });
        }
      } else {
        const provider = getTTSProvider(selectedProvider);
        if (!provider) throw new Error('Provider not found');
        const buf = await provider.generate('Привет! Это тест голоса для манги.', { apiKey, voice: voiceId, language: 'ru' });
        blob = new Blob([buf], { type: getAudioMimeType(selectedProvider) });
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      audio.onerror = () => URL.revokeObjectURL(url);
      await audio.play().catch(() => {
        const a = document.createElement('audio');
        a.src = url;
        a.controls = true;
        a.autoplay = true;
        const container = document.getElementById('voice-preview-container');
        if (container) {
          container.classList.remove('hidden');
          container.innerHTML = '';
          container.appendChild(a);
        }
      });
    } catch (e: any) {
      alert(`Ошибка превью: ${e.message}`);
    } finally {
      setLoadingPreview(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0B0C]/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[480px] bg-[#16161A] border border-[#26262C] rounded-[16px] shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-[#26262C] flex items-center justify-between">
          <h2 className="text-[15px] font-medium">Персонажи и голоса</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-[6px] bg-[#1E1E23] hover:bg-[#26262C] flex items-center justify-center text-[#8A8A93]">×</button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div id="voice-preview-container" className="hidden p-2 rounded-[10px] bg-[#0B0B0C] border border-[#26262C]"></div>
          <div className="flex gap-2">
            <select value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)} className="flex h-8 w-full rounded-[6px] border border-[#26262C] bg-[#0B0B0C] px-2 text-xs">
              {TTS_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name} {p.freeTier ? 'FREE' : ''}</option>)}
            </select>
            <Button variant="outline" size="sm" onClick={handleMerge} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] whitespace-nowrap">
              Объединить
            </Button>
          </div>

          {characters.length === 0 ? (
            <p className="text-xs text-[#8A8A93] text-center py-8">Персонажи появятся после анализа изображений</p>
          ) : (
            <div className="space-y-3">
              {characters.map((char) => {
                const voices = voicesByProvider[selectedProvider] || [];
                const assigned = assignments[char.name] || '';
                return (
                  <div key={char.name} className="p-3 rounded-[10px] bg-[#0B0B0C] border border-[#26262C] space-y-2">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-[#E8B44C] text-[#0B0B0C] flex items-center justify-center text-xs font-medium">
                        {char.name[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium truncate">{char.name}</p>
                        <p className="text-[11px] text-[#8A8A93] truncate">{char.appearance || 'Персонаж'}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <select value={assigned} onChange={(e) => onChange({ ...assignments, [char.name]: e.target.value })} className="flex h-8 w-full rounded-[6px] border border-[#26262C] bg-[#16161A] px-2 text-xs">
                        <option value="">Выбери голос...</option>
                        {voices.map(v => <option key={v.id} value={v.id}>{v.name} · {v.gender}</option>)}
                      </select>
                      {assigned && (
                        <Button variant="ghost" size="sm" onClick={() => handlePreview(assigned)} disabled={loadingPreview === assigned} className="h-8 w-8 p-0 shrink-0">
                          {loadingPreview === assigned ? '...' : '▶'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
