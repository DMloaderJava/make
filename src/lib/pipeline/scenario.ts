/**
 * Сценарий — текстовый формат озвучки:
 *
 *   Изображение 1
 *
 *   Персонаж 1 (Жен.): текст реплики
 *
 *   Изображение 2
 *
 *   Персонаж 2 (Муж.): текст реплики
 *
 * Правила формата:
 * 1. Сначала загружается изображение, затем озвучивается диалог (изображение
 *    показывается на время реплики; таймлайн строится по сегментам панелей).
 * 2. Каждая реплика переводится на нужный язык озвучки (см. translateScenario.ts).
 * 3. После завершения чтения реплики — переход к следующему изображению
 *    через 0,6 секунды (SCENARIO_GAP_SECONDS, задаётся в buildTimeline).
 * 4. Пол персонажа указывается в скобках: (Жен.) или (Муж.).
 * 5. Никакого лишнего текста — только «Изображение N» и реплики.
 * 6. (v1.3.17, опционально) Y-диапазон после номера: «Изображение 1 [0..30%]» —
 *    панель занимает 0–30% высоты картинки (на всю ширину). Без диапазона —
 *    вся картинка (fullFrame). Одна картинка может идти несколькими блоками
 *    с разными диапазонами — так длинная webtoon-полоса режется на панели,
 *    и лента прокручивается синхронно с озвучкой.
 */

import { PanelData } from './extractPanels';
import { rebuildSrt } from './buildTimeline';
import {
  SCENARIO_IMAGE_LABEL,
  formatImageAnchor,
  isWholeRange,
  parseImageAnchor,
  serializableYRange,
} from './scenarioFormat';
import type { Character, Project, SyncTimeline } from '../storage/db';

// Формат якоря вынесен в scenarioFormat.ts (общий с импортом файлов);
// реэкспорт — для существующих импортов из scenario.ts.
export {
  SCENARIO_IMAGE_LABEL,
  formatRangeNum,
  serializableYRange,
  parseImageAnchor,
  panelAnchor,
} from './scenarioFormat';

export type ScenarioGender = 'female' | 'male';

/** Одна реплика сценария. */
export interface ScenarioLine {
  /** 0-индекс изображения: «Изображение N» → N-1. */
  imageIndex: number;
  /** Имя персонажа без пометки пола. */
  character: string;
  /** Пол из скобок; null, если в сценарии не указан. */
  gender: ScenarioGender | null;
  /** Текст реплики. */
  text: string;
  /** Y-диапазон в процентах (0..100). null — вся картинка (fullFrame). */
  yRange: { from: number; to: number } | null;
}

export interface ScenarioParseResult {
  lines: ScenarioLine[];
  /** Жёсткие ошибки: с таким сценарием проект не применяется. */
  errors: string[];
  /** Предупреждения: применение возможно, но стоит обратить внимание. */
  warnings: string[];
}

/** Правило 3: пауза после реплики перед следующим изображением, сек. */
export const SCENARIO_GAP_SECONDS = 0.6;

export function genderLabel(gender: ScenarioGender): string {
  return gender === 'female' ? 'Жен.' : 'Муж.';
}

const GENDERS: Record<string, ScenarioGender> = {
  'жен': 'female',
  'жен.': 'female',
  'ж': 'female',
  'female': 'female',
  'муж': 'male',
  'муж.': 'male',
  'м': 'male',
  'male': 'male',
};

/**
 * Разделитель «Имя — текст», кандидаты ищутся по всей строке:
 * - «:» — с любыми пробелами (включая «Имя: текст» и «Имя : текст»);
 * - длинное/короткое тире — ТОЛЬКО с пробелами с обеих сторон
 *   (иначе режутся имена с тире: «Персонаж—тест»);
 * - обычный дефис — ТОЛЬКО с пробелами с обеих сторон («Персонаж-1» цел).
 * Если имён несколько кандидатов — берём тот, за которым левая часть
 * заканчивается «)»: «Персонаж:1 (Муж.): текст» режется после скобки пола,
 * а не по первому двоеточию.
 */
const SEPARATOR_REGEX = /(?:\s*:\s*|\s+[—–]\s+|\s+-\s+)/;

function splitLine(line: string): { left: string; right: string } | null {
  const candidates: Array<{ index: number; length: number }> = [];
  const re = new RegExp(SEPARATOR_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    candidates.push({ index: match.index, length: match[0].length });
  }
  if (candidates.length === 0) return null;
  const preferred = candidates.find(c => line.slice(0, c.index).trim().endsWith(')')) || candidates[0];
  return {
    left: line.slice(0, preferred.index).trim(),
    right: line.slice(preferred.index + preferred.length).trim(),
  };
}

function parseGender(raw: string | undefined): { gender: ScenarioGender | null; label?: string } {
  if (!raw) return { gender: null };
  const key = raw.trim().toLowerCase();
  const gender = GENDERS[key];
  return { gender: gender ?? null, label: raw.trim() };
}

