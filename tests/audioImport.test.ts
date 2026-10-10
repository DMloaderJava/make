/**
 * v1.3.18 — импорт аудио по якорям: план (planImport + planAudioImport,
 * чистые функции) и применение (applyAudioImport: in-memory OPFS из
 * fixtures/browserEnv, декод подменяется — проверяются параллельность,
 * отмена, ошибки и ключ хранения).
 */
import './fixtures/browserEnv';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PanelData } from '../src/lib/pipeline/extractPanels';
import { applyAudioImport, clearImportMark, markPanelsImported, planAudioImport } from '../src/lib/pipeline/audioImport';
import { getProjectAudioSignature, loadProjectAudio, saveProjectAudio, saveProjectAudioSignature } from '../src/lib/storage/opfs';
import { leadingNumber, naturalCompare, parseManifest, planImport } from '../src/lib/pipeline/importPlan';
import { serializeScenario } from '../src/lib/pipeline/scenario';

function panel(id: number, imageIndex: number, y: number | null, h = 30, character = `Герой${id}`, order = id): PanelData {
  return {
    id,
    imageIndex,
    order,
    bbox: y === null ? { x: 0, y: 0, width: 100, height: 100 } : { x: 0, y, width: 100, height: h },
    fullFrame: y === null ? true : undefined,
    dialogue: `Реплика ${id}`,
    character,
    emotion: 'neutral',
    type: 'speech',
  };
}

/** Три полосы на изображении 1 + всё изображение 2. */
const PANELS: PanelData[] = [
  panel(1, 0, 0, 30, 'Аня'),
  panel(2, 0, 30, 30, 'Борис'),
  panel(3, 0, 60, 40, 'Аня'),
  panel(4, 1, null, 100, 'Рассказчик'),
];

const files = (...names: string[]) => names.map(name => ({ name }));
const pairs = (plan: { matches: Array<{ target: PanelData; file: string }> }) =>
  plan.matches.map(m => [m.target.id, m.file] as const);

// ---------- Манифест ----------

test('манифест: комментарии и пустые строки пропускаются, якоря — в любой записи', () => {
  const manifest = [
    '# озвучка для главы 1',
    '',
    'Изображение 1 [0..30%] = аня_привет.mp3',
    'изображение 1 [ 30 .. 60 ] = борис.wav   ',
    'Изображение 1 [60..100%] = "аня 2.m4a"',
    'Изображение 2 = рассказ.ogg',
  ].join('\n');
  const plan = planAudioImport(files('борис.wav', 'аня 2.m4a', 'рассказ.ogg', 'аня_привет.mp3'), PANELS, { manifest });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, 'аня_привет.mp3'], [2, 'борис.wav'], [3, 'аня 2.m4a'], [4, 'рассказ.ogg']]);
  assert.ok(plan.matches.every(m => m.via === 'manifest'));
  assert.deepEqual(plan.unmatchedFiles, []);
  assert.deepEqual(plan.unmatchedTargets, []);
});

test('манифест: битая строка, отсутствующий файл, нет такой панели — ошибки с номером строки', () => {
  const manifest = [
    'Изображение 1 [0..30%] a.mp3',          // нет «=»
    'Картинка 1 = a.mp3',                    // не якорь
    'Изображение 1 [50..50%] = a.mp3',       // начало ≥ конца
    'Изображение 1 [0..30%] = нет_такого.mp3',
    'Изображение 3 = a.mp3',                 // изображения 3 нет
    'Изображение 2 =',
  ].join('\n');
  const plan = planAudioImport(files('a.mp3'), PANELS, { manifest, useOrder: false });
  assert.deepEqual(plan.errors, [
    'Манифест, строка 1: не разобран якорь — формат «Изображение N [X..Y%] = файл»',
    'Манифест, строка 2: не разобран якорь — формат «Изображение N [X..Y%] = файл»',
    'Манифест, строка 6: не указан файл после «=»',
    'Манифест, строка 3: в [50..50%] начало должно быть меньше конца',
    'Манифест: файл «нет_такого.mp3» не найден среди загруженных',
    'Манифест, строка 5: нет панели «Изображение 3»',
  ]);
});

