import { PROVIDER_LINKS } from '../src/lib/providers/links';
import { LLM_PROVIDERS } from '../src/lib/providers/llm/catalog';
console.log(JSON.stringify({ links: PROVIDER_LINKS, llm: LLM_PROVIDERS.map(p => ({
  id: p.id, name: p.name, description: p.description, baseUrl: p.baseUrl,
  models: p.models, defaultModel: p.defaultModel, freeTier: p.freeTier,
  trialOnly: p.trialOnly ?? false, freeTierNote: p.freeTierNote ?? null,
  limitsUrl: p.limitsUrl ?? null, rateLimits: p.rateLimits ?? null,
  apiKeyPrefix: p.apiKeyPrefix ?? null, requiresAccountId: p.requiresAccountId ?? false,
  supportsVision: p.supportsVision, visionModels: p.visionModels ?? [],
}))}, null, 2));
