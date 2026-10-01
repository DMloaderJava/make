import { lsKey, LS_KEYS } from './info';

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
  siteName: string;
  ctaType: 'profile' | 'description';
  backgroundMusicVolume: number;
  introDuration: number;
  outroDuration: number;
  enableMusic: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultTTSProvider: 'gemini',
  defaultLLMProvider: 'openrouter',
  defaultVisionModel: 'inclusionai/ling-3.0-flash-vl:free',
  siteName: 'Manga Voice Studio',
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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// Re-export helper for other modules
export { lsKey, LS_KEYS } from './info';
