import './fixtures/browserEnv';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTotalCost, estimateTTSCost } from '../src/lib/validators';
import { getVoiceButtonState, pluralize } from '../src/lib/pipeline/voiceButtonState';
import { rebuildSrt } from '../src/lib/pipeline/buildTimeline';
import { generateAllAudio } from '../src/lib/pipeline/generateAudio';
import { TTS_PROVIDERS, getTTSProvider } from '../src/lib/providers/tts/catalog';
import type { TTSProvider } from '../src/lib/providers/tts/types';
import type { PanelData } from '../src/lib/storage/db';
import { saveApiKey } from '../src/lib/storage/local';
import { loadProjectAudio, saveProjectAudio } from '../src/lib/storage/opfs';

/**
 * Сквозной smoke-тест цепочки «Озвучить всё» без браузера и без сети:
 *
 *   панели → generateAllAudio (mock-TTS) → аудио на каждую панель
 *         → rebuildSrt (тот же путь, что в редакторе: таймлайн + финальный SRT)
 *         → состояния кнопки «Озвучить всё»
 *
 * Плюс регресс-тесты счётчика символов (баг «1 симв.») и метки «FREE (quota)».
 */

// --- Mock TTS: валидный WAV, голос резолвится без сети ---

function makeWav(text: string): ArrayBuffer {
  const sampleRate = 22050;
  const seconds = Math.max(0.2, text.length / 14);
  const numSamples = Math.floor(seconds * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true); // mono
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  return buffer;
}

let mockCalls = 0;
/** Не null — провайдер падает с этим сообщением (не ретраится: не 429/5xx). */
let mockFailWith: string | null = null;
/** Тексты, реально ушедшие в синтез (кэш-попадания сюда не попадают). */
const mockTexts: string[] = [];
const mockProvider: TTSProvider = {
  id: 'mock',
  name: 'Mock',
  description: 'Тестовый провайдер без сети (только для smoke-теста)',
  freeTier: true,
  languages: ['ru', 'en'],
  async getVoices() {
    return [{ id: 'mock-voice', name: 'Mock Voice', language: 'ru', gender: 'neutral', provider: 'mock' }];
  },
  async generate(text: string) {
    if (mockFailWith) throw new Error(mockFailWith);
    mockCalls += 1;
    mockTexts.push(text);
    return makeWav(text);
  },
};
if (!TTS_PROVIDERS.some(p => p.id === 'mock')) TTS_PROVIDERS.push(mockProvider);
saveApiKey('mock', 'test-key');

const PANELS: PanelData[] = [
  { id: 1, bbox: { x: 10, y: 10, width: 40, height: 12 }, dialogue: 'Зря я решился на это.', character: 'ГГ', emotion: 'neutral', type: 'speech', order: 0, imageIndex: 0 },
  { id: 2, bbox: { x: 10, y: 30, width: 40, height: 12 }, dialogue: 'Что ты наделал?!', character: 'ГГ', emotion: 'angry', type: 'speech', order: 1, imageIndex: 0 },
  { id: 3, bbox: { x: 10, y: 50, width: 40, height: 12 }, dialogue: 'Я не специально.', character: 'Друг', emotion: 'neutral', type: 'speech', order: 2, imageIndex: 1 },
];
const INTRO = 'Сегодня я расскажу историю.';
const OUTRO = 'Спасибо за просмотр!';
const INTRO_DURATION = 8;
const OUTRO_DURATION = 4;

// --- A: счётчик символов ---

test('estimateTotalCost: сумма длин без разделителей, пустой проект → 0 символов', () => {
  // Регресс: раньше пустой проект показывал «1 симв.» — длину пробела-разделителя в join(' ').
  assert.equal(estimateTotalCost([], '', '', 'gemini').characters, 0);
  // Регресс: панель в 21 символ показывалась как 23 (два лишних разделителя).
  const one = estimateTotalCost([{ dialogue: 'Зря я решился на это.' }], '', '', 'gemini');
  assert.equal(one.characters, 'Зря я решился на это.'.length);
  // Панели + интро + аутро суммируются ровно.
  const mixed = estimateTotalCost([{ dialogue: 'Раз.' }, { dialogue: 'Два.' }], 'Интро.', 'Аутро.', 'cartesia');
  assert.equal(mixed.characters, 'Раз.'.length + 'Два.'.length + 'Интро.'.length + 'Аутро.'.length);
});

