"use client";

import { useEffect, useState, useCallback } from 'react';
import {
  evaluateEnvironment,
  type EnvironmentProbeReport,
} from '@/lib/pipeline/environmentProbe';
import {
  getAllKeys,
  getSettings,
  saveApiKey,
  saveSettings,
  type AppSettings,
} from '@/lib/storage/local';
import { TTS_PROVIDERS, getTTSProvider } from '@/lib/providers/tts';
import { LLM_PROVIDERS, getLLMProvider, resolveLLMVisionModel } from '@/lib/providers/llm';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Loader2, RefreshCw, Sparkles, Upload, X, XCircle } from 'lucide-react';
import Link from 'next/link';

export const ONBOARDING_COMPLETED_KEY = 'onboardingCompleted';

export function isOnboardingCompleted(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markOnboardingCompleted(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(ONBOARDING_COMPLETED_KEY, 'true');
  } catch {}
}

interface OnboardingWizardProps {
  open: boolean;
  onClose: () => void;
  onCreateDemo: () => Promise<void>;
  onUploadImages?: () => void;
}

const STEPS = [
  { id: 'env', title: '1. Окружение' },
  { id: 'tts', title: '2. Озвучка (TTS)' },
  { id: 'llm', title: '3. Анализ (LLM)' },
  { id: 'channel', title: '4. Канал' },
  { id: 'finish', title: '5. Старт' },
] as const;

