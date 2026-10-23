import fs from 'node:fs';

const dump = JSON.parse(fs.readFileSync('tmp/dump.json', 'utf8'));
const tts = JSON.parse(fs.readFileSync('tmp/tts.json', 'utf8'));

const llmProxyBase = {
  'github-models': 'https://models.inference.ai.azure.com',
  cerebras: 'https://api.cerebras.ai/v1',
  sambanova: 'https://api.sambanova.ai/v1',
  openai: 'https://api.openai.com/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  deepseek: 'https://api.deepseek.com/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  '01ai': 'https://api.01.ai/v1',
  perplexity: 'https://api.perplexity.ai',
};
const proxyIds = new Set(['elevenlabs', 'openai', 'polly', 'azure', 'deepgram', 'playht', 'resemble', 'murf', 'fish', 'hume', 'speechify']);

const llmById = new Map(dump.llm.map(p => [p.id, p]));
const ttsById = new Map(tts.map(p => [p.id, p]));
const ttsCatalogOrder = tts.map(p => p.id);
const llmCatalogOrder = dump.llm.map(p => p.id);

function q(v) { return JSON.stringify(v); }

const entries = [];
for (const link of dump.links) {
  const e = {
    kind: link.category,
    id: link.id,
    name: link.name,
    description: link.description,
    keyUrl: link.keyUrl,
    docsUrl: link.docsUrl || undefined,
    freeTier: link.freeTier,
    limits: link.limits,
    freeTierDetail: link.freeTierDetail,
    supportsVision: link.supportsVision ?? undefined,
    supportsRussian: link.supportsRussian ?? undefined,
    requiresCard: link.requiresCard ?? undefined,
  };
  if (link.category === 'llm') {
    const impl = llmById.get(link.id);
    if (impl) {
      e.implemented = true;
      e.name = impl.name;
      e.description = impl.description;
      e.api = link.id === 'gemini' ? 'gemini' : 'openai';
      e.baseUrl = impl.baseUrl;
      e.models = impl.models;
      e.defaultModel = impl.defaultModel;
      e.freeTier = impl.freeTier;
      e.trialOnly = impl.trialOnly || undefined;
      e.freeTierNote = impl.freeTierNote || undefined;
      e.limitsUrl = impl.limitsUrl || undefined;
      if (impl.rateLimits) e.rateLimits = impl.rateLimits;
      if (impl.apiKeyPrefix) e.apiKeyPrefix = impl.apiKeyPrefix;
      if (impl.requiresAccountId) e.requiresAccountId = true;
      if (impl.supportsVision) e.visionModels = impl.visionModels;
      e.catalogOrder = llmCatalogOrder.indexOf(link.id);
      e.linkDescription = link.description;
    } else {
      e.implemented = false;
      e.api = link.id === 'anthropic' ? 'anthropic' : 'openai';
      if (llmProxyBase[link.id]) e.baseUrl = llmProxyBase[link.id];
      e.linkDescription = link.description;
    }
  } else if (link.category === 'tts') {
    const impl = ttsById.get(link.id);
    if (!impl) throw new Error('missing tts metadata ' + link.id);
    e.implemented = true;
    e.name = impl.name;
    e.description = impl.description;
    e.linkDescription = link.description;
    e.freeTier = impl.freeTier;
    e.languages = impl.languages;
    e.baseUrl = impl.baseUrl || undefined;
    if (impl.defaultModel) e.defaultModel = impl.defaultModel;
    if (impl.experimental) e.experimental = true;
    if (impl.proxyClientSide) e.proxyClientSide = true;
    if (impl.supportsSpeed === false) e.supportsSpeed = false;
    e.cors = proxyIds.has(link.id) ? 'proxy' : 'direct';
    e.catalogOrder = ttsCatalogOrder.indexOf(link.id);
  } else {
    e.implemented = false;
  }
  entries.push(e);
}

function emitEntry(e) {
  const lines = [];
  const order = ['kind','id','name','description','linkDescription','keyUrl','docsUrl','freeTier','limits','freeTierDetail','limitsUrl','freeTierNote','trialOnly','supportsVision','supportsRussian','requiresCard','implemented','api','baseUrl','models','defaultModel','visionModels','rateLimits','apiKeyPrefix','requiresAccountId','languages','experimental','proxyClientSide','supportsSpeed','cors','catalogOrder'];
  for (const key of order) {
    if (!(key in e) || e[key] === undefined) continue;
    lines.push(`    ${key}: ${q(e[key])},`);
  }
  return `  {\n${lines.join('\n')}\n  },`;
}

const body = entries.map(emitEntry).join('\n');