test('манифест: дубль якоря и один файл на две панели — ошибки', () => {
  const dupAnchor = planAudioImport(files('a.mp3', 'b.mp3'), PANELS, {
    manifest: 'Изображение 1 [0..30%] = a.mp3\nИзображение 1 [0..30,0%] = b.mp3',
    useOrder: false,
  });
  assert.deepEqual(dupAnchor.errors, ['Дубль: «a.mp3» и «b.mp3» претендуют на «Изображение 1 [0..30%]»']);

  const twoTargets = planAudioImport(files('a.mp3'), PANELS, {
    manifest: 'Изображение 1 [0..30%] = a.mp3\nИзображение 2 = a.mp3',
    useOrder: false,
  });
  assert.deepEqual(twoTargets.errors, ['Файл «a.mp3» указан для двух целей: «Изображение 1 [0..30%] · Аня» и «Изображение 2 · Рассказчик»']);

  const repeated = planAudioImport(files('a.mp3'), PANELS, {
    manifest: 'Изображение 2 = a.mp3\nИзображение 2 = a.mp3',
    useOrder: false,
  });
  assert.deepEqual(repeated.errors, [], 'повтор той же строки — не конфликт');
});

test('манифест: имя с «=», NFD-имя с macOS, другой регистр', () => {
  const nfdName = 'Йошка_ёж.MP3'.normalize('NFD');
  const plan = planAudioImport(files('a=b.mp3', nfdName), PANELS, {
    manifest: 'Изображение 1 [0..30%] = a=b.mp3\nИзображение 2 = йошка_ёж.mp3',
    useOrder: false,
  });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, 'a=b.mp3'], [4, nfdName]]);
});

test('parseManifest: делит по первому «=»', () => {
  assert.deepEqual(parseManifest('Изображение 1 = x=y.mp3').lines, [{ lineNo: 1, anchorText: 'Изображение 1', file: 'x=y.mp3' }]);
});

// ---------- Приоритеты ----------

test('приоритет: ручное > манифест > имя-якорь > порядок', () => {
  const plan = planAudioImport(
    files('Изображение 1 [0..30%].mp3', 'Изображение 1 [30..60%].mp3', 'm.mp3', 'x.mp3', 'y.mp3'),
    PANELS,
    {
      // манифест отдаёт панель 2 файлу m.mp3 — имя-якорь «[30..60%]» тогда конфликтует → ошибка
      manifest: 'Изображение 1 [60..100%] = m.mp3',
      // ручной выбор: x.mp3 → панель 1, вытесняя имя-якорь «[0..30%]» молча
      manualOverrides: new Map([['x.mp3', '1']]),
    },
  );
  assert.deepEqual(plan.errors, []);
  const via = Object.fromEntries(plan.matches.map(m => [m.target.id, `${m.file}:${m.via}`]));
  assert.deepEqual(via, {
    1: 'x.mp3:manual',
    2: 'Изображение 1 [30..60%].mp3:name',
    3: 'm.mp3:manifest',
    4: 'y.mp3:order',
  });
  assert.deepEqual(plan.unmatchedFiles, ['Изображение 1 [0..30%].mp3'], 'вытеснен ручным — не сопоставлен');
});

test('приоритет: имя-якорь на панель, уже занятую манифестом, — дубль (ошибка)', () => {
  const plan = planAudioImport(files('Изображение 2.mp3', 'r.mp3'), PANELS, {
    manifest: 'Изображение 2 = r.mp3',
    useOrder: false,
  });
  assert.deepEqual(plan.errors, ['Дубль: «r.mp3» и «Изображение 2.mp3» претендуют на «Изображение 2»']);
});

test('ручное: файл или цель исчезли — ошибка, а не тихий пропуск', () => {
  const plan = planAudioImport(files('a.mp3'), PANELS, {
    manualOverrides: new Map([['a.mp3', '99'], ['b.mp3', '1']]),
    useOrder: false,
  });
  assert.deepEqual(plan.errors, [
    'Ручное сопоставление: цель для «a.mp3» больше не существует — выберите заново',
    'Ручное сопоставление: файл «b.mp3» не найден среди загруженных',
  ]);
});

// ---------- Natural sort и порядок ----------

test('natural sort: 2 < 10, ведущие нули, регистр — полный детерминированный порядок', () => {
  const names = ['take10.mp3', 'Take2.mp3', 'take1.mp3', 'take01.mp3', 'take2.mp3'];
  const sorted = [...names].sort(naturalCompare);
  assert.deepEqual(sorted, ['take01.mp3', 'take1.mp3', 'Take2.mp3', 'take2.mp3', 'take10.mp3']);
  assert.deepEqual([...names].reverse().sort(naturalCompare), sorted, 'не зависит от исходного порядка');
});

