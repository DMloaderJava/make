/**
 * scenarioFormat.ts — общий формат якоря «Изображение N [X..Y%]»
 * (сценарий и импорт файлов по якорям).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorFor, panelAnchor, parseImageAnchor, formatImageAnchor, formatRangeNum } from '../src/lib/pipeline/scenarioFormat';
import { rangeKey, sameRange, yRangeFromBbox } from '../src/lib/pipeline/yRange';
import * as scenario from '../src/lib/pipeline/scenario';
import * as format from '../src/lib/pipeline/scenarioFormat';

test('parseImageAnchor: не якорь → null; якорь → номер и диапазон', () => {
  assert.equal(parseImageAnchor('Аня (Жен.): привет'), null);
  assert.equal(parseImageAnchor('IMG_0001'), null);
  assert.deepEqual(parseImageAnchor('Изображение 2'), { kind: 'ok', imageIndex: 1, yRange: null });
  assert.deepEqual(parseImageAnchor('  изображение 1 [ 0 .. 30,5 % ] '), { kind: 'ok', imageIndex: 0, yRange: { from: 0, to: 30.5 } });
});

test('parseImageAnchor: ошибки — те же тексты, что в сценарии, без префикса строки', () => {
  assert.deepEqual(parseImageAnchor('Изображение 0'), { kind: 'error', message: 'номер «Изображение» должен быть ≥ 1', imageIndex: null });
  const range = parseImageAnchor('Изображение 1 [0..150%]');
  assert.equal(range?.kind, 'error');
  assert.match((range as { message: string }).message, /^диапазон \[0\.\.150%\] вне 0\.\.100$/);
  const broken = parseImageAnchor('Изображение 3 [abc..20%]');
  assert.deepEqual(broken && broken.kind === 'error' ? broken.imageIndex : 'нет', 2, 'номер сохранён для подавления каскада');
});

test('panelAnchor/anchorFor: разные записи одного якоря → одна каноничная строка', () => {
  const canon = 'Изображение 1 [0..30%]';
  for (const raw of ['Изображение 1 [0..30%]', 'изображение 1 [ 0 .. 30 ]', 'Изображение 1 [0..30,0%]', 'Изображение 1 [0.0..30%].']) {
    const parsed = parseImageAnchor(raw);
    assert.equal(parsed?.kind, 'ok', raw);
    if (parsed?.kind === 'ok') assert.equal(anchorFor(parsed.imageIndex, parsed.yRange), canon, raw);
  }
  assert.equal(panelAnchor({ imageIndex: 0, bbox: { x: 0, y: 0, width: 100, height: 30.00001 } }), canon);
  assert.equal(anchorFor(0, { from: 0, to: 100 }), 'Изображение 1', '[0..100%] = вся картинка');
  assert.equal(panelAnchor({ imageIndex: 1, bbox: { x: 0, y: 30, width: 100, height: 30 }, fullFrame: true }), 'Изображение 2');
  assert.equal(panelAnchor({ imageIndex: 0, bbox: { x: 0, y: 90, width: 100, height: 20 } }), 'Изображение 1 [90..100%]', 'кламп');
  assert.equal(formatImageAnchor(4, null), 'Изображение 5');
});

test('scenario.ts реэкспортирует формат — старые импорты не ломаются', () => {
  assert.equal(scenario.SCENARIO_IMAGE_LABEL, format.SCENARIO_IMAGE_LABEL);
  assert.equal(scenario.formatRangeNum, format.formatRangeNum);
  assert.equal(scenario.serializableYRange, format.serializableYRange);
});

test('formatRangeNum: арифметическое округление до 0.1, без «-0»', () => {
  assert.equal(formatRangeNum(7.25), '7.3');
  assert.equal(formatRangeNum(7.24), '7.2');
  assert.equal(formatRangeNum(20), '20');
  assert.equal(formatRangeNum(-0.04), '0');
});

test('yRange: кламп bbox и ключ полосы с точностью 0.1%', () => {
  assert.deepEqual(yRangeFromBbox({ x: 0, y: 90, width: 100, height: 20 }), { from: 90, to: 100 });
  assert.equal(yRangeFromBbox({ x: 0, y: -5, width: 100, height: 120 }), null, 'больше страницы — вся страница');
  assert.equal(yRangeFromBbox({ x: 0, y: 30, width: 100, height: 30 }, true), null, 'fullFrame');
  assert.equal(rangeKey({ from: 30.000001, to: 59.999999 }), '30:60');
  assert.ok(sameRange({ from: 30, to: 60 }, { from: 30.04, to: 59.96 }));
  assert.ok(!sameRange({ from: 30, to: 60 }, { from: 30.2, to: 60 }));
});
