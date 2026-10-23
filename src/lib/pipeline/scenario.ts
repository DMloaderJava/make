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
 * 5. Никакого лишнего текста — только «Изображение N» и реплики. Реплика может
 *    занимать несколько строк: жёсткие переносы и пустые строки (вставка из
 *    чата/документа) склеиваются в один текст — новый блок начинают только
 *    метка изображения и подпись «Имя (Пол):».
 * 6. (опционально) Y-диапазон после номера: «Изображение 1 [0..30%]» —
 *    панель занимает 0–30% высоты картинки (на всю ширину). Без диапазона —
 *    вся картинка (fullFrame). Одна картинка может идти несколькими блоками
 *    с разными диапазонами — так длинная webtoon-полоса режется на панели,
 *    и лента прокручивается синхронно с озвучкой.
 */

import { PanelData } from './extractPanels';
import { rebuildSrt } from './buildTimeline';
import { CURRENT_TIMELINE_VERSION } from '../storage/db';
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

function splitLine(line: string): { left: string; right: string; separator: 'colon' | 'dash' } | null {
  const candidates: Array<{ index: number; length: number; separator: 'colon' | 'dash' }> = [];
  const re = new RegExp(SEPARATOR_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    candidates.push({
      index: match.index,
      length: match[0].length,
      separator: match[0].includes(':') ? 'colon' : 'dash',
    });
  }
  if (candidates.length === 0) return null;
  const preferred = candidates.find(c => line.slice(0, c.index).trim().endsWith(')')) || candidates[0];
  return {
    left: line.slice(0, preferred.index).trim(),
    right: line.slice(preferred.index + preferred.length).trim(),
    separator: preferred.separator,
  };
}

function parseGender(raw: string | undefined): { gender: ScenarioGender | null; label?: string } {
  if (!raw) return { gender: null };
  const key = raw.trim().toLowerCase();
  const gender = GENDERS[key];
  return { gender: gender ?? null, label: raw.trim() };
}

/**
 * Похожа ли левая часть разделителя на подпись персонажа, а не на кусок
 * предложения. Нужна, чтобы отличить реплику от мягкого переноса, в котором
 * случайно оказалось тире или двоеточие:
 *
 *   ещё один шанс — вы сгорите в том же аду!   → продолжение реплики
 *   Герой (Муж.): ...                          → новая реплика
 *
 * Признаки подписи: пол/уточнение в скобках, одно слово (перед двоеточием —
 * даже строчными) или несколько слов, каждое из которых начинается с
 * заглавной («Герой / Антагонист», «Персонаж 1»). Знаки конца предложения и
 * запятые — не имя.
 */