test('порядок: файлы без номеров раскладываются 1:1 по natural sort', () => {
  const plan = planAudioImport(files('take10.mp3', 'take2.mp3', 'take1.mp3', 'take3.mp3'), PANELS);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, 'take1.mp3'], [2, 'take2.mp3'], [3, 'take3.mp3'], [4, 'take10.mp3']]);
  assert.ok(plan.matches.every(m => m.via === 'order'));
});

test('порядок: порядок панелей — по order, а не по id', () => {
  const shuffled = [panel(1, 0, 0, 30, 'А', 3), panel(2, 0, 30, 30, 'Б', 1), panel(3, 0, 60, 40, 'В', 2)];
  const plan = planAudioImport(files('a.mp3', 'b.mp3', 'c.mp3'), shuffled);
  assert.deepEqual(pairs(plan), [[2, 'a.mp3'], [3, 'b.mp3'], [1, 'c.mp3']]);
});

test('количества (порядок): файлов меньше или больше панелей — ошибка, без усечения', () => {
  const fewer = planAudioImport(files('a.mp3', 'b.mp3', 'c.mp3'), PANELS);
  assert.deepEqual(fewer.errors, ['Файлов 3, панелей 4 — сопоставьте вручную или добавьте манифест']);
  assert.deepEqual(fewer.matches, []);
  const more = planAudioImport(files('a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3'), PANELS);
  assert.deepEqual(more.errors, ['Файлов 5, панелей 4 — сопоставьте вручную или добавьте манифест']);
  const partial = planAudioImport(files('Изображение 2.mp3', 'a.mp3', 'b.mp3'), PANELS);
  assert.deepEqual(partial.errors, ['Несопоставленных файлов 2, панелей без файла 3 — сопоставьте вручную или добавьте манифест']);
});

test('номера: «003.mp3» → 3-я панель; пропуски безопасны, панели без файла → предупреждение', () => {
  const plan = planAudioImport(files('004 - Рассказ.mp3', '01.mp3', '2_борис.wav'), PANELS);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, '01.mp3'], [2, '2_борис.wav'], [4, '004 - Рассказ.mp3']]);
  assert.ok(plan.matches.every(m => m.via === 'number'));
  assert.deepEqual(plan.unmatchedTargets.map(p => p.id), [3]);
  assert.ok(plan.warnings.includes('Панель «Изображение 1 [60..100%] · Аня» без файла — останется TTS'));
});

test('номера: вне диапазона и дубль номера (001 ≡ 1) — ошибки', () => {
  const plan = planAudioImport(files('001.mp3', '1.wav', '005.mp3'), PANELS);
  assert.deepEqual(plan.errors, [
    'Дубль: «001.mp3» и «1.wav» претендуют на «Изображение 1 [0..30%] · Аня»',
    'Файл «005.mp3»: номер 5 вне 1..4 (панелей в проекте: 4) — переименуйте файл или сопоставьте вручную',
  ]);
});

test('номера: дырка — 001 и 003 при трёх панелях → панель 2 без файла, предупреждение', () => {
  const three = PANELS.slice(0, 3);
  const plan = planAudioImport(files('003.mp3', '001.mp3'), three);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, '001.mp3'], [3, '003.mp3']]);
  assert.deepEqual(plan.unmatchedTargets.map(p => p.id), [2]);
  assert.deepEqual(plan.warnings, ['Панель «Изображение 1 [30..60%] · Борис» без файла — останется TTS']);
});

test('naturalCompare: без Intl — кириллица, «ё» = «е», длинные числа, числа раньше текста', () => {
  assert.deepEqual(['яма.mp3', 'жук.mp3', 'ёж.mp3', 'еда.mp3'].sort(naturalCompare), ['еда.mp3', 'ёж.mp3', 'жук.mp3', 'яма.mp3']);
  assert.ok(naturalCompare('9.mp3', '12345678901234567890.mp3') < 0, 'числа любой длины, без переполнения');
  assert.ok(naturalCompare('1.mp3', 'a.mp3') < 0);
  assert.ok(naturalCompare('Глава 2 — сцена 10', 'глава 2 — сцена 9') > 0);
  assert.equal(naturalCompare('a.mp3', 'a.mp3'), 0);
});

