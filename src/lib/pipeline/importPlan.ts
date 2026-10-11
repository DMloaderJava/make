/**
 * План импорта внешних файлов по якорям (v1.3.18).
 *
 * Чистая функция: (файлы, цели, манифест, ручные назначения) → план.
 * Никакого декодирования, OPFS и React — план можно считать на каждый
 * ререндер модалки, а применение (audioImport/imageImport) идёт отдельно.
 * Один и тот же вход всегда даёт один и тот же план.
 *
 * Цели — панели (аудио) или страницы (изображения): генерик знает о них
 * только id, каноничный якорь, подпись и ключ сортировки.
 *
 * Приоритет сопоставления (строгий, сверху вниз):
 *   1. ручное назначение (manualOverrides) — явный выбор в таблице;
 *   2. манифест «Изображение N [X..Y%] = файл»;
 *   3. имя файла = якорь («Изображение 1 [0..30%].mp3»);
 *   4. номер в начале имени («003.mp3», «01 - Аня.wav») → N-я цель по порядку,
 *      если номер есть у ВСЕХ оставшихся файлов;
 *      иначе — natural sort оставшихся файлов 1:1 с оставшимися целями
 *      (количество обязано совпасть — иначе ошибка, а не усечение).
 * Этот порядок — контракт (тесты «приоритет: …» в tests/audioImport.test.ts);
 * менять только вместе с тестами и ТЗ.
 * Конфликт на одном уровне (два файла → одна цель, один файл → две цели,
 * дубль якоря) — ошибка. Более высокий уровень молча вытесняет более низкий.
 */

import { anchorFor, parseImageAnchor } from './scenarioFormat';

export interface ImportFileRef {
  name: string;
  size?: number;
  /** Длительность (аудио), если уже известна — только для отображения. */
  duration?: number;
}

export type ImportVia = 'manual' | 'manifest' | 'name' | 'number' | 'order';

export interface ImportMatch<TTarget> {
  target: TTarget;
  /** Имя файла как загружено (не нормализованное). */
  file: string;
  /** Каноничный якорь цели («Изображение 1 [0..30%]»). */
  anchor: string;
  /** Подпись цели для UI и сообщений. */
  label: string;
  /** Каким правилом сопоставлено — для таблицы и диагностики. */
  via: ImportVia;
}

export interface ImportPlan<TTarget> {
  /** Сопоставления в порядке целей. */
  matches: Array<ImportMatch<TTarget>>;
  /** Файлы без цели (natural sort). */
  unmatchedFiles: string[];
  /** Цели без файла (в порядке целей). */
  unmatchedTargets: TTarget[];
  /** Блокирующие ошибки: при errors.length > 0 план не применяется. */
  errors: string[];
  warnings: string[];
}

export interface ImportNouns {
  /** «панелей» — родительный падеж мн. ч. для «Файлов 4, панелей 5». */
  genitivePlural: string;
  /** «панели» — для «нет панели «…»». */
  genitiveSingular: string;
}

export interface PlanImportOptions<TTarget> {
  files: ImportFileRef[];
  targets: TTarget[];
  /** Уникальный id цели (ключ ручного назначения). */
  targetId: (t: TTarget) => string;
  /** Каноничный якорь (scenarioFormat.panelAnchor / anchorFor). */
  targetAnchor: (t: TTarget) => string;
  targetLabel: (t: TTarget) => string;
  /** Ключ сортировки целей; позиция N для «003.mp3» — N-я цель в этом порядке. */
  targetOrder: (t: TTarget) => readonly number[];
  manifest?: string;
  /** Имя файла → id цели (ручной выбор в таблице). */
  manualOverrides?: ReadonlyMap<string, string>;
  /** Имя файла как якорь (по умолчанию true). */
  allowNameAnchor?: boolean;
  /** Номер/порядок для оставшихся файлов (по умолчанию true). */
  useOrder?: boolean;
  nouns?: ImportNouns;
}

const DEFAULT_NOUNS: ImportNouns = { genitivePlural: 'панелей', genitiveSingular: 'панели' };

/**
 * Natural sort: «2.mp3» < «10.mp3», «001» ≡ «1» по значению.
 *
 * Без Intl.Collator/localeCompare: их порядок зависит от версии ICU/CLDR
 * (Node в CI и Chrome у пользователя могли бы разложить файлы по-разному),
 * а план обязан быть детерминированным. Правила:
 * - имя режется на куски «цифры» / «не цифры»;
 * - цифры сравниваются как числа любой длины (без parseInt и переполнения),
 *   числовой кусок раньше текстового;
 * - текст — без учёта регистра (toLowerCase не зависит от локали), «ё» = «е»,
 *   затем по кодовым точкам;
 * - при полном равенстве (регистр, ведущие нули) — по кодовым точкам исходных
 *   строк: порядок полный, равных разных имён нет.
 */