test('estimateTTSCost: нулевая цена называется по источнику, без «FREE (quota)»', () => {
  const free = estimateTotalCost([{ dialogue: 'Привет' }], '', '', 'gemini');
  // Имя провайдера берётся из каталога — не захардкожено в тесте.
  const geminiName = getTTSProvider('gemini')!.name;
  assert.equal(free.estimatedCost, `бесплатно · free tier (${geminiName})`);
  assert.doesNotMatch(free.estimatedCost, /quota/i);
  const paid = estimateTTSCost('Привет', 'elevenlabs');
  assert.equal(paid.estimatedCost, `$${(6 * 0.18 / 1000).toFixed(4)}`);
});

// --- C: состояния кнопки ---

test('getVoiceButtonState: пустой проект, ничего/часть/всё озвучено', () => {
  const panels = [{ id: 1, dialogue: 'А' }, { id: 2, dialogue: 'Б' }];

  const empty = getVoiceButtonState({ panels: [], voicedPanelIds: [] });
  assert.equal(empty.kind, 'empty');
  assert.equal(empty.label, 'Озвучить всё');
  assert.equal(empty.needsAttention, false);

  const none = getVoiceButtonState({ panels, voicedPanelIds: [] });
  assert.equal(none.kind, 'none');
  assert.equal(none.label, 'Озвучить все 2 панели');
  assert.equal(none.pendingCount, 2);
  assert.equal(none.needsAttention, true);
  assert.ok(none.hint);

  const partial = getVoiceButtonState({ panels, voicedPanelIds: [1] });
  assert.equal(partial.kind, 'partial');
  assert.equal(partial.label, 'Озвучить оставшиеся 1');
  assert.equal(partial.pendingCount, 1);
  assert.equal(partial.hint, '1 из 2 озвучено');

  const all = getVoiceButtonState({ panels, voicedPanelIds: [1, 2] });
  assert.equal(all.kind, 'all');
  assert.equal(all.label, 'Переозвучить всё');
  assert.equal(all.needsAttention, false);
});

test('getVoiceButtonState: аудио есть, но текст изменился после озвучки — панель снова pending', () => {
  const panels = [{ id: 1, dialogue: 'Новый текст' }];
  const audioTexts = { 1: 'Старый текст' };
  const state = getVoiceButtonState({ panels, voicedPanelIds: [1], audioTexts });
  assert.equal(state.kind, 'none');
  assert.equal(state.pendingCount, 1);
  // Без снимка (проекты до v1.3.2) панель с аудио считается озвученной.
  const noSnapshot = getVoiceButtonState({ panels, voicedPanelIds: [1] });
  assert.equal(noSnapshot.kind, 'all');
});

test('pluralize: 1 панель, 2 панели, 5 панелей, 21 панель', () => {
  assert.equal(pluralize(1, 'панель', 'панели', 'панелей'), 'панель');
  assert.equal(pluralize(2, 'панель', 'панели', 'панелей'), 'панели');
  assert.equal(pluralize(5, 'панель', 'панели', 'панелей'), 'панелей');
  assert.equal(pluralize(11, 'панель', 'панели', 'панелей'), 'панелей');
  assert.equal(pluralize(21, 'панель', 'панели', 'панелей'), 'панель');
  assert.equal(pluralize(22, 'панель', 'панели', 'панелей'), 'панели');
});

// --- E: end-to-end smoke, вся цепочка «Озвучить всё» ---