test('leadingNumber: только номер в начале, за которым разделитель', () => {
  assert.equal(leadingNumber('003.mp3'), 3);
  assert.equal(leadingNumber('01 - Аня.wav'), 1);
  assert.equal(leadingNumber('7_take.mp3'), 7);
  assert.equal(leadingNumber('3d-voice.mp3'), null);
  assert.equal(leadingNumber('take3.mp3'), null);
});

// ---------- Якорь в имени ----------

test('имя-якорь: файл «Изображение 1 [0..30%].mp3» → панель; эквивалентные записи', () => {
  const plan = planAudioImport(files('Изображение 1 [0..30,0%].mp3', 'изображение 2.wav'), PANELS, { useOrder: false });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, 'Изображение 1 [0..30,0%].mp3'], [4, 'изображение 2.wav']]);
  assert.ok(plan.matches.every(m => m.via === 'name'));
});

test('имя-якорь: нет такой панели или битый диапазон — ошибка; такой файл не уходит в порядок', () => {
  const plan = planAudioImport(files('Изображение 1 [0..20%].mp3', 'Изображение 1 [abc..20%].mp3', 'a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'), PANELS);
  assert.deepEqual(plan.errors, [
    'Файл «Изображение 1 [0..20%].mp3»: нет панели «Изображение 1 [0..20%]»',
    'Файл «Изображение 1 [abc..20%].mp3»: не разобран y-диапазон — формат «Изображение 1 [0..30%]» (числа от 0 до 100)',
  ]);
  assert.deepEqual(pairs(plan), [[1, 'a.mp3'], [2, 'b.mp3'], [3, 'c.mp3'], [4, 'd.mp3']]);
});

test('кламп: bbox за 100% даёт якорь [90..100%], файл с таким именем находит панель', () => {
  const clamped = [panel(1, 0, 90, 20, 'Аня')];
  const plan = planAudioImport(files('Изображение 1 [90..100%].mp3'), clamped);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(pairs(plan), [[1, 'Изображение 1 [90..100%].mp3']]);
});

test('две панели под одним якорем: один файл → первая + предупреждение; два файла → явная ошибка', () => {
  const same = [panel(1, 0, 0, 30, 'Аня'), panel(2, 0, 0, 30, 'Борис'), panel(3, 1, null)];
  const one = planAudioImport(files('Изображение 1 [0..30%].mp3'), same, { useOrder: false });
  assert.deepEqual(one.errors, []);
  assert.deepEqual(pairs(one), [[1, 'Изображение 1 [0..30%].mp3']]);
  assert.ok(one.warnings.some(w => w.startsWith('«Изображение 1 [0..30%]»: под якорем панелей 2 — файл «Изображение 1 [0..30%].mp3» привязан к первой')));

  const two = planAudioImport(files('a.mp3', 'b.mp3'), same, {
    manifest: 'Изображение 1 [0..30%] = a.mp3\nИзображение 1 [0..30%] = b.mp3',
    useOrder: false,
  });
  assert.deepEqual(two.errors, [
    'Дубль: «a.mp3» и «b.mp3» претендуют на «Изображение 1 [0..30%]» (под этим якорем панелей 2 — сопоставьте по номеру файла или вручную)',
  ]);
  // …а по номерам те же две панели адресуются без проблем.
  const byNumber = planAudioImport(files('1.mp3', '2.mp3'), same);
  assert.deepEqual(byNumber.errors, []);
  assert.deepEqual(pairs(byNumber), [[1, '1.mp3'], [2, '2.mp3']]);
});

test('round-trip: заголовки serializeScenario как имена файлов → каждая панель находит свой файл', () => {
  const panels = [
    panel(1, 0, 0, 33.333, 'Аня'),
    panel(2, 0, 33.333, 33.333, 'Борис'),
    panel(3, 0, 66.666, 40, 'Аня'), // за край — кламп в [66.7..100%]
    panel(4, 1, null, 100, 'Рассказчик'),
    panel(5, 2, 12.345, 0.01, 'Шёпот'), // схлопнувшаяся полоса — расширяется до 0.1
  ];
  const headers = serializeScenario(panels).split('\n').filter(l => l.startsWith('Изображение'));
  assert.equal(headers.length, 5);
  const plan = planAudioImport(files(...headers.map(h => `${h}.mp3`)).reverse(), panels, { useOrder: false });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.matches.map(m => [m.target.id, m.via]), [[1, 'name'], [2, 'name'], [3, 'name'], [4, 'name'], [5, 'name']]);
  assert.deepEqual(plan.matches.map(m => m.file), headers.map(h => `${h}.mp3`));
});