export function OnboardingWizard({
  open,
  onClose,
  onCreateDemo,
  onUploadImages,
}: OnboardingWizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [envReport, setEnvReport] = useState<EnvironmentProbeReport | null>(null);
  const [envLoading, setEnvLoading] = useState(false);

  const [settings, setSettings] = useState<AppSettings>(() => getSettings());
  const [keys, setKeys] = useState<Record<string, string>>(() => getAllKeys());

  const [ttsProviderId, setTtsProviderId] = useState<string>(() => getSettings().defaultTTSProvider || 'gemini');
  const [ttsKey, setTtsKey] = useState<string>('');
  const [ttsTestState, setTtsTestState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [ttsTestMessage, setTtsTestMessage] = useState<string>('');

  const [llmProviderId, setLlmProviderId] = useState<string>(() => getSettings().defaultLLMProvider || 'openrouter');
  const [llmKey, setLlmKey] = useState<string>('');
  const [llmTestState, setLlmTestState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [llmTestMessage, setLlmTestMessage] = useState<string>('');

  const [channelName, setChannelName] = useState<string>(() => getSettings().channelName || '');
  const [channelTagline, setChannelTagline] = useState<string>(() => getSettings().channelTagline || '');
  const [creatingDemo, setCreatingDemo] = useState(false);

  const runProbe = useCallback(async () => {
    setEnvLoading(true);
    try {
      const report = await evaluateEnvironment();
      setEnvReport(report);
    } finally {
      setEnvLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const loadedSettings = getSettings();
    const loadedKeys = getAllKeys();
    setSettings(loadedSettings);
    setKeys(loadedKeys);
    const initialTts = loadedSettings.defaultTTSProvider || 'gemini';
    const initialLlm = loadedSettings.defaultLLMProvider || 'openrouter';
    setTtsProviderId(initialTts);
    setTtsKey(loadedKeys[initialTts] || '');
    setLlmProviderId(initialLlm);
    setLlmKey(loadedKeys[initialLlm] || '');
    setChannelName(loadedSettings.channelName || '');
    setChannelTagline(loadedSettings.channelTagline || '');
    void runProbe();
  }, [open, runProbe]);

  if (!open) return null;

  const persistCurrentStep = () => {
    const nextSettings: AppSettings = {
      ...settings,
      defaultTTSProvider: ttsProviderId,
      defaultLLMProvider: llmProviderId,
      channelName: channelName.trim(),
      channelTagline: channelTagline.trim(),
    };
    setSettings(nextSettings);
    saveSettings(nextSettings);
    if (ttsKey.trim()) {
      saveApiKey(ttsProviderId, ttsKey.trim());
      setKeys(prev => ({ ...prev, [ttsProviderId]: ttsKey.trim() }));
    }
    if (llmKey.trim()) {
      saveApiKey(llmProviderId, llmKey.trim());
      setKeys(prev => ({ ...prev, [llmProviderId]: llmKey.trim() }));
    }
  };

  const handleCompleteAndClose = () => {
    persistCurrentStep();
    markOnboardingCompleted();
    onClose();
  };

  const handleTestTTS = async () => {
    const trimmedKey = ttsKey.trim();
    if (!trimmedKey) {
      setTtsTestState('error');
      setTtsTestMessage('Введите API-ключ для проверки');
      return;
    }
    saveApiKey(ttsProviderId, trimmedKey);
    setTtsTestState('loading');
    setTtsTestMessage('');
    try {
      const provider = getTTSProvider(ttsProviderId);
      const defaultVoice = 'Puck';
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: ttsProviderId,
          apiKey: trimmedKey,
          text: 'test',
          voiceId: defaultVoice,
        }),
      });
      if (res.ok) {
        setTtsTestState('ok');
        setTtsTestMessage('Ключ подтверждён (тестовый синтез прошёл)');
        return;
      }
      if (provider) {
        const voices = await provider.getVoices(trimmedKey);
        if (voices && voices.length > 0) {
          setTtsTestState('ok');
          setTtsTestMessage(`Ключ подтверждён (доступно голосов: ${voices.length})`);
          return;
        }
      }
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `Ошибка проверки (${res.status})`);
    } catch (e: any) {
      setTtsTestState('error');
      setTtsTestMessage(e?.message?.slice(0, 160) || 'Не удалось проверить ключ');
    }
  };

  const handleTestLLM = async () => {
    const trimmedKey = llmKey.trim();
    if (!trimmedKey) {
      setLlmTestState('error');
      setLlmTestMessage('Введите API-ключ для проверки');
      return;
    }
    saveApiKey(llmProviderId, trimmedKey);
    setLlmTestState('loading');
    setLlmTestMessage('');
    try {
      const provider = getLLMProvider(llmProviderId);
      const model = provider
        ? resolveLLMVisionModel(provider, settings.defaultVisionModel) || provider.defaultModel
        : 'google/gemma-4-31b-it:free';
      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: llmProviderId,
          apiKey: trimmedKey,
          model,
          messages: [{ role: 'user', content: 'test' }],
          maxTokens: 8,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Ошибка проверки (${res.status})`);
      }
      setLlmTestState('ok');
      setLlmTestMessage(`Ключ подтверждён (модель ${model})`);
    } catch (e: any) {
      setLlmTestState('error');
      setLlmTestMessage(e?.message?.slice(0, 160) || 'Не удалось проверить ключ');
    }
  };

  const handleStartDemo = async () => {
    persistCurrentStep();
    markOnboardingCompleted();
    setCreatingDemo(true);
    try {
      await onCreateDemo();
    } finally {
      setCreatingDemo(false);
    }
  };

  const handleStartUpload = () => {
    persistCurrentStep();
    markOnboardingCompleted();
    onClose();
    onUploadImages?.();
  };

  return (
    <div
      data-testid="onboarding-wizard"
      role="dialog"
      aria-modal="true"
      aria-label="Мастер первоначальной настройки Manga Voice Studio"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-[680px] rounded-[14px] bg-[#16161A] border border-[#26262C] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#26262C] flex items-center justify-between bg-[#111115]">
          <div>
            <h2 className="text-[16px] font-semibold text-[#F5F5F7]">
              Мастер настройки Manga Voice Studio
            </h2>
            <p className="text-[12px] text-[#8A8A93]">
              Проверка браузерного окружения, ключей API и быстрый старт проекта
            </p>
          </div>
          <button
            type="button"
            data-testid="onboarding-close-btn"
            onClick={handleCompleteAndClose}
            aria-label="Закрыть мастер настройки"
            className="w-8 h-8 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[#8A8A93] hover:text-[#F5F5F7] flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stepper */}
        <div className="px-5 py-2.5 border-b border-[#26262C] bg-[#0B0B0C] flex flex-wrap gap-1.5">
          {STEPS.map((step, idx) => {
            const active = idx === stepIndex;
            const done = idx < stepIndex;
            return (
              <button
                key={step.id}
                type="button"
                data-testid={`onboarding-tab-${step.id}`}
                onClick={() => {
                  persistCurrentStep();
                  setStepIndex(idx);
                }}
                className={`px-2.5 py-1 rounded-[6px] text-[11px] font-medium transition-colors flex items-center gap-1 ${
                  active
                    ? 'bg-[#E8B44C] text-[#0B0B0C]'
                    : done
                      ? 'bg-[#1E1E23] text-[#F5F5F7] border border-[#26262C]'
                      : 'bg-[#16161A] text-[#8A8A93] hover:text-[#F5F5F7]'
                }`}
              >
                {done && <Check className="w-3 h-3 text-[#4ADE80]" />}
                <span>{step.title}</span>
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 min-h-0 overscroll-contain">
          {stepIndex === 0 && (
            <div data-testid="onboarding-step-env" className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[14px] font-medium text-[#F5F5F7]">
                    Шаг 1. Диагностика браузерного окружения
                  </h3>
                  <p className="text-[12px] text-[#8A8A93]">
                    Аналог <code className="font-mono text-[#E8B44C]">npm run setup</code> прямо в браузере (OPFS, IndexedDB, WebCodecs, MediaRecorder, Chromium)
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="onboarding-reprobe-btn"
                  onClick={runProbe}
                  disabled={envLoading}
                  className="h-8 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[12px] text-[#F5F5F7] hover:bg-[#26262C] flex items-center gap-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${envLoading ? 'animate-spin' : ''}`} />
                  <span>Проверить снова</span>
                </button>
              </div>

              <div className="space-y-2">
                {envReport ? (
                  envReport.items.map((item) => (
                    <div
                      key={item.id}
                      data-testid="env-check-item"
                      data-check-id={item.id}
                      data-check-status={item.status}
                      className="p-3 rounded-[8px] bg-[#0B0B0C] border border-[#26262C] flex items-start gap-3"
                    >
                      <span
                        className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${
                          item.status === 'ok'
                            ? 'bg-green-900/40 text-[#4ADE80] border border-green-700/60'
                            : item.status === 'warn'
                              ? 'bg-yellow-900/40 text-[#E8B44C] border border-yellow-700/60'
                              : 'bg-red-900/40 text-[#F87171] border border-red-700/60'
                        }`}
                      >
                        <span className="sr-only">{item.icon}</span>
                        {item.status === 'ok' ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : item.status === 'warn' ? (
                          <AlertTriangle className="w-3.5 h-3.5" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-medium text-[#F5F5F7]">
                            {item.label}
                          </span>
                          <span
                            className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                              item.status === 'ok'
                                ? 'bg-green-900/30 text-green-300 border border-green-800/50'
                                : item.status === 'warn'
                                  ? 'bg-yellow-900/30 text-yellow-300 border border-yellow-800/50'
                                  : 'bg-red-900/30 text-red-300 border border-red-800/50'
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>
                        <p className="text-[12px] text-[#8A8A93] mt-0.5">{item.detail}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="p-6 text-center text-[12px] text-[#8A8A93]">
                    Проверка возможностей браузера...
                  </div>
                )}
              </div>
            </div>
          )}

          {stepIndex === 1 && (
            <div data-testid="onboarding-step-tts" className="space-y-4">
              <div>
                <h3 className="text-[14px] font-medium text-[#F5F5F7]">
                  Шаг 2. Провайдер озвучки (TTS)
                </h3>
                <p className="text-[12px] text-[#8A8A93]">
                  Выберите TTS-провайдера по умолчанию и при наличии укажите API-ключ (можно пропустить и использовать импорт готовых WAV/MP3 или демо-проект).
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[12px] text-[#8A8A93]">TTS-провайдер</label>
                <select
                  data-testid="onboarding-tts-select"
                  value={ttsProviderId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setTtsProviderId(nextId);
                    setTtsKey(keys[nextId] || '');
                    setTtsTestState('idle');
                    setTtsTestMessage('');
                  }}
                  className="w-full h-9 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
                >
                  {TTS_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.freeTier ? '(Free tier)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[12px] text-[#8A8A93]">API-ключ ({ttsProviderId})</label>
                <div className="flex gap-2">
                  <input
                    data-testid="onboarding-tts-key-input"
                    type="password"
                    value={ttsKey}
                    onChange={(e) => setTtsKey(e.target.value)}
                    placeholder="Вставьте API-ключ или оставьте пустым для работы без TTS"
                    className="flex-1 h-9 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
                  />
                  <button
                    type="button"
                    data-testid="onboarding-test-tts-btn"
                    onClick={handleTestTTS}
                    disabled={ttsTestState === 'loading'}
                    className="h-9 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[12px] text-[#F5F5F7] hover:bg-[#26262C] flex items-center gap-1.5 shrink-0"
                  >
                    {ttsTestState === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Проверить ключ</span>
                  </button>
                </div>
                {ttsTestMessage && (
                  <p
                    data-testid="onboarding-tts-test-result"
                    className={`text-[12px] ${
                      ttsTestState === 'ok' ? 'text-[#4ADE80]' : 'text-[#F87171]'
                    }`}
                  >
                    {ttsTestMessage}
                  </p>
                )}
              </div>
            </div>
          )}

          {stepIndex === 2 && (
            <div data-testid="onboarding-step-llm" className="space-y-4">
              <div>
                <h3 className="text-[14px] font-medium text-[#F5F5F7]">
                  Шаг 3. Провайдер анализа страниц (Vision LLM)
                </h3>
                <p className="text-[12px] text-[#8A8A93]">
                  Используется для автоматического распознавания панелей и генерации SEO-описания. Без ключа можно размечать панели вручную через текстовый сценарий.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[12px] text-[#8A8A93]">LLM-провайдер</label>
                <select
                  data-testid="onboarding-llm-select"
                  value={llmProviderId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setLlmProviderId(nextId);
                    setLlmKey(keys[nextId] || '');
                    setLlmTestState('idle');
                    setLlmTestMessage('');
                  }}
                  className="w-full h-9 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
                >
                  {LLM_PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.freeTier ? '(Free)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[12px] text-[#8A8A93]">API-ключ ({llmProviderId})</label>
                <div className="flex gap-2">
                  <input
                    data-testid="onboarding-llm-key-input"
                    type="password"
                    value={llmKey}
                    onChange={(e) => setLlmKey(e.target.value)}
                    placeholder="Вставьте API-ключ или оставьте пустым для ручного сценария"
                    className="flex-1 h-9 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
                  />
                  <button
                    type="button"
                    data-testid="onboarding-test-llm-btn"
                    onClick={handleTestLLM}
                    disabled={llmTestState === 'loading'}
                    className="h-9 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[12px] text-[#F5F5F7] hover:bg-[#26262C] flex items-center gap-1.5 shrink-0"
                  >
                    {llmTestState === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Проверить ключ</span>
                  </button>
                </div>
                {llmTestMessage && (
                  <p
                    data-testid="onboarding-llm-test-result"
                    className={`text-[12px] ${
                      llmTestState === 'ok' ? 'text-[#4ADE80]' : 'text-[#F87171]'
                    }`}
                  >
                    {llmTestMessage}
                  </p>
                )}
              </div>
            </div>
          )}

          {stepIndex === 3 && (
            <div data-testid="onboarding-step-channel" className="space-y-4">
              <div>
                <h3 className="text-[14px] font-medium text-[#F5F5F7]">
                  Шаг 4. Брендинг канала (Интро / Аутро)
                </h3>
                <p className="text-[12px] text-[#8A8A93]">
                  Название и подпись канала автоматически подставляются на экранах интро и аутро при рендере видео.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[12px] text-[#8A8A93]">Название канала</label>
                <input
                  data-testid="onboarding-channel-name"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  placeholder="Например: Manga Voice RU"
                  className="w-full h-9 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
                />
              </div>

              <div className="space-y-2">
                <label className="text-[12px] text-[#8A8A93]">Подпись канала (слоган)</label>
                <input
                  data-testid="onboarding-channel-tagline"
                  value={channelTagline}
                  onChange={(e) => setChannelTagline(e.target.value)}
                  placeholder="Например: Озвученные главы манги каждый день"
                  className="w-full h-9 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
                />
              </div>
            </div>
          )}

          {stepIndex === 4 && (
            <div data-testid="onboarding-step-finish" className="space-y-4">
              <div>
                <h3 className="text-[14px] font-medium text-[#F5F5F7]">
                  Шаг 5. Создание первого проекта
                </h3>
                <p className="text-[12px] text-[#8A8A93]">
                  Вы можете сразу открыть предзаполненный демо-проект (2 панели, сценарий, интро/аутро и тестовый звук без расхода API-ключей) или перейти к загрузке собственных изображений.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <button
                  type="button"
                  data-testid="onboarding-create-demo-btn"
                  onClick={handleStartDemo}
                  disabled={creatingDemo}
                  className="p-4 rounded-[10px] bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#f0c15c] transition-colors text-left space-y-1.5 flex flex-col justify-between"
                >
                  <div className="flex items-center gap-2 font-semibold text-[14px]">
                    {creatingDemo ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Sparkles className="w-4 h-4" />
                    )}
                    <span>Создать демо-проект</span>
                  </div>
                  <p className="text-[12px] text-[#0B0B0C]/80">
                    2 панели, готовый сценарий, интро/аутро и демо-озвучка — откроется сразу в редакторе
                  </p>
                </button>

                <button
                  type="button"
                  data-testid="onboarding-upload-images-btn"
                  onClick={handleStartUpload}
                  className="p-4 rounded-[10px] bg-[#0B0B0C] border border-[#26262C] hover:border-[#E8B44C] text-[#F5F5F7] transition-colors text-left space-y-1.5 flex flex-col justify-between"
                >
                  <div className="flex items-center gap-2 font-semibold text-[14px]">
                    <Upload className="w-4 h-4 text-[#E8B44C]" />
                    <span>Загрузить изображения</span>
                  </div>
                  <p className="text-[12px] text-[#8A8A93]">
                    Перейти на главную страницу для загрузки страниц манги или импорта архива проекта
                  </p>
                </button>
              </div>

              <div className="p-3 rounded-[8px] bg-[#0B0B0C] border border-[#26262C] text-[12px] text-[#8A8A93] space-y-1">
                <div className="font-medium text-[#F5F5F7]">Полезные материалы и диагностика:</div>
                <p>
                  • Полное описание возможностей и горячих клавиш: <code className="font-mono text-[#E8B44C]">README.md</code>
                </p>
                <p>
                  • Документированные ограничения окружения (L-1..L-15): <code className="font-mono text-[#E8B44C]">known-limits.md</code>
                </p>
                <p>
                  • Расширенные настройки всех TTS/LLM-провайдеров:{' '}
                  <Link href="/settings" onClick={handleCompleteAndClose} className="text-[#E8B44C] underline">
                    открыть страницу «Провайдеры»
                  </Link>
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-[#26262C] bg-[#111115] flex items-center justify-between">
          <button
            type="button"
            data-testid="onboarding-prev-btn"
            onClick={() => {
              persistCurrentStep();
              setStepIndex((i) => Math.max(0, i - 1));
            }}
            disabled={stepIndex === 0}
            className="h-8 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[12px] text-[#F5F5F7] disabled:opacity-40 flex items-center gap-1"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Назад</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="onboarding-skip-btn"
              onClick={handleCompleteAndClose}
              className="h-8 px-3 rounded-[6px] text-[12px] text-[#8A8A93] hover:text-[#F5F5F7]"
            >
              Пропустить
            </button>
            {stepIndex < STEPS.length - 1 ? (
              <button
                type="button"
                data-testid="onboarding-next-btn"
                onClick={() => {
                  persistCurrentStep();
                  setStepIndex((i) => Math.min(STEPS.length - 1, i + 1));
                }}
                className="h-8 px-3.5 rounded-[6px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[12px] hover:bg-[#f0c15c] flex items-center gap-1"
              >
                <span>Далее</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                type="button"
                data-testid="onboarding-finish-btn"
                onClick={handleCompleteAndClose}
                className="h-8 px-3.5 rounded-[6px] bg-[#E8B44C] text-[#0B0B0C] font-medium text-[12px] hover:bg-[#f0c15c]"
              >
                Готово
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
