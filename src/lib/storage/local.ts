import { LS_KEYS } from './info';

const STORAGE_KEY = LS_KEYS.KEYS;
const SETTINGS_KEY = LS_KEYS.SETTINGS;

export function saveApiKey(providerId: string, key: string) {
  if (typeof window === 'undefined') return;
  const keys = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  if (key) {
    keys[providerId] = key;
  } else {
    delete keys[providerId];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function getApiKey(providerId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const keys = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return keys[providerId] || null;
  } catch {
    return null;
  }
}

export function getAllKeys(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

export function clearAllKeys() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

export interface AppSettings {
  defaultTTSProvider: string;
  defaultLLMProvider: string;
  defaultVisionModel: string;
  cloudflareAccountId: string;
  siteName: string;
  /** Название канала (fallback-интро/аутро). Пусто — используется siteName. */
  channelName: string;
  /** Подпись канала (опционально). */
  channelTagline: string;
  ctaType: 'profile' | 'description';
  backgroundMusicVolume: number;
  introDuration: number;
  outroDuration: number;
  enableMusic: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultTTSProvider: 'gemini',
  defaultLLMProvider: 'openrouter',
  defaultVisionModel: 'google/gemma-4-31b-it:free',
  cloudflareAccountId: '',
  siteName: 'Manga Voice Studio',
  channelName: '',
  channelTagline: '',
  ctaType: 'profile',
  backgroundMusicVolume: 0.15,
  introDuration: 8,
  outroDuration: 5,
  enableMusic: false,
};

export function saveSettings(settings: AppSettings) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function getSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (!stored) return DEFAULT_SETTINGS;
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } as AppSettings;
    // Before the catalog update this was the OpenRouter default; it is a
    // text-only coding model and must not remain the saved manga vision model.
    if (
      settings.defaultLLMProvider === 'openrouter'
      && ['qwen/qwen3-coder', 'qwen/qwen3-coder:free'].includes(settings.defaultVisionModel)
    ) {
      settings.defaultVisionModel = DEFAULT_SETTINGS.defaultVisionModel;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
    }
    return settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Re-export helper for other modules
export { lsKey, LS_KEYS } from './info';