export function naturalCompare(a: string, b: string): number {
  const ca = a.match(/\d+|\D+/g) ?? [];
  const cb = b.match(/\d+|\D+/g) ?? [];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const d = compareChunk(ca[i], cb[i]);
    if (d !== 0) return d;
  }
  if (ca.length !== cb.length) return ca.length - cb.length;
  return codePointCompare(a, b);
}

function isDigits(s: string): boolean {
  return s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57;
}

function compareChunk(x: string, y: string): number {
  const dx = isDigits(x);
  const dy = isDigits(y);
  if (dx && dy) {
    const nx = x.replace(/^0+(?=\d)/, '');
    const ny = y.replace(/^0+(?=\d)/, '');
    if (nx.length !== ny.length) return nx.length - ny.length;
    return codePointCompare(nx, ny);
  }
  if (dx !== dy) return dx ? -1 : 1;
  return codePointCompare(foldText(x), foldText(y));
}

function foldText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е');
}

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** NFC: macOS отдаёт имена файлов в NFD («й» = «и» + «̆»), манифест набран в NFC. */
function nfc(s: string): string {
  return s.normalize('NFC');
}

/** Имя без расширения: «Изображение 1 [12.5..40%].mp3» → «Изображение 1 [12.5..40%]». */
export function fileStem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Номер в начале имени: «003» → 3, «01 - Аня» → 1, «7_take» → 7; иначе null. */
export function leadingNumber(name: string): number | null {
  const m = fileStem(nfc(name)).trim().match(/^(\d+)(?=$|[\s._\-–—()[\]])/);
  return m ? parseInt(m[1], 10) : null;
}

/** Похоже на интро/аутро: такие файлы не раскладываются по панелям по порядку. */
export function looksLikeIntroOutro(name: string): boolean {
  return /^(intro|outro|интро|аутро)(?=$|[\s._\-–—()[\]\d])/i.test(fileStem(nfc(name)).trim());
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('«') && t.endsWith('»')))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

export interface ManifestLine {
  lineNo: number;
  /** Сырой текст якоря (до «=»). */
  anchorText: string;
  file: string;
}

/**
 * Разбор манифеста «<якорь> = <файл>». Пустые строки и «#»-комментарии
 * пропускаются. Делим по ПЕРВОМУ «=»: в якоре его не бывает, а в имени
 * файла — может. Имя можно взять в кавычки.
 */
export function parseManifest(text: string): { lines: ManifestLine[]; errors: string[] } {
  const lines: ManifestLine[] = [];
  const errors: string[] = [];
  (text || '').split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    const anchorText = eq === -1 ? line : line.slice(0, eq).trim();
    const file = eq === -1 ? '' : stripQuotes(line.slice(eq + 1));
    if (eq === -1 || !parseImageAnchor(anchorText)) {
      errors.push(`Манифест, строка ${lineNo}: не разобран якорь — формат «Изображение N [X..Y%] = файл»`);
      return;
    }
    if (!file) {
      errors.push(`Манифест, строка ${lineNo}: не указан файл после «=»`);
      return;
    }
    lines.push({ lineNo, anchorText, file });
  });
  return { lines, errors };
}

