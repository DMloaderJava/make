'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  formatRangeNum,
  genderLabel,
  parseScenario,
  SCENARIO_EXAMPLE,
  SCENARIO_GAP_SECONDS,
  SCENARIO_IMAGE_LABEL,
  type ScenarioLine,
} from '@/lib/pipeline/scenario';
import { targetLanguageName } from '@/lib/pipeline/translateScenario';
import { LLM_PROVIDERS } from '@/lib/providers/llm';
import type { Project } from '@/lib/storage/db';

interface ScenarioModalProps {
  open: boolean;
  onClose: () => void;
  /** Сколько изображений загружено в проекте (для предупреждений). */
  imagesCount: number;
  /** Сколько панелей уже есть в проекте (>0 — применение требует подтверждения). */
  existingPanels: number;
  /** Код языка озвучки проекта (ru/en/...) — на него переводятся реплики. */
  ttsLanguage: string;
  /** Сценарий текущего проекта в текстовом формате — модалка открывается с ним. */
  currentScenario: string;
  /** Провайдер, которым переводятся реплики (для списка моделей). */
  llmProviderId: string;
  /** Выбранная модель перевода (пусто — дефолт провайдера). */
  chatModel?: string;
  onSettingsChange?: (patch: Partial<Project['settings']>) => void;
  /** Применить разобранный сценарий; translatedTexts — уже переведённые реплики (null — без перевода); notice — текст для баннера. */
  onApply: (lines: ScenarioLine[], translatedTexts: string[] | null, notice?: string) => Promise<void> | void;
  /** Перевести реплики на язык озвучки. Бросает ошибку, если провайдер/ключ недоступны. */
  onTranslate: (texts: string[]) => Promise<string[]>;
}

/**
 * Сценарий — текстовый формат озвучки:
 *
 *   Изображение 1
 *
 *   Персонаж 1 (Жен.): текст реплики
 *
 *   Изображение 2
 *
 *   Персонаж 2 (Муж.): текст реплики
 *
 * Правила: 1) сначала изображение, затем озвучка; 2) реплики переводятся на
 * язык озвучки; 3) после реплики — пауза 0,6 с и переход к следующему
 * изображению; 4) пол в скобках: (Жен.) или (Муж.); 5) без лишнего текста.
 */