function looksLikeCharacterHeader(left: string, separator: 'colon' | 'dash'): boolean {
  const value = left.trim();
  if (!value || value.length > 80) return false;
  // Пол/уточнение в скобках отбрасываем до проверки знаков: «(Муж.)» —
  // это сокращение с точкой, а не конец предложения.
  const name = value.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (!name || /[.!?…,;]/.test(name)) return false;
  const words = name.split(/\s+/);
  // Одно слово перед двоеточием — подпись даже строчными: имена из vision
  // бывают строчными, а сериализатор пишет реплики именно через «:».
  if (words.length === 1) return separator === 'colon' || /^[A-ZА-ЯЁ0-9«"'(]/.test(words[0]);
  return words.every(word => word === 'и' || word === 'and' || /^[A-ZА-ЯЁ0-9/&«"'-]/.test(word));
}

/** Сколько строк перечислять в предупреждении о склейке переносов. */
const CONTINUATION_WARNING_LINES = 8;

/**
 * Склеивает мягкий перенос с текстом реплики: перенос по дефису — без
 * пробела («ка-» + «кой»), обычный перенос — через пробел.
 */
function joinContinuation(text: string, continuation: string): string {
  return /[-\u2010\u2011\u00AD]$/.test(text) ? text + continuation : `${text} ${continuation}`;
}

/** Компактный список номеров строк: «4, 9, … и ещё 10». */
function formatLineList(lineNumbers: number[]): string {
  const head = lineNumbers.slice(0, CONTINUATION_WARNING_LINES).join(', ');
  const rest = lineNumbers.length - CONTINUATION_WARNING_LINES;
  return rest > 0 ? `${head} и ещё ${rest}` : head;
}

/**
 * Разбирает текст сценария. Пустые строки парсер игнорирует — их можно
 * ставить где угодно, в том числе между строк одной реплики.
 *
 * Реплика может занимать несколько строк: жёсткий перенос из чата/документа
 * (часто с пустой строкой после каждой строки) склеивается в один текст.
 * Строка продолжения отличается от новой реплики по левой части разделителя
 * (см. looksLikeCharacterHeader), поэтому тире и двоеточие внутри
 * перенесённого предложения не режут его на «персонажа» и «текст». Метка
 * изображения всегда прерывает реплику; новая реплика начинается с подписи
 * «Имя (Пол):».
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
  /** Номера строк, склеенных с предыдущей репликой (для предупреждения). */
  const continuationLines: number[] = [];

  let currentImage: number | null = null;
  let currentYRange: { from: number; to: number } | null = null;
  /** Последняя реплика — к ней дописываются мягкие переносы. */
  let lastSpeech: ScenarioLine | null = null;

  const applyAnchor = (anchor: NonNullable<ReturnType<typeof parseImageAnchor>>, lineNo: number) => {
    // Метка изображения закрывает предыдущую реплику: строки после неё —
    // уже не её продолжение.
    lastSpeech = null;
    if (anchor.kind === 'error') {
      errors.push(`Строка ${lineNo}: ${anchor.message}`);
      currentImage = anchor.imageIndex;
      currentYRange = null;
    } else {
      currentImage = anchor.imageIndex;
      currentYRange = anchor.yRange;
    }
  };

  // BOM из буфера обмена не должен ломать первую метку изображения.
  (text || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line) return;

    // «Изображение N» / «Изображение N [X..Y%]» — разбор общий с импортом.
    // При ошибке диапазона номер сохраняется (если он верный): это лишь
    // подавляет каскад «реплика до первого изображения», а не fullFrame.
    const anchor = parseImageAnchor(line);
    if (anchor) {
      applyAnchor(anchor, lineNo);
      return;
    }

    const split = splitLine(line);

    // «Герой / Антагонист (Император и Ларс): Изображение 4 [50..100%]» —
    // метка изображения оказалась в одной строке с именем. Имя здесь — не
    // реплика (текста нет), поэтому метка важнее: иначе диапазон попадёт в
    // озвучку как текст.
    if (split && split.left && split.right) {
      const embedded = parseImageAnchor(split.right);
      if (embedded?.kind === 'ok') {
        warnings.unshift(
          `Строка ${lineNo}: «${split.right}» — метка изображения, а не текст реплики; имя «${split.left}» перед ней не озвучивается`
        );
        applyAnchor(embedded, lineNo);
        return;
      }
    }

    // Строка после реплики без «подписи персонажа» — мягкий перенос, даже
    // если в ней есть « — » или «:»: «… шанс — вы сгорите …» не должно стать
    // репликой персонажа «… шанс». Метка изображения и подпись начинают
    // новый блок, всё остальное дописывается к текущей реплике.
    const isContinuation =
      lastSpeech !== null && (!split || !looksLikeCharacterHeader(split.left, split.separator));
    if (isContinuation && lastSpeech) {
      lastSpeech.text = joinContinuation(lastSpeech.text, line);
      continuationLines.push(lineNo);
      return;
    }

    if (!split) {
      errors.push(
        `Строка ${lineNo}: не реплика (нет разделителя «:», « — » или « - »). В сценарии допускаются только «${SCENARIO_IMAGE_LABEL} N» и реплики «Имя (Пол): текст»`
      );
      lastSpeech = null;
      return;
    }

    const { left, right } = split;
    if (!left) {
      errors.push(`Строка ${lineNo}: не указано имя персонажа`);
      lastSpeech = null;
      return;
    }
    if (!right) {
      errors.push(`Строка ${lineNo}: текст реплики пуст`);
      lastSpeech = null;
      return;
    }
    if (currentImage === null) {
      errors.push(`Строка ${lineNo}: реплика стоит до первого «${SCENARIO_IMAGE_LABEL} N»`);
      lastSpeech = null;
      return;
    }

    const leftMatch = left.match(/^([^()]+?)(?:\s*\(([^)]*)\))?$/);
    const character = (leftMatch?.[1] || left).trim();
    if (!character) {
      errors.push(`Строка ${lineNo}: не указано имя персонажа`);
      lastSpeech = null;
      return;
    }
    const { gender, label } = parseGender(leftMatch?.[2]);
    if (leftMatch?.[2] !== undefined && gender === null) {
      warnings.push(`Строка ${lineNo}: неизвестный пол «${label}» — голос по полу не будет подбираться`);
    } else if (gender === null) {
      warnings.push(`Строка ${lineNo}: пол не указан — формат «${character} (Жен.)» или «${character} (Муж.)»`);
    }

    const speech: ScenarioLine = { imageIndex: currentImage, character, gender, text: right, yRange: currentYRange };
    lines.push(speech);
    lastSpeech = speech;
  });

  if (continuationLines.length > 0) {
    warnings.unshift(
      `Переносы строк внутри реплик склеены: ${continuationLines.length} (строки ${formatLineList(continuationLines)}); пустые строки парсер игнорирует`
    );
  }

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
 * интро/аутро: они возвращаются без изменений (правило 5: сценарий и
 * подводка — разные сущности).
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
  timelineVersion: number;
  warnings: string[];
}

export function applyScenarioToProject(
  project: Pick<Project, 'panels' | 'characters' | 'intro' | 'outro' | 'introDuration' | 'outroDuration'> & {
    timelineVersion?: number;
  },
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
    timelineVersion: (project.timelineVersion ?? CURRENT_TIMELINE_VERSION) + 1,
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
