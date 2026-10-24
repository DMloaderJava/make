/**
 * Ссылки для UI провидера — проекция единого реестра.
 *
 * Раньше этот файл был вторым (после каталога) источником правды: 44 записи,
 * которые надо было руками держать в синхроне с `llm/catalog.ts`,
 * `tts/catalog.ts` и прокси-маршрутами. Теперь данные живут в
 * `providers/registry.ts`, а здесь остаётся только форма для карточек /settings
 * и вспомогательные функции поиска.
 *
 * Тип `ProviderLink` сохранён намеренно: на него завязан `ProviderList`.
 */

import { PROVIDER_REGISTRY, type ProviderKind, type ProviderRegistryEntry } from './registry';

export type ProviderCategory = ProviderKind;

export interface ProviderLink {
  id: string;
  name: string;
  category: ProviderCategory;
  keyUrl: string;
  docsUrl?: string;
  freeTier: boolean;
  limits: string;
  freeTierDetail: string;
  description: string;
  supportsVision?: boolean;
  supportsRussian?: boolean;
  requiresCard?: boolean;
}

function toProviderLink(entry: ProviderRegistryEntry): ProviderLink {
  return {
    id: entry.id,
    name: entry.name,
    category: entry.kind,
    keyUrl: entry.keyUrl,
    docsUrl: entry.docsUrl,
    freeTier: entry.freeTier,
    limits: entry.limits,
    freeTierDetail: entry.freeTierDetail,
    // Для LLM карточка показывает описание каталога, для TTS — короткое
    // описание из реестра. Это то же поведение, что было до объединения.
    description: entry.linkDescription ?? entry.description,
    supportsVision: entry.supportsVision,
    supportsRussian: entry.supportsRussian,
    requiresCard: entry.requiresCard,
  };
}

export const PROVIDER_LINKS: ProviderLink[] = PROVIDER_REGISTRY.map(toProviderLink);

// Composite key to avoid collision between LLM and TTS with same id (e.g. openai)
export const PROVIDER_LINKS_MAP = new Map(PROVIDER_LINKS.map(p => [`${p.category}:${p.id}`, p]));

export function getProviderLink(id: string, category?: ProviderCategory): ProviderLink | undefined {
  if (category) {
    const composite = PROVIDER_LINKS_MAP.get(`${category}:${id}`);
    if (composite) return composite;
    // Исторический алиас: старые проекты хранили TTS-провайдера как 'openai-tts'.
    if (id === 'openai-tts' && category === 'tts') {
      return PROVIDER_LINKS_MAP.get('tts:openai');
    }
  }
  return (
    PROVIDER_LINKS_MAP.get(`llm:${id}`) ||
    PROVIDER_LINKS_MAP.get(`tts:${id}`) ||
    PROVIDER_LINKS_MAP.get(`stt:${id}`)
  );
}

export function getProvidersByCategory(cat: ProviderCategory): ProviderLink[] {
  return PROVIDER_LINKS.filter(p => p.category === cat);
}