// ---------- Прочее ----------

test('не аудио, дубль загруженного имени, интро — отдельные сообщения', () => {
  const plan = planAudioImport(files('cover.png', 'a.mp3', 'a.mp3', 'intro.mp3', 'b.mp3', 'c.mp3', 'd.mp3'), PANELS);
  assert.deepEqual(plan.errors, [
    'Файл «cover.png»: не аудиофайл (mp3, wav, ogg/opus, m4a/aac, flac, webm)',
    'Файл «a.mp3» загружен дважды — оставьте один',
  ]);
  assert.ok(plan.warnings.includes('Файл «intro.mp3» похож на интро/аутро — по порядку не раскладывается'));
  assert.deepEqual(pairs(plan), [[1, 'a.mp3'], [2, 'b.mp3'], [3, 'c.mp3'], [4, 'd.mp3']]);
});

test('пусто: нет файлов — ни ошибок, ни шума; нет панелей — ошибка', () => {
  const none = planAudioImport([], PANELS);
  assert.deepEqual([none.errors, none.warnings, none.matches], [[], [], []]);
  assert.deepEqual(planAudioImport(files('a.mp3'), []).errors, ['В проекте нет панелей — сопоставлять файлы не с чем']);
});

test('перезапись: панели с аудио пропускаются без «Перезаписать»; повторный импорт — 0 ошибок, всё в skipped', () => {
  const names = files('a.mp3', 'b.mp3', 'c.mp3', 'd.mp3');
  const first = planAudioImport(names, PANELS, { existingAudio: [2] });
  assert.deepEqual(first.errors, []);
  assert.deepEqual(pairs(first), [[1, 'a.mp3'], [3, 'c.mp3'], [4, 'd.mp3']]);
  assert.deepEqual(first.skipped.map(m => m.target.id), [2]);
  assert.ok(first.warnings.includes('Панель «Изображение 1 [30..60%] · Борис»: аудио уже есть — «b.mp3» пропущен (включите «Перезаписать»)'));

  const again = planAudioImport(names, PANELS, { existingAudio: [1, 2, 3, 4] });
  assert.deepEqual([again.errors, again.matches], [[], []]);
  assert.equal(again.skipped.length, 4);

  const overwrite = planAudioImport(names, PANELS, { existingAudio: [1, 2, 3, 4], overwrite: true });
  assert.equal(overwrite.matches.length, 4);
  assert.deepEqual(overwrite.skipped, []);
});

test('детерминизм: перестановка файлов и панелей не меняет план', () => {
  const opts = { manifest: 'Изображение 2 = r.mp3' };
  const a = planAudioImport(files('r.mp3', 'x2.mp3', 'x10.mp3', 'x1.mp3'), PANELS, opts);
  const b = planAudioImport(files('x1.mp3', 'x10.mp3', 'r.mp3', 'x2.mp3'), [...PANELS].reverse(), opts);
  assert.deepEqual(a, b);
  assert.deepEqual(pairs(a), [[1, 'x1.mp3'], [2, 'x2.mp3'], [3, 'x10.mp3'], [4, 'r.mp3']]);
});

test('planImport — генерик: цели не обязаны быть панелями', () => {
  const pages = [{ n: 2 }, { n: 1 }];
  const plan = planImport({
    files: files('p2.png', 'p1.png'),
    targets: pages,
    targetId: p => String(p.n),
    targetAnchor: p => `Изображение ${p.n}`,
    targetLabel: p => `стр. ${p.n}`,
    targetOrder: p => [p.n],
    nouns: { genitivePlural: 'изображений', genitiveSingular: 'изображения' },
  });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.matches.map(m => [m.target.n, m.file, m.label]), [[1, 'p1.png', 'стр. 1'], [2, 'p2.png', 'стр. 2']]);
});

// ---------- Применение (applyAudioImport) ----------

const bytes = (text: string) => new Blob([new TextEncoder().encode(text)]);
const fileMap = (names: string[]) => new Map(names.map(n => [n, bytes(`audio:${n}`)]));
/** Декод-заглушка: длительность из размера, «битые» файлы бросают. */
const fakeDecode = async (data: ArrayBuffer) => {
  const text = new TextDecoder().decode(data);
  if (text.includes('broken')) throw new Error('EncodingError');
  return data.byteLength / 10;
};
const noQuota = async () => null;
let projectSeq = 0;
const freshProject = () => `import-test-${++projectSeq}`;

