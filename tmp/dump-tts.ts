import { TTS_PROVIDERS } from '../src/lib/providers/tts/catalog';
for (const p of TTS_PROVIDERS) {
  console.log(JSON.stringify({ id: p.id, name: p.name, description: p.description, freeTier: p.freeTier, languages: p.languages, experimental: p.experimental ?? false, proxyClientSide: p.proxyClientSide ?? false, supportsSpeed: p.supportsSpeed ?? null, defaultModel: p.defaultModel ?? null, baseUrl: p.baseUrl ?? null }));
}