const header = `/**
 * Единый реестр провайдеров (P0-2).
 *
 * Здесь собраны ВСЕ метаданные, которые раньше были размазаны по пяти местам:
 * - \`providers/llm/catalog.ts\` (модели, vision, free tier);
 * - \`providers/tts/catalog.ts\` (языки, experimental, proxy);
 * - \`providers/links.ts\` (ссылки на ключи, лимиты, описание);
 * - \`app/api/llm/route.ts\` и \`app/api/seo/route.ts\` (baseUrl для прокси);
 * - \`providers/tts/cors.ts\` (кто идёт через прокси).
 *
 * Правило: добавление провайдера = одна запись здесь + файл реализации
 * (для LLM можно обойтись записью, если он OpenAI-совместимый). Все остальные
 * структуры (каталоги, ссылки, CORS-политика, proxy-маршруты) выводятся из
 * этого массива; \`tests/providerRegistry.test.ts\` падает при рассинхроне.
 *
 * Поля:
 * - \`kind\` + \`id\` — составной ключ (у \`openai\` и \`gemini\` есть и LLM-, и TTS-запись);
 * - \`implemented\` — есть ли объект провайдера в каталоге (LLM/TTS) или только
 *   ссылка/прокси-маршрут (например, GitHub Models доступен через /api/llm, но
 *   в UI не показывается);
 * - \`api\` — стиль протокола: \`openai\` (chat/completions), \`gemini\` (generateContent),
 *   \`anthropic\` (/v1/messages — прокси не поддерживает, отвечает 501);
 * - \`cors\` — \`proxy\`: браузер не может звать напрямую, идём через /api/tts;
 * - \`catalogOrder\` — порядок в UI/цепочке fallback (не алфавитный список ссылок).
 */

export type ProviderKind = 'llm' | 'tts' | 'stt';
export type ProviderApiStyle = 'openai' | 'gemini' | 'anthropic';
export type ProviderCorsPolicy = 'direct' | 'proxy';

export interface ProviderRegistryEntry {
  kind: ProviderKind;
  id: string;
  name: string;
  description: string;
  /** Описание для карточки в /settings (раньше жило только в links.ts). */
  linkDescription?: string;
  keyUrl: string;
  docsUrl?: string;
  freeTier: boolean;
  limits: string;
  freeTierDetail: string;
  limitsUrl?: string;
  freeTierNote?: string;
  trialOnly?: boolean;
  supportsVision?: boolean;
  supportsRussian?: boolean;
  requiresCard?: boolean;
  /** Есть ли реализация в каталоге LLM/TTS. */
  implemented: boolean;
  // LLM
  api?: ProviderApiStyle;
  baseUrl?: string;
  models?: string[];
  defaultModel?: string;
  visionModels?: string[];
  rateLimits?: { rpm?: number; rpd?: number };
  apiKeyPrefix?: string;
  requiresAccountId?: boolean;
  // TTS
  languages?: string[];
  experimental?: boolean;
  proxyClientSide?: boolean;
  supportsSpeed?: boolean;
  cors?: ProviderCorsPolicy;
  /** Порядок в каталоге (UI и fallback-цепочка), а не в списке ссылок. */
  catalogOrder?: number;
}

export const PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
${body}
];

const byKey = new Map(PROVIDER_REGISTRY.map(entry => [\`\${entry.kind}:\${entry.id}\`, entry]));

/** Запись реестра по составному ключу. */
export function getRegistryEntry(kind: ProviderKind, id: string): ProviderRegistryEntry | undefined {
  return byKey.get(\`\${kind}:\${id}\`);
}

/** Все записи заданного вида в порядке реестра. */
export function getRegistryByKind(kind: ProviderKind): ProviderRegistryEntry[] {
  return PROVIDER_REGISTRY.filter(entry => entry.kind === kind);
}

/** Реализованные провайдеры вида — в порядке каталога (catalogOrder). */
export function getImplementedProviders(kind: ProviderKind): ProviderRegistryEntry[] {
  return getRegistryByKind(kind)
    .filter(entry => entry.implemented)
    .sort((a, b) => (a.catalogOrder ?? Number.MAX_SAFE_INTEGER) - (b.catalogOrder ?? Number.MAX_SAFE_INTEGER));
}

/**
 * URL прокси для LLM. Подставляет account_id (Cloudflare) или пользовательский
 * baseUrl. null — провайдер нельзя проксировать (Anthropic: другой протокол).
 */
export function resolveLLMProxyUrl(
  id: string,
  options?: { baseUrl?: string; accountId?: string }
): string | null {
  const entry = getRegistryEntry('llm', id) || getRegistryEntry('llm', id === 'google-ai' ? 'gemini' : id);
  if (!entry || entry.api === 'anthropic' || entry.api === 'gemini') return null;
  const raw = options?.baseUrl || entry.baseUrl || '';
  if (!raw) return null;
  if (entry.requiresAccountId) {
    const accountId = String(options?.accountId || '').trim();
    if (!accountId) return null;
    return raw.replace('{account_id}', encodeURIComponent(accountId));
  }
  return raw;
}

/** Gemini-подобный протокол (generateContent) — отдельная ветка прокси. */
export function isGeminiApi(id: string): boolean {
  const entry = getRegistryEntry('llm', id);
  return entry?.api === 'gemini';
}

/** Провайдер намеренно не проксируется (документированная причина). */
export function isProxyUnsupported(id: string): boolean {
  return getRegistryEntry('llm', id)?.api === 'anthropic';
}

/** CORS-политика TTS-провайдера: direct (браузер) или proxy (/api/tts). */
export function getTTSCorsPolicy(id: string): ProviderCorsPolicy | null {
  return getRegistryEntry('tts', id)?.cors ?? null;
}

/** Все TTS-провайдеры, которым обязателен серверный прокси. */
export function getProxiedTTSProviderIds(): string[] {
  return getRegistryByKind('tts').filter(entry => entry.cors === 'proxy').map(entry => entry.id);
}
`;

fs.writeFileSync('src/lib/providers/registry.ts', header);
console.log('entries', entries.length, 'llm', entries.filter(e=>e.kind==='llm').length, 'tts', entries.filter(e=>e.kind==='tts').length, 'stt', entries.filter(e=>e.kind==='stt').length);