/**
 * Разбирает текст сценария. Пустые строки — допустимые разделители блоков.
 * Любая строка, которая не «Изображение N» и не «Имя (Пол): текст», — ошибка.
 *
 * Контракт: при errors.length > 0 lines НЕ применяются (ScenarioModal блокирует
 * кнопку и обработчик). Поэтому после битого диапазона номер изображения
 * сохраняется, а yRange = null — это лишь подавляет каскад вторичных ошибок
 * («реплика до первого изображения»), а не превращает реплики в fullFrame.
 */
export function parseScenario(text: string): ScenarioParseResult {
  const lines: ScenarioLine[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  let currentImage: number | null = null;
  let currentYRange: { from: number; to: number } | null = null;

  (text || '').split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line) return;

    // «Изображение N» / «Изображение N [X..Y%]» — разбор общий с импортом.
    // При ошибке диапазона номер сохраняется (если он верный): это лишь
    // подавляет каскад «реплика до первого изображения», а не fullFrame.
    const anchor = parseImageAnchor(line);
    if (anchor) {
      if (anchor.kind === 'error') {
        errors.push(`Строка ${lineNo}: ${anchor.message}`);
        currentImage = anchor.imageIndex;
        currentYRange = null;
      } else {
        currentImage = anchor.imageIndex;
        currentYRange = anchor.yRange;
      }
      return;
    }

    const split = splitLine(line);
    if (!split) {
      errors.push(`Строка ${lineNo}: не реплика (нет разделителя «:», « — » или « - »). В сценарии допускаются только «${SCENARIO_IMAGE_LABEL} N» и реплики «Имя (Пол): текст»`);
      return;
    }
    const { left, right } = split;
    if (!left) {
      errors.push(`Строка ${lineNo}: не указано имя персонажа`);
      return;
    }
    if (!right) {
      errors.push(`Строка ${lineNo}: текст реплики пуст`);
      return;
    }
    if (currentImage === null) {
      errors.push(`Строка ${lineNo}: реплика стоит до первого «${SCENARIO_IMAGE_LABEL} N»`);
      return;
    }

    const leftMatch = left.match(/^([^()]+?)(?:\s*\(([^)]*)\))?$/);
    const character = (leftMatch?.[1] || left).trim();
    if (!character) {
      errors.push(`Строка ${lineNo}: не указано имя персонажа`);
      return;
    }
    const { gender, label } = parseGender(leftMatch?.[2]);
    if (leftMatch?.[2] !== undefined && gender === null) {
      warnings.push(`Строка ${lineNo}: неизвестный пол «${label}» — голос по полу не будет подбираться`);
    } else if (gender === null) {
      warnings.push(`Строка ${lineNo}: пол не указан — формат «${character} (Жен.)» или «${character} (Муж.)»`);
    }

    lines.push({ imageIndex: currentImage, character, gender, text: right, yRange: currentYRange });
  });

  return { lines, errors, warnings };
}

/**
 * Собирает текст сценария из панелей проекта — ровно в том же формате,
 * что и парсер: «Изображение N» (с «[X..Y%]», если у панели реальный bbox),
 * пустая строка, реплики. Лишнего текста нет.
 */
export function serializeScenario(
  panels: Array<{
    dialogue: string;
    character: string;
    imageIndex: number;
    order?: number;
    bbox?: { x: number; y: number; width: number; height: number };
    fullFrame?: boolean;
  }>,
  genders: Record<string, ScenarioGender> = {}
): string {
  const sorted = [...panels].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.imageIndex - b.imageIndex);
  const blocks: string[] = [];
  let lastImage = -1;
  let lastMarker = '';
  let currentBlock: string[] = [];

  const flush = () => {
    if (currentBlock.length > 0) {
      blocks.push(currentBlock.join('\n'));
      currentBlock = [];
    }
  };

  for (const panel of sorted) {
    // X пока не поддерживаем: в сценарий пишется только y-диапазон
    // (клампленный в 0..100 — см. serializableYRange).
    const marker = formatImageAnchor(panel.imageIndex, serializableYRange(panel));

    if (panel.imageIndex !== lastImage || marker !== lastMarker) {
      flush();
      currentBlock.push(marker, '');
      lastImage = panel.imageIndex;
      lastMarker = marker;
    }
    const gender = genders[panel.character];
    const name = gender ? `${panel.character} (${genderLabel(gender)})` : panel.character;
    currentBlock.push(`${name}: ${panel.dialogue}`);
  }
  flush();

  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

/**
 * Панели из сценария: одна реплика — одна панель.
 * - без y-диапазона (или [0..100%]) — панель на всё изображение, fullFrame;
 * - с диапазоном [X..Y%] — bbox {0, X, 100, Y-X}, fullFrame не ставится:
 *   лента прокручивается по bbox панелей (см. mangaStrip.buildStripScrollSpans).
 * Если изображение не загружено — клампим в последнее и говорим об этом.
 */