test('apply: файлы пишутся по ключу TTS (audio/{panelId}.mp3), TTS-подпись снимается, отчёт в порядке плана', async () => {
  const projectId = freshProject();
  // У панели 2 было TTS-аудио с подписью — импорт его перезаписывает.
  await saveProjectAudio(projectId, 2, bytes('tts'));
  await saveProjectAudioSignature(projectId, 2, 'tts-signature');
  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const plan = planAudioImport(files(...names), PANELS, { existingAudio: [2], overwrite: true });
  const progress: Array<[number, number]> = [];
  const report = await applyAudioImport(plan, fileMap(names), {
    projectId,
    decode: fakeDecode,
    estimateStorage: noQuota,
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(report.blocked, undefined);
  assert.deepEqual(report.failed, []);
  assert.equal(report.aborted, false);
  assert.deepEqual(report.applied.map(a => [a.panelId, a.file]), [[1, 'a.mp3'], [2, 'b.mp3'], [3, 'c.mp3'], [4, 'd.mp3']]);
  assert.equal(report.applied[0].duration, 'audio:a.mp3'.length / 10);
  for (const a of report.applied) {
    const stored = await loadProjectAudio(projectId, a.panelId);
    assert.equal(await stored?.text(), `audio:${a.file}`, 'тот же ключ, что читают экспорт и TTS');
  }
  assert.equal(await getProjectAudioSignature(projectId, 2), null, 'подпись TTS снята');
  assert.deepEqual(progress.map(p => p[1]), [4, 4, 4, 4]);
  assert.deepEqual(progress.at(-1), [4, 4]);
});

test('apply: не больше concurrency декодов одновременно, файлы пишутся по мере готовности', async () => {
  const projectId = freshProject();
  const panels = Array.from({ length: 8 }, (_, i) => panel(i + 1, i, null));
  const names = panels.map((_, i) => `take${i + 1}.mp3`);
  const plan = planAudioImport(files(...names), panels);
  assert.deepEqual(plan.errors, []);
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let appliedSoFar = 0;
  let appliedBeforeLastDecode = -1;
  const report = await applyAudioImport(plan, fileMap(names), {
    projectId,
    estimateStorage: noQuota,
    decode: async (data) => {
      started += 1;
      if (started === names.length) appliedBeforeLastDecode = appliedSoFar;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
      return data.byteLength;
    },
    onApplied: () => { appliedSoFar += 1; },
  });
  assert.equal(report.applied.length, 8);
  assert.equal(maxActive, 3, 'по умолчанию 3, и они действительно параллельны');
  assert.ok(appliedBeforeLastDecode > 0, 'первые файлы записаны до начала последнего декода');

  maxActive = 0;
  const one = await applyAudioImport(plan, fileMap(names), {
    projectId,
    estimateStorage: noQuota,
    concurrency: 1,
    decode: async (data) => { active += 1; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 1)); active -= 1; return data.byteLength; },
  });
  assert.equal(one.applied.length, 8);
  assert.equal(maxActive, 1);
});

test('apply: отмена — записанные остаются в applied, новые не начинаются, aborted: true', async () => {
  const projectId = freshProject();
  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const plan = planAudioImport(files(...names), PANELS);
  const controller = new AbortController();
  const report = await applyAudioImport(plan, fileMap(names), {
    projectId,
    concurrency: 1,
    signal: controller.signal,
    estimateStorage: noQuota,
    decode: fakeDecode,
    onApplied: () => controller.abort(), // отмена сразу после первого файла
  });
  assert.equal(report.aborted, true);
  assert.deepEqual(report.applied.map(a => a.file), ['a.mp3']);
  assert.deepEqual(report.notStarted, ['b.mp3', 'c.mp3', 'd.mp3']);
  assert.equal(await (await loadProjectAudio(projectId, 1))?.text(), 'audio:a.mp3');
  assert.equal(await loadProjectAudio(projectId, 2), null, 'не начатые не записаны');
});

test('apply: отмена во время декода — уже декодируемые файлы дописываются', async () => {
  const projectId = freshProject();
  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const plan = planAudioImport(files(...names), PANELS);
  const controller = new AbortController();
  const report = await applyAudioImport(plan, fileMap(names), {
    projectId,
    signal: controller.signal,
    estimateStorage: noQuota,
    decode: async (data) => { controller.abort(); await new Promise(r => setTimeout(r, 1)); return data.byteLength; },
  });
  assert.equal(report.aborted, true);
  assert.deepEqual(report.applied.map(a => a.file), ['a.mp3', 'b.mp3', 'c.mp3'], 'три в работе — дописаны');
  assert.deepEqual(report.notStarted, ['d.mp3']);
});