test('end-to-end: озвучка всех панелей → таймлайн → финальный SRT → состояния кнопки', async () => {
  // Тот же SRT-постобработчик, что в редакторе (runAudioGeneration → rebuildSrt).
  const rebuildWith = (durations: Map<number, number>, realDurations?: Record<number, number>) => rebuildSrt({
    panels: PANELS,
    audioDurations: durations,
    voiceAssignments: {},
    intro: INTRO,
    outro: OUTRO,
    introDuration: INTRO_DURATION,
    outroDuration: OUTRO_DURATION,
    panelGap: 0.6,
    realDurations,
  });

  // 1. До озвучки кнопка честно говорит, что работы на все панели,
  //    а SRT — черновик (как srtDraft в редакторе).
  const before = getVoiceButtonState({ panels: PANELS, voicedPanelIds: [], audioTexts: null });
  assert.equal(before.kind, 'none');
  assert.equal(before.label, 'Озвучить все 3 панели');
  assert.equal(before.needsAttention, true);
  assert.equal(rebuildWith(new Map()).draft, true, 'до озвучки SRT должен быть черновиком');

  // 2. Тот же вызов, что runAudioGeneration() в редакторе после нажатия «Озвучить всё».
  let estimate: { characters: number; cost: string } | null = null;
  const progress: Array<[number, number]> = [];
  const result = await generateAllAudio({
    projectId: 'smoke-voice-pipeline',
    panels: PANELS,
    voiceAssignments: {},
    intro: INTRO,
    outro: OUTRO,
    ttsProviderId: 'mock',
    language: 'ru',
    onCostEstimate: (e) => { estimate = e; },
    onProgress: (done, total) => { progress.push([done, total]); },
  });

  // 3. Ни одна панель не упала, аудио есть на каждую (аналог audioBlobs.size === panels.length).
  assert.deepEqual(result.errors, []);
  assert.equal(result.panelAudios.size, PANELS.length);
  for (const panel of PANELS) {
    const audio = result.panelAudios.get(panel.id);
    assert.ok(audio, `панель ${panel.id} осталась без аудио`);
    assert.ok(audio!.duration > 0, `панель ${panel.id} с нулевой длительностью`);
    assert.ok(audio!.blob.size > 44, `панель ${panel.id} с пустым файлом`);
  }
  assert.ok(result.introAudio, 'интро не сгенерировано');
  assert.ok(result.outroAudio, 'аутро не сгенерировано');

  // 4. Счётчик сошёлся: Σ длин текстов, без разделителей (баг «1 симв.» не повторился).
  const expectedChars = PANELS.reduce((sum, p) => sum + p.dialogue.length, 0) + INTRO.length + OUTRO.length;
  assert.equal(estimate!.characters, expectedChars);
  assert.equal(result.totalCost.characters, expectedChars);

  // 5. Прогресс дошёл до конца: последний тик — все шаги (3 панели + интро + аутро).
  const last = progress[progress.length - 1];
  assert.deepEqual(last, [5, 5]);

  // 6. Тот же пост-обработчик, что в редакторе: таймлайн + финальный SRT,
  //    флаг черновика снят (srtDraft === false после озвучки).
  const realDurations: Record<number, number> = {};
  result.durations.forEach((v, k) => { realDurations[k] = v; });
  const rebuilt = rebuildWith(result.durations, realDurations);
  assert.equal(rebuilt.timeline.length, PANELS.length);
  assert.equal(rebuilt.draft, false, 'SRT остался черновиком после озвучки');
  const srt = rebuilt.srt;
  assert.ok(srt.length > 0, 'SRT пустой — после озвучки такого быть не должно');
  assert.ok(srt.includes(INTRO), 'SRT без интро');
  assert.ok(srt.includes(OUTRO), 'SRT без аутро');
  for (const panel of PANELS) {
    assert.ok(srt.includes(panel.dialogue), `SRT без реплики панели ${panel.id}`);
  }
  // 5 сегментов: интро + 3 панели + аутро, с монотонными таймкодами.
  const stamps = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g)];
  assert.equal(stamps.length, 5);
  const toMs = (m: RegExpMatchArray) =>
    (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]);
  for (let i = 1; i < stamps.length; i++) {
    assert.ok(toMs(stamps[i]) >= toMs(stamps[i - 1]), `таймкоды SRT не монотонны на сегменте ${i}`);
  }

  // 7. После озвучки кнопка меняет состояние: «Переозвучить всё».
  const audioTexts: Record<number, string> = {};
  for (const panel of PANELS) audioTexts[panel.id] = panel.dialogue;
  const after = getVoiceButtonState({
    panels: PANELS,
    voicedPanelIds: result.panelAudios.keys(),
    audioTexts,
  });
  assert.equal(after.kind, 'all');
  assert.equal(after.label, 'Переозвучить всё');
  assert.equal(after.needsAttention, false);

  // 8. Правка текста после озвучки → эта панель снова «не озвучена».
  const edited = PANELS.map(p => p.id === 2 ? { ...p, dialogue: 'Что ты наделал?! …' } : p);
  const afterEdit = getVoiceButtonState({
    panels: edited,
    voicedPanelIds: result.panelAudios.keys(),
    audioTexts,
  });
  assert.equal(afterEdit.kind, 'partial');
  assert.equal(afterEdit.pendingCount, 1);
  assert.equal(afterEdit.label, 'Озвучить оставшиеся 1');

  // 9. Аудио удалено (как после «↻ Переозвучить» или смены панелей) → снова «Озвучить все».
  const afterClear = getVoiceButtonState({ panels: PANELS, voicedPanelIds: [], audioTexts });
  assert.equal(afterClear.kind, 'none');
  assert.equal(afterClear.label, 'Озвучить все 3 панели');
  assert.equal(afterClear.needsAttention, true);
});

