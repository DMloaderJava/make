"use client";

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Sparkles, Clock, Type } from 'lucide-react';

interface IntroOutroEditorProps {
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  onChange: (field: 'intro' | 'outro' | 'introDuration' | 'outroDuration', value: string | number) => void;
  onGenerateIntro?: () => Promise<void>;
  onGenerateOutro?: () => Promise<void>;
  generating?: boolean;
}

export function IntroOutroEditor({ intro, outro, introDuration, outroDuration, onChange, onGenerateIntro, onGenerateOutro, generating }: IntroOutroEditorProps) {
  return (
    <div className="space-y-4">
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Type className="w-4 h-4" />
            Интро и Аутро
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-indigo-400" />
                Интро (30+ сек, живое, не шаблонное)
              </Label>
              <div className="flex items-center gap-2">
                <Clock className="w-3 h-3 text-zinc-500" />
                <Input
                  type="number"
                  value={introDuration}
                  onChange={(e) => onChange('introDuration', Number(e.target.value))}
                  className="w-16 h-6 text-xs"
                  min={0}
                  max={30}
                />
                <span className="text-[11px] text-zinc-500">сек</span>
              </div>
            </div>
            
            <Textarea
              value={intro}
              onChange={(e) => onChange('intro', e.target.value)}
              placeholder="Вы когда-нибудь задумывались, что происходит за секунду до того, как герой принимает судьбоносное решение?..."
              className="min-h-[100px] text-sm"
            />
            
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-500">
                ~{Math.ceil(intro.length / 14)} сек озвучки • {intro.split(' ').length} слов
              </span>
              {onGenerateIntro && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGenerateIntro} disabled={generating}>
                  <Sparkles className="w-3 h-3 mr-1" />
                  {generating ? 'Генерация...' : 'Сгенерировать интро'}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Аутро (CTA, подписка)</Label>
              <div className="flex items-center gap-2">
                <Clock className="w-3 h-3 text-zinc-500" />
                <Input
                  type="number"
                  value={outroDuration}
                  onChange={(e) => onChange('outroDuration', Number(e.target.value))}
                  className="w-16 h-6 text-xs"
                  min={0}
                  max={20}
                />
                <span className="text-[11px] text-zinc-500">сек</span>
              </div>
            </div>
            
            <Textarea
              value={outro}
              onChange={(e) => onChange('outro', e.target.value)}
              placeholder="Спасибо, что досмотрели! Больше такого контента — в шапке профиля..."
              className="min-h-[80px] text-sm"
            />
            
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-500">
                ~{Math.ceil(outro.length / 14)} сек • {outro.split(' ').length} слов
              </span>
              {onGenerateOutro && (
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onGenerateOutro} disabled={generating}>
                  <Sparkles className="w-3 h-3 mr-1" />
                  {generating ? 'Генерация...' : 'Сгенерировать аутро'}
                </Button>
              )}
            </div>
          </div>

          <div className="bg-zinc-800/50 p-3 rounded-lg space-y-1.5">
            <p className="text-[11px] font-medium text-zinc-300">💡 Советы для интро:</p>
            <ul className="text-[11px] text-zinc-500 space-y-0.5 list-disc list-inside">
              <li>Не используй "Привет, друзья!" — начни с вопроса или факта</li>
              <li>Минимум 30 сек (75-90 слов), живой стиль</li>
              <li>Без спойлеров, с интригой и переходом: "Сейчас вы увидите..."</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
