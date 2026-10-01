import { z } from 'zod';

// Panel validation - strict
export const PanelSchema = z.object({
  id: z.number().int().min(0),
  bbox: z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(1).max(100),
    height: z.number().min(1).max(100),
  }),
  dialogue: z.string().min(1).max(2000),
  character: z.string().min(1).max(100),
  emotion: z.enum(['neutral', 'angry', 'happy', 'sad', 'surprised', 'scared', 'thoughtful']),
  type: z.enum(['speech', 'thought', 'narration', 'sfx']),
  order: z.number().int().min(0),
});

export const VisionResultSchema = z.object({
  imageWidth: z.number().min(1),
  imageHeight: z.number().min(1),
  panels: z.array(PanelSchema).min(1).max(50),
  sceneDescription: z.string().min(1).max(1000),
  characters: z.array(z.object({
    name: z.string().min(1).max(100),
    appearance: z.string().max(500),
  })).max(20),
});

export const SEOTitleSchema = z.object({
  main: z.string().min(10).max(100),
  alternatives: z.array(z.string().min(10).max(100)).min(1).max(5),
});

export const SEODescriptionSchema = z.object({
  hook: z.string().min(20).max(200),
  body: z.string().min(100).max(5000),
  hashtags: z.array(z.string().regex(/^#/)).min(1).max(10),
});

export const SEOThumbnailSchema = z.object({
  prompt: z.string().min(20).max(1000),
  textOverlay: z.string().min(1).max(20),
  emotion: z.string().min(1).max(100),
});

export const SEOChapterSchema = z.object({
  time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  title: z.string().min(1).max(100),
});

export const SEOPackageSchema = z.object({
  title: SEOTitleSchema,
  description: SEODescriptionSchema,
  tags: z.array(z.string().min(1).max(50)).min(5).max(30),
  thumbnail: SEOThumbnailSchema,
  chapters: z.array(SEOChapterSchema).min(3).max(20),
  publishTime: z.string().min(5).max(100),
  pinnedComment: z.string().min(20).max(1000),
});

export const SyncTimelineSchema = z.object({
  panelId: z.number().int(),
  imageIndex: z.number().int().min(0),
  audioStart: z.number().min(0),
  audioEnd: z.number().min(0),
  panelBbox: z.object({
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    width: z.number().min(1).max(100),
    height: z.number().min(1).max(100),
  }),
  voiceId: z.string().min(1),
  text: z.string().min(1),
  character: z.string().min(1),
});

// Validation helpers
export function validateVisionResult(data: any): { success: boolean; data?: z.infer<typeof VisionResultSchema>; errors?: string[] } {
  try {
    const parsed = VisionResultSchema.parse(data);
    return { success: true, data: parsed };
  } catch (e) {
    if (e instanceof z.ZodError) {
      return { success: false, errors: (e as any).issues?.map((err: any) => `${err.path?.join('.')}: ${err.message}`) || [(e as Error).message] };
    }
    return { success: false, errors: [(e as Error).message] };
  }
}

export function validateSEOPackage(data: any): { success: boolean; data?: z.infer<typeof SEOPackageSchema>; errors?: string[] } {
  try {
    const parsed = SEOPackageSchema.parse(data);
    if (parsed.title.main.length > 70) {
      console.warn('Title longer than 70 chars, will be truncated');
    }
    if (parsed.chapters.length < 3) {
      return { success: false, errors: ['Need at least 3 chapters'] };
    }
    for (let i = 1; i < parsed.chapters.length; i++) {
      const prev = timeToSeconds(parsed.chapters[i-1].time);
      const curr = timeToSeconds(parsed.chapters[i].time);
      if (curr <= prev) {
        return { success: false, errors: [`Chapter ${i} time ${parsed.chapters[i].time} must be after ${parsed.chapters[i-1].time}`] };
      }
    }
    return { success: true, data: parsed };
  } catch (e) {
    if (e instanceof z.ZodError) {
      return { success: false, errors: (e as any).issues?.map((err: any) => `${err.path?.join('.')}: ${err.message}`) || [(e as Error).message] };
    }
    return { success: false, errors: [(e as Error).message] };
  }
}

function timeToSeconds(time: string): number {
  const parts = time.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

// Character normalization - fuzzy match for same character with different spellings
// Returns merged list + renameMap oldName -> canonicalName for fixing panels
export function normalizeCharactersWithMap(characters: Array<{ name: string; appearance: string }>): {
  merged: Array<{ name: string; appearance: string; aliases: string[] }>;
  renameMap: Record<string, string>;
} {
  const normalized = new Map<string, { name: string; appearance: string; aliases: string[] }>();
  const renameMap: Record<string, string> = {};
  
  for (const char of characters) {
    const key = char.name.toLowerCase().trim()
      .replace(/ё/g, 'е')
      .replace(/[^a-zа-я0-9]/g, '');
    
    let foundKey: string | null = null;
    for (const [existingKey, existing] of normalized) {
      if (isSimilar(key, existingKey) || isSimilar(char.name.toLowerCase(), existing.name.toLowerCase())) {
        foundKey = existingKey;
        break;
      }
    }

    if (foundKey) {
      const existing = normalized.get(foundKey)!;
      if (!existing.aliases.includes(char.name)) {
        existing.aliases.push(char.name);
      }
      renameMap[char.name] = existing.name;
      if (char.appearance.length > existing.appearance.length) {
        existing.appearance = char.appearance;
      }
    } else {
      normalized.set(key, { name: char.name, appearance: char.appearance, aliases: [] });
      renameMap[char.name] = char.name;
    }
  }

  // Ensure all aliases map to canonical
  for (const entry of normalized.values()) {
    for (const alias of entry.aliases) {
      renameMap[alias] = entry.name;
    }
  }

  return { merged: Array.from(normalized.values()), renameMap };
}

export function normalizeCharacters(characters: Array<{ name: string; appearance: string }>): Array<{ name: string; appearance: string; aliases: string[] }> {
  return normalizeCharactersWithMap(characters).merged;
}

function isSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Levenshtein distance
  const distance = levenshtein(a, b);
  return distance <= 2 && Math.max(a.length, b.length) > 3;
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1,
          matrix[i][j-1] + 1,
          matrix[i-1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

// Cost estimation — approximate, update when provider pricing changes
export function estimateTTSCost(text: string, provider: string): { characters: number; estimatedCost: string } {
  const chars = text.length;
  const costs: Record<string, number> = {
    elevenlabs: 0.18 / 1000,
    openai: 0.015 / 1000,
    gemini: 0,
    speechify: 0.02 / 1000,
    polly: 0.004 / 1000,
    qwen: 0,
    'google-cloud': 0.004 / 1000,
    cartesia: 0.02 / 1000,
    deepgram: 0.015 / 1000,
    azure: 0.016 / 1000,
    playht: 0.03 / 1000,
    resemble: 0.03 / 1000,
    murf: 0.02 / 1000,
    fish: 0.015 / 1000,
    hume: 0.02 / 1000,
  };
  const rate = costs[provider] ?? 0;
  const cost = chars * rate;
  return {
    characters: chars,
    estimatedCost: cost === 0 ? 'FREE (quota)' : `$${cost.toFixed(4)}`,
  };
}

export function estimateTotalCost(panels: Array<{ dialogue: string }>, intro: string, outro: string, provider: string) {
  const allText = [...panels.map(p => p.dialogue), intro, outro].join(' ');
  return estimateTTSCost(allText, provider);
}
