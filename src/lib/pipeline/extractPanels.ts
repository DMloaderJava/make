import { LLMProvider, LLMOptions } from '../providers/llm/types';
import { VISION_SYSTEM_PROMPT } from '../prompts/vision-prompt';
import { validateVisionResult, normalizeCharacters } from '../validators';

export interface PanelData {
  id: number;
  bbox: { x: number; y: number; width: number; height: number };
  dialogue: string;
  character: string;
  emotion: string;
  type: 'speech' | 'thought' | 'narration' | 'sfx';
  order: number;
  imageIndex: number;
}

export interface VisionResult {
  imageWidth: number;
  imageHeight: number;
  panels: PanelData[];
  sceneDescription: string;
  characters: Array<{ name: string; appearance: string }>;
}

function safeParseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {}
    }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {}
    }
    throw new Error('Vision LLM вернула невалидный JSON: ' + text.slice(0, 500));
  }
}

// Structured output schema for OpenAI-compatible providers
export const VISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    imageWidth: { type: 'number' },
    imageHeight: { type: 'number' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          bbox: {
            type: 'object',
            properties: {
              x: { type: 'number', minimum: 0, maximum: 100 },
              y: { type: 'number', minimum: 0, maximum: 100 },
              width: { type: 'number', minimum: 1, maximum: 100 },
              height: { type: 'number', minimum: 1, maximum: 100 },
            },
            required: ['x', 'y', 'width', 'height']
          },
          dialogue: { type: 'string' },
          character: { type: 'string' },
          emotion: { type: 'string', enum: ['neutral', 'angry', 'happy', 'sad', 'surprised', 'scared', 'thoughtful'] },
          type: { type: 'string', enum: ['speech', 'thought', 'narration', 'sfx'] },
          order: { type: 'number' }
        },
        required: ['id', 'bbox', 'dialogue', 'character', 'emotion', 'type', 'order']
      }
    },
    sceneDescription: { type: 'string' },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          appearance: { type: 'string' }
        },
        required: ['name', 'appearance']
      }
    }
  },
  required: ['panels', 'sceneDescription', 'characters']
};