test('end-to-end: повторный прогон берёт аудио из кэша и не ходит в TTS повторно', async () => {
  const callsBefore = mockCalls;
  const result = await generateAllAudio({
    projectId: 'smoke-voice-pipeline', // тот же проект, что в первом тесте
    panels: PANELS,
    voiceAssignments: {},
    intro: INTRO,
    outro: OUTRO,
    ttsProviderId: 'mock',
    language: 'ru',
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.panelAudios.size, PANELS.length);
  // OPFS-подписи совпали → панели из сохранённых файлов, синтез не вызывался.
  assert.equal(mockCalls, callsBefore);
});

// --- F: импортированное аудио (v1.3.18) ---

// У импортированной панели уникальный текст: если бы TTS её тронул, текст
// оказался бы в mockTexts (общий TTS-кэш его не знает).
const IMPORTED_TEXT = 'Эта реплика записана актёром, а не TTS.';
const IMPORTED_PANELS: PanelData[] = PANELS.map(p => (p.id === 2
  ? { ...p, dialogue: IMPORTED_TEXT, audioSource: 'import' as const, audioFileName: 'voice2.mp3' }
  : p));

test('generateAllAudio: импортированную панель «Озвучить всё» не перезаписывает и не оплачивает', async () => {
  const projectId = 'import-skip';
  await saveProjectAudio(projectId, 2, new Blob(['IMPORTED']));
  const callsBefore = mockCalls;
  let estimate: { characters: number } | null = null;
  const result = await generateAllAudio({
    projectId,
    panels: IMPORTED_PANELS,
    voiceAssignments: {},
    ttsProviderId: 'mock',
    language: 'ru',
    onCostEstimate: (e) => { estimate = e; },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.keptImported, [2]);
  assert.ok(!mockTexts.includes(IMPORTED_TEXT), 'импортированная панель в синтез не ушла');
  assert.ok(mockCalls - callsBefore <= 2, 'синтез — не больше чем для панелей 1 и 3 (остальное из кэша)');
  assert.equal(result.panelAudios.size, 3);
  assert.equal(estimate!.characters, PANELS[0].dialogue.length + PANELS[2].dialogue.length, 'импорт не входит в стоимость');
  assert.equal(await result.panelAudios.get(2)?.blob.text(), 'IMPORTED', 'в результате — импортированный файл');
  assert.equal(await (await loadProjectAudio(projectId, 2))?.text(), 'IMPORTED', 'в OPFS — он же');

  // Повторный прогон («Переозвучить всё» без force) — тоже не трогает.
  const again = await generateAllAudio({ projectId, panels: IMPORTED_PANELS, voiceAssignments: {}, ttsProviderId: 'mock', language: 'ru' });
  assert.deepEqual(again.keptImported, [2]);
  assert.equal(await (await loadProjectAudio(projectId, 2))?.text(), 'IMPORTED');
});

test('generateAllAudio: forceRegenerate (кнопка «↻» после подтверждения) перезаписывает импорт', async () => {
  const projectId = 'import-force';
  await saveProjectAudio(projectId, 2, new Blob(['IMPORTED']));
  const callsBefore = mockCalls;
  const result = await generateAllAudio({
    projectId,
    panels: IMPORTED_PANELS,
    voiceAssignments: {},
    ttsProviderId: 'mock',
    language: 'ru',
    onlyPanelIds: [2],
    forceRegenerate: true,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.keptImported, []);
  assert.equal(mockCalls - callsBefore, 1);
  assert.equal(mockTexts.at(-1), IMPORTED_TEXT);
  const stored = await (await loadProjectAudio(projectId, 2))!.arrayBuffer();
  assert.equal(new TextDecoder().decode(stored.slice(0, 4)), 'RIFF', 'теперь там TTS (WAV)');
});

test('generateAllAudio: forceRegenerate импорта упал — файл пользователя цел', async () => {
  // Редактор перед переозвучкой импорта файл не удаляет: проверяем, что и
  // генератор при неудаче его не трогает (forceRegenerate только не читает).
  const projectId = 'import-force-fail';
  await saveProjectAudio(projectId, 2, new Blob(['IMPORTED']));
  mockFailWith = 'mock: invalid api key';
  try {
    const result = await generateAllAudio({
      projectId,
      panels: IMPORTED_PANELS,
      voiceAssignments: {},
      ttsProviderId: 'mock',
      language: 'ru',
      onlyPanelIds: [2],
      forceRegenerate: true,
    });
    assert.equal(result.panelAudios.has(2), false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /^Панель 2: /);
  } finally {
    mockFailWith = null;
  }
  assert.equal(await (await loadProjectAudio(projectId, 2))?.text(), 'IMPORTED');
});

test('generateAllAudio: импортированный файл пропал — ошибка, а не тихий TTS', async () => {
  const callsBefore = mockCalls;
  const result = await generateAllAudio({
    projectId: 'import-missing',
    panels: IMPORTED_PANELS,
    voiceAssignments: {},
    ttsProviderId: 'mock',
    language: 'ru',
    onlyPanelIds: [2],
  });
  assert.deepEqual(result.errors, ['Панель 2: импортированный файл «voice2.mp3» не найден в хранилище — импортируйте заново или переозвучьте панель']);
  assert.equal(mockCalls, callsBefore);
  assert.equal(result.panelAudios.has(2), false);
});

test('getVoiceButtonState: импортированная панель озвучена, даже если текст изменился', () => {
  const panels = [
    { id: 1, dialogue: 'Новый текст', audioSource: 'import' as const },
    { id: 2, dialogue: 'Новый текст' },
  ];
  const audioTexts = { 1: 'Старый текст', 2: 'Старый текст' };
  const state = getVoiceButtonState({ panels, voicedPanelIds: [1, 2], audioTexts });
  assert.equal(state.voicedCount, 1, 'импорт — озвучен, TTS с изменённым текстом — нет');
  assert.equal(state.kind, 'partial');
  // Отметка без файла — не озвучена.
  assert.equal(getVoiceButtonState({ panels, voicedPanelIds: [], audioTexts }).voicedCount, 0);
});