export function planImport<TTarget>(opts: PlanImportOptions<TTarget>): ImportPlan<TTarget> {
  const nouns = opts.nouns ?? DEFAULT_NOUNS;
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Цели: порядок, позиции, якоря ---
  const sortedTargets = opts.targets
    .map((target, index) => ({ target, index, order: opts.targetOrder(target) }))
    .sort((a, b) => {
      const len = Math.max(a.order.length, b.order.length);
      for (let i = 0; i < len; i++) {
        const d = (a.order[i] ?? 0) - (b.order[i] ?? 0);
        if (d !== 0) return d;
      }
      return a.index - b.index;
    })
    .map(e => e.target);
  const idOf = new Map<TTarget, string>(sortedTargets.map(t => [t, opts.targetId(t)]));
  const byId = new Map<string, TTarget>(sortedTargets.map(t => [idOf.get(t)!, t]));
  const anchorOf = new Map<TTarget, string>(sortedTargets.map(t => [t, opts.targetAnchor(t)]));
  const byAnchor = new Map<string, TTarget[]>();
  for (const t of sortedTargets) {
    const a = anchorOf.get(t)!;
    const list = byAnchor.get(a);
    if (list) list.push(t);
    else byAnchor.set(a, [t]);
  }
  const labelOf = (t: TTarget) => opts.targetLabel(t);

  // --- Файлы: нормализация, дубли имён ---
  const files = [...opts.files].sort((a, b) => naturalCompare(nfc(a.name), nfc(b.name)));
  const fileByNfc = new Map<string, string>();
  for (const f of files) {
    const key = nfc(f.name);
    if (fileByNfc.has(key)) errors.push(`Файл «${f.name}» загружен дважды — оставьте один`);
    else fileByNfc.set(key, f.name);
  }
  const fileNames = [...fileByNfc.values()];

  const empty = (): ImportPlan<TTarget> => ({ matches: [], unmatchedFiles: [], unmatchedTargets: [...sortedTargets], errors, warnings });
  if (fileNames.length === 0) return empty();
  if (sortedTargets.length === 0) {
    errors.push(`В проекте нет ${nouns.genitivePlural} — сопоставлять файлы не с чем`);
    return { ...empty(), unmatchedFiles: fileNames };
  }

  /** Имя из манифеста/ручного выбора → загруженный файл (точно, затем без учёта регистра). */
  const resolveFile = (name: string): string | null => {
    const key = nfc(name.trim());
    const exact = fileByNfc.get(key);
    if (exact) return exact;
    const lower = key.toLocaleLowerCase('ru');
    const ci = fileNames.filter(f => nfc(f).toLocaleLowerCase('ru') === lower);
    return ci.length === 1 ? ci[0] : null;
  };

  // --- Сопоставления ---
  const targetTaken = new Map<string, { file: string; via: ImportVia }>(); // targetId → файл
  const fileTaken = new Map<string, { targetId: string; via: ImportVia }>(); // файл → targetId
  const matches: Array<ImportMatch<TTarget>> = [];

  const add = (file: string, target: TTarget, via: ImportVia) => {
    const id = idOf.get(target)!;
    targetTaken.set(id, { file, via });
    fileTaken.set(file, { targetId: id, via });
    matches.push({ target, file, anchor: anchorOf.get(target)!, label: labelOf(target), via });
  };

  /**
   * Претензия файла на цель. Конфликт с тем же уровнем (или с уровнями ниже
   * ручного) — ошибка; ручное назначение вытесняет остальных молча.
   */
  const claim = (file: string, target: TTarget, via: ImportVia): boolean => {
    const id = idOf.get(target)!;
    const prevFile = fileTaken.get(file);
    if (prevFile) {
      if (prevFile.via === 'manual' && via !== 'manual') return false;
      if (prevFile.targetId !== id) {
        errors.push(`Файл «${file}» указан для двух целей: «${labelOf(byId.get(prevFile.targetId)!)}» и «${labelOf(target)}»`);
      }
      return false;
    }
    const prevTarget = targetTaken.get(id);
    if (prevTarget) {
      if (prevTarget.via === 'manual' && via !== 'manual') return false;
      const many = (byAnchor.get(anchorOf.get(target)!) ?? []).length;
      const hint = many > 1 && (via === 'manifest' || via === 'name')
        ? ` (под этим якорем ${nouns.genitivePlural} ${many} — сопоставьте по номеру файла или вручную)`
        : '';
      errors.push(`Дубль: «${prevTarget.file}» и «${file}» претендуют на «${labelOf(target)}»${hint}`);
      return false;
    }
    add(file, target, via);
    return true;
  };

  // 1. Ручные назначения (детерминированно — по имени файла).
  const manual = [...(opts.manualOverrides ?? new Map<string, string>()).entries()]
    .sort((a, b) => naturalCompare(nfc(a[0]), nfc(b[0])));
  for (const [rawFile, targetId] of manual) {
    const file = resolveFile(rawFile);
    if (!file) {
      errors.push(`Ручное сопоставление: файл «${rawFile}» не найден среди загруженных`);
      continue;
    }
    const target = byId.get(targetId);
    if (!target) {
      errors.push(`Ручное сопоставление: цель для «${file}» больше не существует — выберите заново`);
      continue;
    }
    claim(file, target, 'manual');
  }

  /**
   * Якорь (из манифеста или имени файла) → цель. Под одним якорем может быть
   * несколько целей (несколько реплик в одной полосе) — берём первую по порядку
   * и предупреждаем; второй файл на тот же якорь — дубль (ошибка).
   */
  const anchorClaims = new Map<string, string>(); // якорь → первый файл
  const claimAnchor = (file: string, anchor: string, via: 'manifest' | 'name', where: string) => {
    const list = byAnchor.get(anchor);
    if (!list || list.length === 0) {
      errors.push(`${where}: нет ${nouns.genitiveSingular} «${anchor}»`);
      return;
    }
    const prev = anchorClaims.get(anchor);
    if (prev === file) return; // повтор той же строки — не конфликт
    if (prev) {
      const many = list.length > 1 ? ` (под этим якорем ${nouns.genitivePlural} ${list.length} — сопоставьте по номеру файла или вручную)` : '';
      errors.push(`Дубль: «${prev}» и «${file}» претендуют на «${anchor}»${many}`);
      return;
    }
    anchorClaims.set(anchor, file);
    const manualTarget = list.find(t => targetTaken.get(idOf.get(t)!)?.via === 'manual');
    const target = list.find(t => !targetTaken.has(idOf.get(t)!)) ?? manualTarget ?? list[0];
    if (claim(file, target, via) && list.length > 1) {
      warnings.push(`«${anchor}»: под якорем ${nouns.genitivePlural} ${list.length} — файл «${file}» привязан к первой по порядку («${labelOf(target)}»)`);
    }
  };

  // 2. Манифест.
  if (opts.manifest && opts.manifest.trim()) {
    const parsed = parseManifest(opts.manifest);
    errors.push(...parsed.errors);
    for (const line of parsed.lines) {
      const where = `Манифест, строка ${line.lineNo}`;
      const anchor = parseImageAnchor(line.anchorText);
      if (!anchor) continue; // уже ошибка в parseManifest
      if (anchor.kind === 'error') {
        errors.push(`${where}: ${anchor.message}`);
        continue;
      }
      const file = resolveFile(line.file);
      if (!file) {
        errors.push(`Манифест: файл «${line.file}» не найден среди загруженных`);
        continue;
      }
      if (fileTaken.get(file)?.via === 'manual') continue; // ручной выбор важнее
      claimAnchor(file, anchorFor(anchor.imageIndex, anchor.yRange), 'manifest', where);
    }
  }

  // 3. Имя файла = якорь.
  if (opts.allowNameAnchor !== false) {
    for (const file of fileNames) {
      if (fileTaken.has(file)) continue;
      const anchor = parseImageAnchor(fileStem(nfc(file)));
      if (!anchor) continue;
      if (anchor.kind === 'error') {
        errors.push(`Файл «${file}»: ${anchor.message}`);
        continue;
      }
      claimAnchor(file, anchorFor(anchor.imageIndex, anchor.yRange), 'name', `Файл «${file}»`);
    }
  }

  // 4. Номер / порядок для оставшихся.
  if (opts.useOrder !== false) {
    const rest: string[] = [];
    for (const file of fileNames) {
      if (fileTaken.has(file)) continue;
      if (parseImageAnchor(fileStem(nfc(file)))) continue; // якорный файл с ошибкой — уже в errors
      if (looksLikeIntroOutro(file)) {
        warnings.push(`Файл «${file}» похож на интро/аутро — по порядку не раскладывается`);
        continue;
      }
      rest.push(file);
    }
    if (rest.length > 0) {
      const numbers = rest.map(leadingNumber);
      if (numbers.every(n => n !== null)) {
        // Номер = позиция цели (1-based) в общем порядке: пропуски безопасны.
        const total = sortedTargets.length;
        rest.forEach((file, i) => {
          const n = numbers[i]!;
          if (n < 1 || n > total) {
            errors.push(`Файл «${file}»: номер ${n} вне 1..${total} (${nouns.genitivePlural} в проекте: ${total}) — переименуйте файл или сопоставьте вручную`);
            return;
          }
          claim(file, sortedTargets[n - 1], 'number');
        });
      } else {
        const free = sortedTargets.filter(t => !targetTaken.has(idOf.get(t)!));
        if (free.length !== rest.length) {
          const partial = matches.length > 0;
          errors.push(partial
            ? `Несопоставленных файлов ${rest.length}, ${nouns.genitivePlural} без файла ${free.length} — сопоставьте вручную или добавьте манифест`
            : `Файлов ${rest.length}, ${nouns.genitivePlural} ${free.length} — сопоставьте вручную или добавьте манифест`);
        } else {
          rest.forEach((file, i) => claim(file, free[i], 'order'));
        }
      }
    }
  }

  // --- Итог ---
  const position = new Map<TTarget, number>(sortedTargets.map((t, i) => [t, i]));
  matches.sort((a, b) => position.get(a.target)! - position.get(b.target)!);
  const unmatchedFiles = fileNames.filter(f => !fileTaken.has(f));
  for (const f of unmatchedFiles) {
    if (!looksLikeIntroOutro(f) || opts.useOrder === false) warnings.push(`Файл «${f}» не сопоставлен`);
  }
  const unmatchedTargets = sortedTargets.filter(t => !targetTaken.has(idOf.get(t)!));

  return { matches, unmatchedFiles, unmatchedTargets, errors, warnings };
}