export async function extractPanels(
  imageBase64: string,
  llm: LLMProvider,
  options: LLMOptions,
  imageIndex: number = 0
): Promise<VisionResult> {
  let resultText: string;
  
  // Try structured output if provider supports it
  const useStructured = ['openai', 'openrouter', 'nvidia-nim', 'groq'].includes(llm.id);
  
  if (llm.vision) {
    try {
      resultText = await llm.vision(imageBase64, VISION_SYSTEM_PROMPT, {
        ...options,
        // json_schema/json_object — теперь реально уходит в тело запроса
        // (см. buildResponseFormat в openai-compatible.ts).
        // strict: false, т.к. схема не помечена additionalProperties: false.
        ...(useStructured ? { responseFormat: { name: 'vision_result', schema: VISION_JSON_SCHEMA, strict: false } } : {})
      });
    } catch (e) {
      // Fallback to chat with image
      const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
      resultText = await llm.chat([
        { role: 'system', content: VISION_SYSTEM_PROMPT },
        { 
          role: 'user', 
          content: [
            { type: 'text', text: 'Проанализируй это изображение и верни JSON по схеме. Отвечай ТОЛЬКО JSON, без markdown.' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ], { ...options, temperature: 0.2 });
    }
  } else {
    const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
    resultText = await llm.chat([
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      { 
        role: 'user', 
        content: [
          { type: 'text', text: 'Проанализируй это изображение и верни JSON по схеме. Отвечай ТОЛЬКО JSON, без markdown.' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ], { ...options, temperature: 0.2 });
  }
  
  const parsed = safeParseJSON(resultText);
  
  // Validate with Zod
  const validation = validateVisionResult(parsed);
  if (!validation.success) {
    console.warn('Vision validation failed, attempting to fix:', validation.errors);
    // Try to fix common issues
    const fixed = attemptFixVisionResult(parsed);
    const revalidation = validateVisionResult(fixed);
    if (!revalidation.success) {
      throw new Error(`Vision validation failed: ${validation.errors?.join(', ')}`);
    }
    return normalizeResult(revalidation.data!, imageIndex);
  }
  
  return normalizeResult(validation.data!, imageIndex);
}

function attemptFixVisionResult(parsed: any): any {
  // Fix common LLM mistakes
  if (!parsed.panels || !Array.isArray(parsed.panels)) {
    parsed.panels = [];
  }
  
  parsed.panels = parsed.panels.map((p: any, idx: number) => ({
    id: typeof p.id === 'number' ? p.id : idx,
    bbox: {
      x: typeof p.bbox?.x === 'number' ? p.bbox.x : (typeof p.bbox?.x === 'string' ? parseFloat(p.bbox.x) || 0 : 0),
      y: typeof p.bbox?.y === 'number' ? p.bbox.y : 0,
      width: typeof p.bbox?.width === 'number' ? p.bbox.width : 100,
      height: typeof p.bbox?.height === 'number' ? p.bbox.height : 100,
    },
    dialogue: String(p.dialogue || ''),
    character: String(p.character || 'Неизвестный'),
    emotion: ['neutral', 'angry', 'happy', 'sad', 'surprised', 'scared', 'thoughtful'].includes(p.emotion) ? p.emotion : 'neutral',
    type: ['speech', 'thought', 'narration', 'sfx'].includes(p.type) ? p.type : 'speech',
    order: typeof p.order === 'number' ? p.order : idx,
  }));

  if (!parsed.sceneDescription) parsed.sceneDescription = 'Сцена из манги';
  if (!parsed.characters) parsed.characters = [];
  if (!parsed.imageWidth) parsed.imageWidth = 100;
  if (!parsed.imageHeight) parsed.imageHeight = 100;

  return parsed;
}

function normalizeResult(validated: any, imageIndex: number): VisionResult {
  const panels: PanelData[] = validated.panels.map((p: any, idx: number) => ({
    id: p.id ?? idx,
    bbox: {
      x: Number(p.bbox?.x ?? 0),
      y: Number(p.bbox?.y ?? 0),
      width: Number(p.bbox?.width ?? 100),
      height: Number(p.bbox?.height ?? 100),
    },
    dialogue: String(p.dialogue || ''),
    character: String(p.character || 'Неизвестный'),
    emotion: String(p.emotion || 'neutral'),
    type: (p.type as any) || 'speech',
    order: Number(p.order ?? idx),
    imageIndex,
  }));

  if (panels.length === 0) {
    panels.push({
      id: 0,
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      dialogue: validated.sceneDescription || 'Сцена без диалога',
      character: 'Рассказчик',
      emotion: 'neutral',
      type: 'narration',
      order: 0,
      imageIndex,
    });
  }

  panels.sort((a, b) => a.order - b.order);

  return {
    imageWidth: Number(validated.imageWidth || 100),
    imageHeight: Number(validated.imageHeight || 100),
    panels,
    sceneDescription: String(validated.sceneDescription || ''),
    characters: validated.characters.map((c: any) => ({
      name: String(c.name || 'Неизвестный'),
      appearance: String(c.appearance || '')
    }))
  };
}

export async function processAllImages(
  images: string[],
  llm: LLMProvider,
  options: LLMOptions,
  onProgress?: (current: number, total: number) => void
): Promise<VisionResult[]> {
  const results: VisionResult[] = [];
  
  // Use TaskQueue for better rate limiting and persistence
  const { TaskQueue } = await import('./taskQueue');
  const queue = new TaskQueue({
    concurrency: 1,
    retryDelay: 2000,
    maxRetries: 2,
    rateLimit: { maxRequests: 10, perMs: 60000 },
    persistKey: `vision-${Date.now()}`, // Vision not persisted across reloads (images change), but keeps progress in session
    onProgress: (completed, total) => {
      onProgress?.(completed, total);
    }
  });

  for (let i = 0; i < images.length; i++) {
    queue.add({
      id: `vision-${i}`,
      fn: () => extractPanels(images[i], llm, { ...options }, i),
      retries: 2
    });
  }

  const resultsMap = await queue.run();
  
  for (let i = 0; i < images.length; i++) {
    const result = resultsMap.get(`vision-${i}`);
    if (result?.success && result.data) {
      results.push(result.data as VisionResult);
    } else {
      console.error(`Failed to process image ${i}:`, result?.error);
      // Add fallback panel
      results.push({
        imageWidth: 100,
        imageHeight: 100,
        panels: [{
          id: i,
          bbox: { x: 0, y: 0, width: 100, height: 100 },
          dialogue: `[Не удалось проанализировать изображение ${i+1}]`,
          character: 'Рассказчик',
          emotion: 'neutral',
          type: 'narration',
          order: 0,
          imageIndex: i
        }],
        sceneDescription: `Изображение ${i+1}`,
        characters: []
      });
    }
  }
  
  return results;
}

export function mergeVisionResults(results: VisionResult[]): {
  allPanels: PanelData[];
  allCharacters: Array<{ name: string; appearance: string }>;
  sceneDescription: string;
} {
  const allPanels: PanelData[] = [];
  const charMap = new Map<string, { name: string; appearance: string }>();
  const descriptions: string[] = [];

  for (const res of results) {
    allPanels.push(...res.panels);
    // Normalize characters to avoid duplicates like Танджиро/Танжиро
    const normalized = normalizeCharacters(res.characters);
    for (const ch of normalized) {
      if (!charMap.has(ch.name)) {
        charMap.set(ch.name, { name: ch.name, appearance: ch.appearance });
      }
    }
    if (res.sceneDescription) descriptions.push(res.sceneDescription);
  }

  allPanels.forEach((p, idx) => {
    p.order = idx;
    p.id = idx;
  });

  return {
    allPanels,
    allCharacters: Array.from(charMap.values()),
    sceneDescription: descriptions.join(' ')
  };
}
