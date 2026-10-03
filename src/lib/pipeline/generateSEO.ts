import { LLMProvider, LLMOptions } from '../providers/llm/types';
import { SEO_SYSTEM_PROMPT, SEO_USER_PROMPT } from '../prompts/seo-prompt';
import { SEOPackage } from '../storage/db';
import { validateSEOPackage } from '../validators';

function safeParseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {}
    }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last !== -1) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {}
    }
    throw new Error('SEO LLM вернула невалидный JSON: ' + text.slice(0, 800));
  }
}

export const SEO_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'object',
      properties: {
        main: { type: 'string', minLength: 10, maxLength: 100 },
        alternatives: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 }
      },
      required: ['main', 'alternatives']
    },
    description: {
      type: 'object',
      properties: {
        hook: { type: 'string', minLength: 20, maxLength: 200 },
        body: { type: 'string', minLength: 100 },
        hashtags: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 }
      },
      required: ['hook', 'body', 'hashtags']
    },
    tags: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 30 },
    thumbnail: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        textOverlay: { type: 'string' },
        emotion: { type: 'string' }
      },
      required: ['prompt', 'textOverlay', 'emotion']
    },
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          title: { type: 'string' }
        },
        required: ['time', 'title']
      },
      minItems: 3
    },
    publishTime: { type: 'string' },
    pinnedComment: { type: 'string' }
  },
  required: ['title', 'description', 'tags', 'thumbnail', 'chapters', 'publishTime', 'pinnedComment']
};

export async function generateSEO(
  sceneDescription: string,
  characters: string[],
  duration: number,
  llm: LLMProvider,
  options: LLMOptions
): Promise<SEOPackage> {
  const messages = [
    { role: 'system' as const, content: SEO_SYSTEM_PROMPT },
    { role: 'user' as const, content: SEO_USER_PROMPT(sceneDescription, characters, duration) }
  ];
  
  const result = await llm.chat(messages, {
    ...options,
    temperature: 0.7,
    maxTokens: 4000,
    responseFormat: { name: 'seo_package', schema: SEO_JSON_SCHEMA, strict: false }
  });
  
  const parsed = safeParseJSON(result);
  
  // Validate with Zod
  const validation = validateSEOPackage(parsed);
  if (!validation.success) {
    console.warn('SEO validation failed:', validation.errors);
    // Try to fix or throw
    throw new Error(`SEO validation failed: ${validation.errors?.join(', ')}`);
  }

  return validation.data as SEOPackage;
}

export function generateFallbackSEO(sceneDescription: string, characters: string[], duration: number): SEOPackage {
  const mins = Math.floor(duration / 60);
  return {
    title: {
      main: `Озвучка манги: ${characters[0] || 'герои'} — сцена, от которой мурашки | ${mins} минут погружения`,
      alternatives: [
        `Что скрывает эта сцена манги? Разбор с озвучкой`,
        `Манга, которую вы должны услышать: ${mins} минут эмоций`,
        `Озвучка манги, от которой не оторваться — ${characters.join(', ')}`
      ]
    },
    description: {
      hook: `Погрузитесь в эмоциональную сцену манги с профессиональной озвучкой. ${sceneDescription.slice(0, 100)}...`,
      body: `${sceneDescription}\n\nВ этом видео вы услышите озвучку персонажей: ${characters.join(', ')}.\nКаждая реплика — с эмоцией, каждый момент — с душой.\n\nТайм-коды:\n00:00 — Интро\n00:35 — Начало сцены\n\nПодписывайтесь, чтобы не пропустить новые озвучки!\nСсылка на канал — в шапке профиля.\n\n#манга #озвучка #аниме`,
      hashtags: ['#манга', '#озвучка', '#аниме', '#манхва', '#manga']
    },
    tags: ['манга', 'озвучка манги', 'манга озвучка', 'аниме', 'манхва', 'manga dub', 'озвучка аниме', ...characters],
    thumbnail: {
      prompt: `manga anime style, dramatic close-up of characters ${characters.join(', ')}, emotional intense expression, cinematic lighting, vibrant colors, ultra detailed, 16:9`,
      textOverlay: 'МУРАШКИ!',
      emotion: 'драма, напряжение'
    },
    chapters: [
      { time: '00:00', title: 'Интро — что нас ждёт?' },
      { time: '00:35', title: 'Начало сцены' },
      { time: `01:30`, title: 'Кульминация' },
      { time: `${String(Math.max(0, Math.floor(duration/60)-1)).padStart(2,'0')}:00`, title: 'Финал и мысли' },
    ],
    publishTime: 'вторник, 19:00 МСК и пятница, 18:00 МСК',
    pinnedComment: `Как вам озвучка? Какой момент зацепил больше всего? Пишите в комментах — озвучу ваши любимые сцены! Не забудьте подписаться 👇`
  };
}

export function formatSEOPackage(seo: SEOPackage): string {
  return `=== YOUTUBE SEO ПАКЕТ ===

ЗАГОЛОВОК (основной):
${seo.title.main}

АЛЬТЕРНАТИВНЫЕ ЗАГОЛОВКИ:
${seo.title.alternatives.map((t, i) => `${i+1}. ${t}`).join('\n')}

ОПИСАНИЕ:
${seo.description.hook}

${seo.description.body}

ХЭШТЕГИ:
${seo.description.hashtags.join(' ')}

ТЕГИ (15-20):
${seo.tags.join(', ')}

ПРЕВЬЮ:
- Промт: ${seo.thumbnail.prompt}
- Текст: ${seo.thumbnail.textOverlay}
- Эмоция: ${seo.thumbnail.emotion}

ТАЙМ-КОДЫ:
${seo.chapters.map(c => `${c.time} — ${c.title}`).join('\n')}

ЛУЧШЕЕ ВРЕМЯ ПУБЛИКАЦИИ:
${seo.publishTime}

ЗАКРЕПЛЁННЫЙ КОММЕНТАРИЙ:
${seo.pinnedComment}
`;
}