test('apply: битый и пустой файл → failed с причиной, остальные применяются', async () => {
  const projectId = freshProject();
  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const plan = planAudioImport(files(...names), PANELS);
  const map = fileMap(names);
  map.set('b.mp3', bytes('broken'));
  map.set('c.mp3', new Blob([]));
  const report = await applyAudioImport(plan, map, { projectId, decode: fakeDecode, estimateStorage: noQuota });
  assert.deepEqual(report.applied.map(a => a.file), ['a.mp3', 'd.mp3']);
  assert.deepEqual(report.failed, [
    { file: 'b.mp3', panelId: 2, reason: 'формат не поддержан браузером или файл повреждён' },
    { file: 'c.mp3', panelId: 3, reason: 'пустой файл (0 байт)' },
  ]);
  assert.equal(await loadProjectAudio(projectId, 2), null);
});

test('apply: план с ошибками и нехватка места — blocked, ничего не записано', async () => {
  const projectId = freshProject();
  const bad = planAudioImport(files('a.mp3', 'b.mp3'), PANELS); // 2 файла на 4 панели — ошибка
  assert.ok(bad.errors.length > 0);
  const blocked = await applyAudioImport(bad, fileMap(['a.mp3', 'b.mp3']), { projectId, decode: fakeDecode, estimateStorage: noQuota });
  assert.match(blocked.blocked ?? '', /^В плане 1 ошибка/);

  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const plan = planAudioImport(files(...names), PANELS);
  let decodes = 0;
  const full = await applyAudioImport(plan, fileMap(names), {
    projectId,
    decode: async (d) => { decodes += 1; return d.byteLength; },
    estimateStorage: async () => ({ usage: 99 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
  });
  assert.match(full.blocked ?? '', /^Не хватает места в хранилище браузера: нужно ~5,0 МБ, свободно ~1,0 МБ$/);
  assert.equal(decodes, 0, 'ни одного декода до проверки места');
  for (const id of [1, 2, 3, 4]) assert.equal(await loadProjectAudio(projectId, id), null);
});

test('apply: панель удалена после построения плана → failed, файл не ложится сиротой', async () => {
  const projectId = freshProject();
  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const plan = planAudioImport(files(...names), PANELS);
  const report = await applyAudioImport(plan, fileMap(names), {
    projectId, decode: fakeDecode, estimateStorage: noQuota, currentPanelIds: [1, 2, 4],
  });
  assert.deepEqual(report.applied.map(a => a.panelId), [1, 2, 4]);
  assert.deepEqual(report.failed, [{ file: 'c.mp3', panelId: 3, reason: 'панель удалена из проекта после построения плана' }]);
  assert.equal(await loadProjectAudio(projectId, 3), null);
});

test('markPanelsImported / clearImportMark: отметка по отчёту и снятие после TTS', () => {
  const marked = markPanelsImported(PANELS, [{ panelId: 2, file: 'b.mp3' }]);
  assert.deepEqual(marked.map(p => [p.id, p.audioSource, p.audioFileName]), [
    [1, undefined, undefined], [2, 'import', 'b.mp3'], [3, undefined, undefined], [4, undefined, undefined],
  ]);
  assert.equal(marked[0], PANELS[0], 'остальные панели — те же объекты');
  assert.equal(markPanelsImported(PANELS, []), PANELS);
  const cleared = clearImportMark(marked, [2]);
  assert.equal('audioSource' in cleared[1], false);
  assert.equal('audioFileName' in cleared[1], false);
});

test('идемпотентность: повторный импорт тех же файлов после применения — всё в skipped, 0 ошибок', async () => {
  const projectId = freshProject();
  const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
  const first = await applyAudioImport(planAudioImport(files(...names), PANELS), fileMap(names), { projectId, decode: fakeDecode, estimateStorage: noQuota });
  const again = planAudioImport(files(...names), markPanelsImported(PANELS, first.applied), { existingAudio: first.applied.map(a => a.panelId) });
  assert.deepEqual([again.errors, again.matches.length, again.skipped.length], [[], 0, 4]);
});
