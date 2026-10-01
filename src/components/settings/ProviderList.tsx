"use client";

import { useEffect, useState, useCallback } from 'react';
import { getAllKeys, saveApiKey } from '@/lib/storage/local';
import { getSettings, saveSettings, AppSettings, DEFAULT_SETTINGS } from '@/lib/storage/local';
import { LLM_PROVIDERS, getLLMProvider } from '@/lib/providers/llm';
import { TTS_PROVIDERS, getTTSProvider } from '@/lib/providers/tts';
import { getProviderLink, ProviderLink } from '@/lib/providers/links';
import { ExternalLink, Check, X, Eye, EyeOff, Trash2, Beaker, Loader2 } from 'lucide-react';

type Tab = 'llm' | 'tts';

function ProviderRow({
  link,
  providerId,
  type,
  storedKey,
  onSave,
  testing,
  testError,
  onTest,
  show,
  onToggleShow,
}: {
  link: ProviderLink;
  providerId: string;
  type: Tab;
  storedKey: string;
  onSave: (id: string, key: string) => void;
  testing: 'idle' | 'loading' | 'ok' | 'error';
  testError: string;
  onTest: () => void;
  show: boolean;
  onToggleShow: () => void;
}) {
  const [localKey, setLocalKey] = useState(storedKey);
  useEffect(() => { setLocalKey(storedKey); }, [storedKey]);

  const commit = useCallback(() => {
    if (localKey !== storedKey) onSave(providerId, localKey);
  }, [localKey, storedKey, onSave, providerId]);

  return (
    <div className="group rounded-[10px] border border-[#26262C] bg-[#16161A] hover:border-[#2F2F36] transition-colors p-3 md:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-medium text-[#F5F5F7]">{link.name}</span>
            <span className={`w-1.5 h-1.5 rounded-full ${storedKey ? 'bg-[#E8B44C]' : 'bg-[#26262C]'}`} />
            <span className={`text-[11px] font-mono ${storedKey ? 'text-[#E8B44C]' : 'text-[#8A8A93]'}`}>{storedKey ? 'активен' : 'не активен'}</span>
            {link.freeTier && <span className="text-[10px] px-1.5 py-0.5 rounded-[6px] bg-[#E8B44C]/15 text-[#E8B44C] font-medium">FREE</span>}
            {type === 'llm' && link.supportsVision && <span className="text-[10px] px-1.5 py-0.5 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[#8A8A93]">VISION</span>}
            {type === 'tts' && link.supportsRussian && <span className="text-[10px] px-1.5 py-0.5 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[#8A8A93]">RU</span>}
          </div>
          <div className="mt-1 text-[12px] text-[#8A8A93] leading-[1.4]">
            <span className="font-mono text-[11px]">{link.limits}</span>
            <span className="mx-1.5">·</span>
            <span>{link.freeTierDetail}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-[#8A8A93]/70">{link.description}</div>
        </div>
        {link.keyUrl && (
          <a href={link.keyUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 h-7 px-2.5 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[12px] text-[#8A8A93] hover:text-[#F5F5F7] hover:bg-[#26262C] flex items-center gap-1 transition-colors">
            <ExternalLink className="w-3 h-3" /> ключ
          </a>
        )}
      </div>

      <div className="mt-3 flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={localKey}
            onChange={(e) => setLocalKey(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
            placeholder={providerId === 'polly' ? '{"accessKeyId":"...","secretAccessKey":"..."}' : providerId === 'playht' ? 'userId:apiKey' : 'sk-...'}
            className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 pr-8 text-[13px] text-[#F5F5F7] placeholder:text-[#8A8A93]/50 focus:outline-none focus:border-[#E8B44C]/50 focus:ring-1 focus:ring-[#E8B44C]/20"
          />
          <button type="button" onClick={onToggleShow} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8A8A93] hover:text-[#F5F5F7]">
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button onClick={onTest} disabled={!storedKey || testing === 'loading'} className="h-8 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-xs text-[#F5F5F7] hover:bg-[#26262C] disabled:opacity-50 flex items-center gap-1.5">
          {testing === 'loading' ? <Loader2 className="w-3 h-3 animate-spin" /> : testing === 'ok' ? <Check className="w-3 h-3 text-[#E8B44C]" /> : testing === 'error' ? <X className="w-3 h-3 text-[#F87171]" /> : <Beaker className="w-3 h-3" />}
          {testing === 'ok' ? 'ок' : testing === 'error' ? 'ошибка' : 'тест'}
        </button>
        {storedKey && (
          <button onClick={() => onSave(providerId, '')} className="h-8 w-8 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[#8A8A93] hover:text-[#F87171] flex items-center justify-center">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {testError && testing === 'error' && (
        <div className="mt-2 text-[11px] font-mono text-[#F87171] bg-[#F87171]/10 border border-[#F87171]/20 rounded-[6px] px-2 py-1">{testError}</div>
      )}
    </div>
  );
}

export function ProviderList() {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [tab, setTab] = useState<Tab>('llm');
  const [customLLMBaseUrl, setCustomLLMBaseUrl] = useState('');
  const [customLLMModel, setCustomLLMModel] = useState('');
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, 'idle' | 'loading' | 'ok' | 'error'>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [localSiteName, setLocalSiteName] = useState('');
  const [localIntro, setLocalIntro] = useState<number | string>('');
  const [localOutro, setLocalOutro] = useState<number | string>('');

  useEffect(() => {
    const s = getSettings();
    setKeys(getAllKeys());
    setSettings(s);
    setLocalSiteName(s.siteName);
    setLocalIntro(s.introDuration);
    setLocalOutro(s.outroDuration);
    const custom = localStorage.getItem('mvs-info:custom-llm-config') || localStorage.getItem('custom-llm-config');
    if (custom) {
      try {
        const cfg = JSON.parse(custom);
        setCustomLLMBaseUrl(cfg.baseUrl || '');
        setCustomLLMModel(cfg.model || '');
      } catch {}
    }
  }, []);

  const handleSave = useCallback((providerId: string, key: string) => {
    saveApiKey(providerId, key);
    setKeys(prev => ({ ...prev, [providerId]: key }));
  }, []);

  const handleSettingsSave = (newSettings: Partial<AppSettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);
    saveSettings(updated);
    try { window.dispatchEvent(new Event('manga-voice-settings-changed')); window.dispatchEvent(new Event('mvs-info:settings-changed')); } catch {}
  };

  const handleCustomLLMSave = () => {
    localStorage.setItem('mvs-info:custom-llm-config', JSON.stringify({ baseUrl: customLLMBaseUrl, model: customLLMModel }));
  };

  const testProvider = async (id: string, type: Tab) => {
    const key = keys[id];
    if (!key) {
      setTestErrors(prev => ({ ...prev, [id]: 'Нет ключа' }));
      setTesting(prev => ({ ...prev, [id]: 'error' }));
      setTimeout(() => { setTesting(p => ({ ...p, [id]: 'idle' })); setTestErrors(p => ({ ...p, [id]: '' })); }, 4000);
      return;
    }
    setTesting(prev => ({ ...prev, [id]: 'loading' }));
    setTestErrors(prev => ({ ...prev, [id]: '' }));
    try {
      if (type === 'llm') {
        const provider = getLLMProvider(id);
        if (!provider) throw new Error('Provider not found');
        if (id === 'cloudflare' && !customLLMBaseUrl) {
          throw new Error('Укажи Account ID в кастомном endpoint для Cloudflare: https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1');
        }
        const model = id === 'custom' ? (customLLMModel || provider.defaultModel) : provider.defaultModel;
        const baseUrl = id === 'custom' ? customLLMBaseUrl : (id === 'cloudflare' ? customLLMBaseUrl : undefined);
        try {
          const result = await provider.chat([{ role: 'user', content: 'hi' }], { apiKey: key, model, baseUrl, maxTokens: 10 } as any);
          if (!result) throw new Error('Пустой ответ');
        } catch (directErr: any) {
          if (directErr.message?.includes('Failed to fetch') || directErr.message?.includes('CORS') || directErr.message?.includes('NetworkError')) {
            const res = await fetch('/api/llm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId: id, messages: [{ role: 'user', content: 'hi' }], apiKey: key, model, baseUrl, maxTokens: 10 })
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({ error: res.statusText }));
              throw new Error(err.error || `Proxy error ${res.status}`);
            }
            const data = await res.json();
            if (!data.content) throw new Error('Пустой ответ от прокси');
          } else {
            throw directErr;
          }
        }
      } else {
        const provider = getTTSProvider(id);
        if (!provider) throw new Error(`Provider not found: ${id}`);
        try {
          const voices = await provider.getVoices(key);
          if (!voices || voices.length === 0) throw new Error('Нет голосов');
        } catch (e: any) {
          if (['elevenlabs', 'deepgram', 'fish', 'polly', 'azure', 'playht', 'resemble', 'murf', 'openai'].includes(id)) {
            const res = await fetch('/api/tts/voices', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ providerId: id, apiKey: key })
            });
            if (!res.ok) throw e;
            const data = await res.json();
            if (!data.voices || data.voices.length === 0) throw new Error('Нет голосов через прокси');
          } else {
            throw e;
          }
        }
      }
      setTesting(prev => ({ ...prev, [id]: 'ok' }));
      setTimeout(() => setTesting(prev => ({ ...prev, [id]: 'idle' })), 3000);
    } catch (e: any) {
      setTesting(prev => ({ ...prev, [id]: 'error' }));
      setTestErrors(prev => ({ ...prev, [id]: e.message?.slice(0, 200) || 'Ошибка' }));
      setTimeout(() => { setTesting(p => ({ ...p, [id]: 'idle' })); setTestErrors(p => ({ ...p, [id]: '' })); }, 5000);
    }
  };

  const filteredLinks = (type: Tab): Array<{ link: ProviderLink; providerId: string }> => {
    const providers = type === 'llm' ? LLM_PROVIDERS : TTS_PROVIDERS;
    return providers
      .map(p => ({ link: getProviderLink(p.id, type), providerId: p.id }))
      .filter((x): x is { link: ProviderLink; providerId: string } => !!x.link);
  };

  return (
    <div className="max-w-[960px] mx-auto space-y-6">
      <div className="space-y-2">
        <h1 className="text-[22px] font-semibold text-[#F5F5F7] tracking-[-0.02em]">Провайдеры</h1>
        <p className="text-[13px] text-[#8A8A93] leading-[1.5]">Все ключи хранятся только в браузере (localStorage). Сервер их не видит. Прокси через /api/* только для CORS.<br />Рекомендуем старт: <span className="text-[#E8B44C]">OpenRouter (free)</span> + <span className="text-[#E8B44C]">Gemini TTS (free)</span> + <span className="text-[#F5F5F7]">Azure TTS (500k/мес)</span></p>
      </div>

      <div className="rounded-[10px] bg-[#16161A] border border-[#26262C] p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-[12px] text-[#8A8A93]">Название канала/сайта</label>
          <input
            value={localSiteName}
            onChange={(e) => setLocalSiteName(e.target.value)}
            onBlur={() => { if (localSiteName !== settings.siteName) handleSettingsSave({ siteName: localSiteName }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="Manga Voice Studio"
            className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]"
          />
        </div>
        <div className="space-y-2">
          <label className="text-[12px] text-[#8A8A93]">Тип CTA в аутро</label>
          <select value={settings.ctaType} onChange={(e) => handleSettingsSave({ ctaType: e.target.value as any })} className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]">
            <option value="profile">Ссылка в шапке профиля</option>
            <option value="description">Ссылка в описании</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-[12px] text-[#8A8A93]">Интро (сек)</label>
          <input
            type="number"
            value={localIntro}
            onChange={(e) => setLocalIntro(e.target.value)}
            onBlur={() => {
              const n = Number(localIntro);
              if (!isNaN(n) && n !== settings.introDuration) handleSettingsSave({ introDuration: n });
            }}
            min={0} max={30}
            className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px]"
          />
        </div>
        <div className="space-y-2">
          <label className="text-[12px] text-[#8A8A93]">Аутро (сек)</label>
          <input
            type="number"
            value={localOutro}
            onChange={(e) => setLocalOutro(e.target.value)}
            onBlur={() => {
              const n = Number(localOutro);
              if (!isNaN(n) && n !== settings.outroDuration) handleSettingsSave({ outroDuration: n });
            }}
            min={0} max={20}
            className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px]"
          />
        </div>
        <div className="space-y-2">
          <label className="text-[12px] text-[#8A8A93]">TTS по умолчанию</label>
          <select value={settings.defaultTTSProvider} onChange={(e) => handleSettingsSave({ defaultTTSProvider: e.target.value })} className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]">
            {TTS_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="space-y-2">
          <label className="text-[12px] text-[#8A8A93]">LLM по умолчанию</label>
          <select value={settings.defaultLLMProvider} onChange={(e) => handleSettingsSave({ defaultLLMProvider: e.target.value })} className="w-full h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]">
            {LLM_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      <div className="rounded-[10px] border border-dashed border-[#26262C] bg-[#16161A]/50 p-4 space-y-3">
        <div className="text-[13px] font-medium text-[#F5F5F7]">Кастомный OpenAI-совместимый endpoint</div>
        <div className="text-[12px] text-[#8A8A93]">Для LM Studio, Ollama, vLLM, Cloudflare Workers AI (укажи account_id в URL)</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input value={customLLMBaseUrl} onChange={(e) => setCustomLLMBaseUrl(e.target.value)} placeholder="https://api.example.com/v1 или https://api.cloudflare.com/client/v4/accounts/xxx/ai/v1" className="h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]" />
          <input value={customLLMModel} onChange={(e) => setCustomLLMModel(e.target.value)} placeholder="my-model-name" className="h-8 rounded-[6px] bg-[#0B0B0C] border border-[#26262C] px-3 text-[13px] text-[#F5F5F7]" />
        </div>
        <button onClick={handleCustomLLMSave} className="h-8 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-xs text-[#F5F5F7] hover:bg-[#26262C]">Сохранить endpoint</button>
      </div>

      <div className="flex gap-2 p-1 rounded-[10px] bg-[#16161A] border border-[#26262C] w-fit">
        <button onClick={() => setTab('llm')} className={`h-8 px-4 rounded-[6px] text-[13px] font-medium transition-colors ${tab === 'llm' ? 'bg-[#E8B44C] text-[#0B0B0C]' : 'text-[#8A8A93] hover:text-[#F5F5F7]'}`}>🧠 Анализ и текст</button>
        <button onClick={() => setTab('tts')} className={`h-8 px-4 rounded-[6px] text-[13px] font-medium transition-colors ${tab === 'tts' ? 'bg-[#E8B44C] text-[#0B0B0C]' : 'text-[#8A8A93] hover:text-[#F5F5F7]'}`}>🔊 Озвучка</button>
      </div>

      <div className="grid gap-3">
        {filteredLinks(tab).map(({ link, providerId }) => (
          <ProviderRow
            key={`${tab}:${providerId}`}
            link={link}
            providerId={providerId}
            type={tab}
            storedKey={keys[providerId] || ''}
            onSave={handleSave}
            testing={testing[providerId] || 'idle'}
            testError={testErrors[providerId] || ''}
            onTest={() => testProvider(providerId, tab)}
            show={!!showKeys[providerId]}
            onToggleShow={() => setShowKeys(s => ({ ...s, [providerId]: !s[providerId] }))}
          />
        ))}
      </div>

      <div className="rounded-[10px] bg-[#16161A] border border-[#26262C] p-4 text-[12px] text-[#8A8A93] space-y-2 leading-[1.5]">
        <p>🔒 <span className="text-[#F5F5F7] font-medium">Приватность:</span> Все ключи только в localStorage, никакого Supabase.</p>
        <p>💡 <span className="text-[#F5F5F7] font-medium">Старт:</span> OpenRouter free (ling-3.0-flash-vl:free 262K) + Google AI Studio (Gemini 2.5 Flash) + Azure TTS (500k/мес F0) — покрывают 90% задач без карты.</p>
        <p>📚 Больше free: <a href="https://github.com/open-free-llm-api/awesome-freellm-apis" target="_blank" className="text-[#E8B44C] hover:underline">awesome-freellm-apis</a> · <a href="https://github.com/nejib1/Free-LLM" target="_blank" className="text-[#E8B44C] hover:underline">Free-LLM</a> · <a href="https://free-llm.com" target="_blank" className="text-[#E8B44C] hover:underline">free-llm.com</a></p>
      </div>

      <DataManagementSection />
    </div>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function DataManagementSection() {
  const [usage, setUsage] = useState<{ localStorage: number; indexedDB: number; opfs: number; opfsQuota: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const loadUsage = async () => {
    try {
      const { getInfoUsage } = await import('@/lib/storage/info');
      setUsage(await getInfoUsage());
    } catch {}
  };

  useEffect(() => { loadUsage(); }, []);

  const handleExport = async (withKeys: boolean) => {
    if (withKeys) {
      const ok = confirm('Бэкап содержит API-ключи в открытом виде. Храни файл в безопасном месте. Продолжить?');
      if (!ok) return;
    }
    setLoading(true);
    try {
      const { exportAllInfoWithFiles } = await import('@/lib/storage/info');
      const blob = await exportAllInfoWithFiles({ includeKeys: withKeys });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `manga-voice-backup-${new Date().toISOString().slice(0,10)}.mvs.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      alert(`Ошибка экспорта: ${e.message}`);
    } finally {
      setLoading(false);
      loadUsage();
    }
  };

  const handleImport = async (file: File) => {
    const confirm1 = confirm('Это перезапишет все текущие данные (проекты, ключи, настройки, кеш). Продолжить?');
    if (!confirm1) return;
    setLoading(true);
    try {
      const { importAllInfo } = await import('@/lib/storage/info');
      await importAllInfo(file);
      alert('Импорт завершён, перезагружаю...');
      location.reload();
    } catch (e: any) {
      alert(`Ошибка импорта: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleClear = async () => {
    const c1 = confirm('Удалить все проекты, ключи и кеш?');
    if (!c1) return;
    const c2 = confirm('Точно? Это необратимо. Все данные в mvs-info будут удалены.');
    if (!c2) return;
    setLoading(true);
    try {
      const { clearAllInfo } = await import('@/lib/storage/info');
      await clearAllInfo();
      alert('Всё очищено');
      location.reload();
    } catch (e: any) {
      alert(`Ошибка очистки: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-[10px] bg-[#16161A] border border-[#26262C] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-medium text-[#F5F5F7]">Данные приложения · mvs-info</h3>
        <button onClick={loadUsage} className="h-7 px-2.5 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-[11px] text-[#8A8A93] hover:text-[#F5F5F7]">Обновить</button>
      </div>

      {usage ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono">
          <div className="p-2.5 rounded-[8px] bg-[#0B0B0C] border border-[#26262C]">
            <div className="text-[#8A8A93]">localStorage</div>
            <div className="text-[#F5F5F7] font-medium">{formatBytes(usage.localStorage)}</div>
          </div>
          <div className="p-2.5 rounded-[8px] bg-[#0B0B0C] border border-[#26262C]">
            <div className="text-[#8A8A93]">IndexedDB</div>
            <div className="text-[#F5F5F7] font-medium">{formatBytes(usage.indexedDB)}</div>
          </div>
          <div className="p-2.5 rounded-[8px] bg-[#0B0B0C] border border-[#26262C]">
            <div className="text-[#8A8A93]">OPFS</div>
            <div className="text-[#F5F5F7] font-medium">{formatBytes(usage.opfs)}</div>
          </div>
          <div className="p-2.5 rounded-[8px] bg-[#0B0B0C] border border-[#26262C]">
            <div className="text-[#8A8A93]">Квота</div>
            <div className="text-[#F5F5F7] font-medium">{formatBytes(usage.opfsQuota)}</div>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-[#8A8A93]">Загрузка размера...</div>
      )}

      <div className="text-[11px] text-[#8A8A93] leading-[1.5]">
        Всё хранится в едином пространстве <span className="font-mono text-[#F5F5F7]">mvs-info</span>:<br />
        <span className="font-mono">localStorage mvs-info:*</span> · <span className="font-mono">IDB mvs-info</span> · <span className="font-mono">OPFS mvs-info/</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={() => handleExport(true)} disabled={loading} className="h-8 px-3 rounded-[6px] bg-[#E8B44C] text-[#0B0B0C] text-xs font-medium hover:bg-[#B88A2E] disabled:opacity-50">Скачать полный бэкап</button>
        <button onClick={() => handleExport(false)} disabled={loading} className="h-8 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-xs text-[#F5F5F7] hover:bg-[#26262C] disabled:opacity-50">Бэкап без ключей</button>
        <label className="h-8 px-3 rounded-[6px] bg-[#1E1E23] border border-[#26262C] text-xs text-[#F5F5F7] hover:bg-[#26262C] flex items-center cursor-pointer">
          Импорт бэкапа
          <input type="file" accept=".json,.mvs.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImport(f); }} />
        </label>
        <button onClick={handleClear} disabled={loading} className="h-8 px-3 rounded-[6px] bg-[#F87171]/15 border border-[#F87171]/30 text-xs text-[#F87171] hover:bg-[#F87171]/25 disabled:opacity-50 ml-auto">Очистить всё</button>
      </div>

      <div className="text-[10px] font-mono text-[#8A8A93]/60">
        DevTools: <span className="text-[#8A8A93]">await mvsInfo.clearAll()</span> · <span className="text-[#8A8A93]">await mvsInfo.usage()</span> · <span className="text-[#8A8A93]">await mvsInfo.exportAll()</span>
      </div>
    </div>
  );
}