export function scenarioToPanels(lines: ScenarioLine[], imageCount: number): {
  panels: PanelData[];
  warnings: string[];
} {
  const panels: PanelData[] = [];
  const warnings: string[] = [];

  lines.forEach((line, i) => {
    let imageIndex = line.imageIndex;
    if (imageCount > 0 && imageIndex >= imageCount) {
      imageIndex = imageCount - 1;
      warnings.push(
        `«${SCENARIO_IMAGE_LABEL} ${line.imageIndex + 1}» не загружено (изображений: ${imageCount}) — реплика «${line.character}» привязана к изображению ${imageCount}`
      );
    }
    const range = line.yRange && !isWholeRange(line.yRange) ? line.yRange : null;
    panels.push({
      id: i,
      bbox: range
        ? { x: 0, y: range.from, width: 100, height: range.to - range.from }
        : { x: 0, y: 0, width: 100, height: 100 },
      dialogue: line.text,
      character: line.character,
      emotion: 'neutral',
      type: 'speech',
      order: i,
      imageIndex,
      // Без диапазона: одно изображение = один кадр. Preview/экспорт рисуют
      // contain (letterbox) без зума/панорамы — иначе портрет кропится.
      // С диапазоном — НЕ fullFrame: лента едет по bbox панели.
      fullFrame: range ? undefined : true,
    });
  });

  return { panels, warnings };
}

/**
 * Обновление полей проекта при применении сценария (чистая функция).
 * Сценарий управляет панелями, персонажами и таймлайном — и НЕ трогает
 * интро/аутро: они возвращаются без изменений (правило 5 до v1.3.16
 * очищало их; с v1.3.16 сценарий и подводка — разные сущности).
 */
export interface ScenarioProjectPatch {
  panels: PanelData[];
  characters: Character[];
  timeline: SyncTimeline[];
  srt: string;
  intro: string;
  outro: string;
  introDuration: number;
  outroDuration: number;
  warnings: string[];
}

export function applyScenarioToProject(
  project: Pick<Project, 'panels' | 'characters' | 'intro' | 'outro' | 'introDuration' | 'outroDuration'>,
  lines: ScenarioLine[],
  opts: {
    imagesCount: number;
    panelGap: number;
    voiceAssignments: Record<string, string>;
    /** panelId → длительность. После применения старое аудио удалено — пустой Map. */
    audioDurations?: Map<number, number>;
  }
): ScenarioProjectPatch {
  const { panels, warnings } = scenarioToPanels(lines, opts.imagesCount);

  // Персонажи: существующие сохраняем, пол обновляем/добавляем.
  const charMap = new Map(project.characters.map(c => [c.name, { ...c }]));
  for (const line of lines) {
    const existing = charMap.get(line.character);
    if (existing) {
      if (line.gender) existing.gender = line.gender;
    } else {
      charMap.set(line.character, {
        name: line.character,
        appearance: '',
        voiceId: '',
        emotion: 'neutral',
        gender: line.gender ?? undefined,
      });
    }
  }
  const characters = Array.from(charMap.values());

  // Таймлайн + SRT из ТЕКУЩИХ интро/аутро проекта (rebuildSrt — единая точка).
  const { timeline, srt } = rebuildSrt({
    panels,
    audioDurations: opts.audioDurations ?? new Map(),
    voiceAssignments: opts.voiceAssignments,
    intro: project.intro,
    outro: project.outro,
    introDuration: project.introDuration,
    outroDuration: project.outroDuration,
    panelGap: opts.panelGap,
  });

  return {
    panels,
    characters,
    timeline,
    srt,
    intro: project.intro,
    outro: project.outro,
    introDuration: project.introDuration,
    outroDuration: project.outroDuration,
    warnings,
  };
}

/** Пример формата для кнопки «Пример». */
export const SCENARIO_EXAMPLE = `Изображение 1

Персонаж 1 (Жен.): Привет! Ты готов к сегодняшней вылазке?

Изображение 2

Персонаж 2 (Муж.): Как никогда. Главное — не отставать от группы.

Изображение 3

Персонаж 1 (Жен.): Договорились. Встречаемся у ворот на закате.`;

/**
 * Пример для длинной webtoon-полосы: одна картинка на три панели с
 * y-диапазонами + картинка целиком. Отдельно от базового примера: три раза
 * «Изображение 1» без контекста выглядят как опечатка.
 */
export const SCENARIO_EXAMPLE_STRIP = `Изображение 1 [0..30%]

Персонаж 1 (Жен.): Привет! Ты готов к сегодняшней вылазке?

Изображение 1 [30..60%]

Персонаж 2 (Муж.): Как никогда. Главное — не отставать от группы.

Изображение 1 [60..100%]

Персонаж 1 (Жен.): Договорились. Встречаемся у ворот на закате.

Изображение 2

Персонаж 2 (Муж.): Тогда до вечера.`;
