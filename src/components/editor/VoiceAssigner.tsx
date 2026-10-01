"use client";

import { useEffect, useState } from 'react';
import { Character } from '@/lib/storage/db';
import { TTS_PROVIDERS, getTTSProvider, Voice } from '@/lib/providers/tts';
import { getAllKeys } from '@/lib/storage/local';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Play, User, Volume2, Mic } from 'lucide-react';
import { CORS_BLOCKED_PROVIDERS, getAudioMimeType } from '@/lib/providers/tts/cors';

interface VoiceAssignerProps {
  characters: Character[];
  assignments: Record<string, string>;
  onChange: (assignments: Record<string, string>) => void;
  onCharacterUpdate?: (characters: Character[]) => void;
}

export function VoiceAssigner({ characters, assignments, onChange, onCharacterUpdate }: VoiceAssignerProps) {
  const [voicesByProvider, setVoicesByProvider] = useState<Record<string, Voice[]>>({});
  const [selectedProvider, setSelectedProvider] = useState<string>('gemini');
  const [previewAudio, setPreviewAudio] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<string | null>(null);

  useEffect(() => {
    const loadVoices = async () => {
      const keys = getAllKeys();
      const all: Record<string, Voice[]> = {};
      
      for (const provider of TTS_PROVIDERS) {
        try {
          const apiKey = keys[provider.id] || '';
          const voices = await provider.getVoices(apiKey);
          all[provider.id] = voices;
        } catch {
          all[provider.id] = [];
        }
      }
      setVoicesByProvider(all);
    };
    loadVoices();
  }, []);

  const handleAssign = (characterName: string, voiceId: string) => {
    const newAssignments = { ...assignments, [characterName]: voiceId };
    onChange(newAssignments);
  };

  const handlePreview = async (voiceId: string, providerId: string) => {
    const keys = getAllKeys();
    const apiKey = keys[providerId];
    if (!apiKey) {
      alert(`Добавь API-ключ для ${providerId} в настройках`);
      return;
    }
    setLoadingPreview(voiceId);
    try {
      let blob: Blob;
      if (CORS_BLOCKED_PROVIDERS.has(providerId)) {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId, text: 'Привет! Это тест моего голоса для озвучки манги.', voice: voiceId, apiKey, language: 'ru' })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || `Ошибка ${res.status}`);
        }
        blob = await res.blob();
        const correctMime = getAudioMimeType(providerId, blob.type);
        if (blob.type !== correctMime) {
          blob = new Blob([blob], { type: correctMime });
        }
      } else {
        const provider = getTTSProvider(providerId);
        if (!provider) throw new Error('Provider not found');
        const buffer = await provider.generate('Привет! Это тест моего голоса для озвучки манги.', { apiKey, voice: voiceId, language: 'ru' });
        blob = new Blob([buffer], { type: getAudioMimeType(providerId) });
      }
      const url = URL.createObjectURL(blob);
      setPreviewAudio(url);
      const audio = new Audio(url);
      audio.play();
      audio.onended = () => URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Ошибка превью: ${e.message}`);
    } finally {
      setLoadingPreview(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Mic className="w-4 h-4" />
            Назначение голосов
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs">TTS Провайдер</Label>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="flex h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-sm"
            >
              {TTS_PROVIDERS.map(p => (
                <option key={p.id} value={p.id}>{p.name} {p.freeTier ? '(FREE)' : ''}</option>
              ))}
            </select>
          </div>

          {characters.length === 0 ? (
            <div className="text-xs text-zinc-500 text-center py-8">
              Персонажи появятся после анализа изображений
            </div>
          ) : (
            <div className="space-y-3">
              {characters.map((char) => {
                const voices = voicesByProvider[selectedProvider] || [];
                const assignedVoice = assignments[char.name] || '';
                
                return (
                  <div key={char.name} className="p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">
                        {char.name[0]?.toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{char.name}</p>
                        <p className="text-[11px] text-zinc-500 truncate">{char.appearance || 'Персонаж'}</p>
                      </div>
                    </div>
                    
                    <select
                      value={assignedVoice}
                      onChange={(e) => handleAssign(char.name, e.target.value)}
                      className="flex h-8 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
                    >
                      <option value="">Выбери голос...</option>
                      {voices.map(v => (
                        <option key={v.id} value={v.id}>
                          {v.name} — {v.gender} • {v.language}
                        </option>
                      ))}
                    </select>

                    {assignedVoice && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full h-7 text-xs"
                        onClick={() => handlePreview(assignedVoice, selectedProvider)}
                        disabled={loadingPreview === assignedVoice}
                      >
                        <Volume2 className="w-3 h-3 mr-1" />
                        {loadingPreview === assignedVoice ? 'Генерация...' : 'Тест голоса'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className="pt-2 border-t border-zinc-800">
            <p className="text-[11px] text-zinc-500">
              💡 Совет: Для русского языка лучшие — <span className="text-indigo-400">Gemini TTS (Puck, Kore)</span> и <span className="text-emerald-400">ElevenLabs Multilingual v2</span>
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