export function ScenarioModal({ open, onClose, imagesCount, existingPanels, ttsLanguage, currentScenario, llmProviderId, chatModel, onSettingsChange, onApply, onTranslate }: ScenarioModalProps) {
  const [text, setText] = useState('');
  const [applying, setApplying] = useState(false);
  const [translating, setTranslating] = useState(false);
  // Подтверждение замены существующих панелей: явный чекбокс, а не confirm() —
  // во встроенном превью (iframe без allow-modals) confirm молча вернёт false.
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const needsReplaceConfirm = existingPanels > 0 && !replaceConfirmed;

  const parsed = useMemo(() => (text.trim() ? parseScenario(text) : null), [text]);
  const canApply = !!parsed && parsed.lines.length > 0 && parsed.errors.length === 0;
  const languageName = targetLanguageName(ttsLanguage);
  const llmProvider = LLM_PROVIDERS.find(p => p.id === llmProviderId);
  // Модели каталога — строки, но нормализуем defensively: если когда-нибудь
  // станут объектами {id, name}, в DOM не уедет [object Object].
  const modelOptions: Array<{ id: string; label: string }> = (llmProvider?.models || [])
    .map((m: unknown) => {
      if (typeof m === 'string') return { id: m, label: m };
      const obj = m as { id?: string; name?: string; label?: string };
      const id = obj.id || obj.name || '';
      return { id, label: obj.label || obj.name || obj.id || '' };
    })
    .filter(m => m.id);

  // Модалка открывается с текстом текущего проекта (обратная связь
  // «проект → сценарий»): сериализация из панелей, а не пустое поле.
  useEffect(() => {
    if (open) {
      setText(currentScenario);
      setReplaceConfirmed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleApply = async () => {
    if (!canApply || !parsed) return;
    if (needsReplaceConfirm) return; // защита: кнопка и так disabled
    if (imagesCount === 0) return; // защита: кнопка disabled, пояснение над ней
    setApplying(true);
    try {
      // Правило 2: реплики переводятся на язык озвучки. Если LLM недоступна —
      // не блокируем dialog'ом (в встроенном превью он может быть запрещён),
      // а применяем без перевода и показываем причину баннером в редакторе.
      let translated: string[] | null = null;
      let notice: string | undefined;
      setTranslating(true);
      try {
        translated = await onTranslate(parsed.lines.map(l => l.text));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notice = `Перевод на ${languageName} не выполнен: ${message}\nСценарий применён без перевода — реплики можно отредактировать в панели ниже таймлайна.`;
      } finally {
        setTranslating(false);
      }
      await onApply(parsed.lines, translated, notice);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#0B0B0C]/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-[600px] bg-[#16161A] border border-[#26262C] rounded-[16px] shadow-2xl overflow-hidden">
        <div className="p-5 border-b border-[#26262C] flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-medium">Сценарий</h2>
            <p className="text-[11px] text-[#8A8A93] mt-0.5">
              Сначала изображение, затем реплика · пауза между репликами — ползунок в таймлайне
            </p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-[6px] bg-[#1E1E23] hover:bg-[#26262C] flex items-center justify-center text-[#8A8A93]">×</button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <details className="rounded-[10px] bg-[#0B0B0C] border border-[#26262C] px-4 py-3">
            <summary className="cursor-pointer text-[12px] text-[#A1A1AA] select-none">Формат и правила</summary>
            <div className="mt-3 space-y-3">
              <pre className="text-[11px] leading-5 font-mono text-[#F5F5F7] whitespace-pre-wrap">{SCENARIO_EXAMPLE}</pre>
              <ol className="text-[11px] leading-5 text-[#8A8A93] list-decimal list-inside space-y-0.5">
                <li>Сначала загружается изображение, затем озвучивается диалог.</li>
                <li>Каждая реплика переводится на язык озвучки: <span className="text-[#E8B44C]">{languageName}</span>.</li>
                <li>После завершения чтения реплики — переход к следующему изображению через {String(SCENARIO_GAP_SECONDS).replace('.', ',')} секунды.</li>
                <li>Пол персонажа указывается в скобках: (Жен.) или (Муж.).</li>
                <li>Никакого лишнего текста — только «{SCENARIO_IMAGE_LABEL} N» и реплики.</li>
                <li>
                  <span className="text-[#F5F5F7]">Y-диапазон (опционально).</span>{' '}
                  <span className="font-mono text-[#E8B44C]">{SCENARIO_IMAGE_LABEL} 1 [0..30%]</span> — панель занимает верхние 30% картинки.
                  Если не указан — вся картинка = одна панель (лента не скроллится). Для длинных webtoon-полос указывайте
                  диапазоны — тогда лента едет по панелям и совпадает с озвучкой.
                </li>
              </ol>
              <p className="text-[11px] leading-5 text-[#8A8A93]">
                При применении: интро и аутро сохраняются, пол используется для автоподбора голоса
                {imagesCount > 0 ? `; изображений в проекте: ${imagesCount}` : ''}.
              </p>
            </div>
          </details>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={`Вставьте сценарий в формате:\n\n${SCENARIO_EXAMPLE.slice(0, SCENARIO_EXAMPLE.indexOf('\n\n\n'))}...`}
            className="w-full min-h-[180px] max-h-[300px] rounded-[10px] bg-[#0B0B0C] border border-[#26262C] px-3 py-2.5 font-mono text-[12px] leading-5 text-[#F5F5F7] placeholder:text-[#8A8A93]/50 resize-y"
          />

          {modelOptions.length > 0 && (
            <div className="flex items-center gap-3">
              <label className="text-[11px] text-[#8A8A93] whitespace-nowrap" htmlFor="scenario-chat-model">
                Модель перевода
              </label>
              <select
                id="scenario-chat-model"
                value={chatModel || ''}
                onChange={(e) => onSettingsChange?.({ chatModel: e.target.value || undefined })}
                className="flex h-8 w-full max-w-[320px] rounded-[6px] border border-[#26262C] bg-[#0B0B0C] px-2 text-xs"
              >
                <option value="">{llmProvider?.name || 'Провайдер'} · по умолчанию</option>
                {modelOptions.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          )}

          {existingPanels > 0 && (
            <label className="flex items-start gap-2 rounded-[8px] border border-[#3A2E14] bg-[#1E1A10] px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={replaceConfirmed}
                onChange={(e) => setReplaceConfirmed(e.target.checked)}
                className="mt-0.5 accent-[#E8B44C]"
              />
              <span className="text-[11px] leading-4 text-[#C9B27A]">
                В проекте уже {existingPanels} {existingPanels === 1 ? 'панель' : 'панелей'} — они будут заменены сценарием целиком (вместе с озвучкой).
                Отметьте, чтобы подтвердить.
              </span>
            </label>
          )}

          {imagesCount === 0 && (
            <p className="text-[11px] leading-4 text-[#E86C4C]">
              В проекте нет изображений — сценарий применять не к чему. Загрузите хотя бы одно изображение.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setText(SCENARIO_EXAMPLE)} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
              Пример
            </Button>
            <Button variant="outline" size="sm" onClick={() => setText(currentScenario)} disabled={!currentScenario} title="Собрать текст заново из панелей проекта" className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23] disabled:opacity-40">
              ← Из проекта
            </Button>
            {text && (
              <Button variant="outline" size="sm" onClick={() => setText('')} className="h-8 text-xs bg-[#0B0B0C] border-[#26262C] hover:bg-[#1E1E23]">
                Очистить
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => void handleApply()}
              disabled={!canApply || applying || translating || needsReplaceConfirm || imagesCount === 0}
              title={imagesCount === 0 ? 'В проекте нет изображений — сначала загрузите хотя бы одно' : undefined}
              className="ml-auto h-8 text-xs bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E] disabled:opacity-50"
            >
              {translating ? 'Перевод реплик…' : applying ? 'Применение…' : `Применить к проекту${parsed?.lines.length ? ` · ${parsed.lines.length} реплик` : ''}`}
            </Button>
          </div>

          {parsed && (
            parsed.errors.length > 0 ? (
              <div className="space-y-1">
                {parsed.errors.slice(0, 8).map((err, i) => (
                  <p key={i} className="text-[11px] leading-4 text-[#E86C4C]">• {err}</p>
                ))}
                {parsed.errors.length > 8 && (
                  <p className="text-[11px] text-[#C97A66]">…ещё {parsed.errors.length - 8} ошибок</p>
                )}
              </div>
            ) : (
              <div className="rounded-[10px] bg-[#0B0B0C] border border-[#26262C] px-4 py-3 space-y-2">
                <p className="text-[11px] text-[#8A8A93]">
                  Разобрано: <span className="text-[#F5F5F7]">{parsed.lines.length}</span> реплик ·
                  изображения <span className="text-[#F5F5F7]">{new Set(parsed.lines.map(l => l.imageIndex + 1)).size}</span>
                </p>
                {parsed.warnings.slice(0, 4).map((w, i) => (
                  <p key={i} className="text-[11px] leading-4 text-[#C9B27A]">⚠ {w}</p>
                ))}
                <div className="max-h-[160px] overflow-y-auto space-y-1 pr-1">
                  {parsed.lines.map((line, i) => (
                    <div key={i} className="flex items-baseline gap-2 text-[11px] leading-5">
                      <span className="font-mono text-[#8A8A93] shrink-0">{String(i + 1).padStart(2, '0')}</span>
                      <span className="font-mono text-[#E8B44C] shrink-0">
                        {SCENARIO_IMAGE_LABEL} {line.imageIndex + 1}
                        {line.yRange && <span className="text-[#8A8A93]"> [{formatRangeNum(line.yRange.from)}..{formatRangeNum(line.yRange.to)}%]</span>}
                      </span>
                      <span className="truncate">
                        <span className="text-[#F5F5F7]">{line.character}</span>
                        {line.gender && <span className="text-[#8A8A93]"> ({genderLabel(line.gender)})</span>}
                        <span className="text-[#A1A1AA]"> — {line.text}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
