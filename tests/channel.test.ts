import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFallbackIntro,
  generateFallbackOutro,
  resolveChannelName,
  DEFAULT_CHANNEL_NAME,
} from '../src/lib/pipeline/generateIntro';

test('resolveChannelName: project.settings.channelName имеет приоритет', () => {
  const name = resolveChannelName({ settings: { channelName: 'Мой канал' } }, { channelName: 'Другой', siteName: 'Третий' });
  assert.equal(name, 'Мой канал');
});

test('resolveChannelName: без channelName в проекте — настройки приложения, затем siteName', () => {
  assert.equal(resolveChannelName(null, { channelName: 'Канал из настроек', siteName: 'Сайт' }), 'Канал из настроек');
  assert.equal(resolveChannelName({ settings: {} }, { channelName: '  ', siteName: 'Сайт' }), 'Сайт', 'пробельный channelName — как пустой');
  assert.equal(resolveChannelName(null, { siteName: 'Только сайт' }), 'Только сайт');
});

test('resolveChannelName: ничего не задано — дефолт', () => {
  assert.equal(resolveChannelName(null, null), DEFAULT_CHANNEL_NAME);
  assert.equal(resolveChannelName(undefined, {}), DEFAULT_CHANNEL_NAME);
  assert.equal(DEFAULT_CHANNEL_NAME, 'Manga Voice Studio');
});

test('generateFallbackIntro: с channelName — имя канала в тексте', () => {
  const panels = [{ dialogue: 'Привет' }, { dialogue: 'Приветствую' }];
  const intro = generateFallbackIntro(panels, 'Мой канал');
  assert.match(intro, /Мой канал/);
  assert.match(intro, /2 панели/, 'числительное: 2 панели');
});

test('generateFallbackIntro: без channelName — дефолт «Manga Voice Studio»', () => {
  const panels = [{ dialogue: 'Привет' }, { dialogue: 'Приветствую' }, { dialogue: 'Точно' }];
  const intro = generateFallbackIntro(panels);
  assert.match(intro, /Manga Voice Studio/);
  assert.match(intro, /3 панели/);
});

test('generateFallbackIntro: склонение «панель/панели/панелей»', () => {
  assert.match(generateFallbackIntro([{ dialogue: 'а' }]), /1 панель/);
  assert.match(generateFallbackIntro([{ dialogue: 'а' }, { dialogue: 'б' }, { dialogue: 'в' }, { dialogue: 'г' }]), /4 панели/);
  assert.match(generateFallbackIntro(Array.from({ length: 5 }, (_, i) => ({ dialogue: String(i) }))), /5 панелей/);
  assert.match(generateFallbackIntro(Array.from({ length: 11 }, (_, i) => ({ dialogue: String(i) }))), /11 панелей/);
  assert.match(generateFallbackIntro(Array.from({ length: 21 }, (_, i) => ({ dialogue: String(i) }))), /21 панель/);
});

test('generateFallbackOutro: с channelName — подписка на канал', () => {
  const outro = generateFallbackOutro([{ dialogue: 'Привет' }], 'Мой канал');
  assert.match(outro, /Подписывайтесь на Мой канал/);
});

test('generateFallbackOutro: пустой channelName — дефолт, без «undefined»', () => {
  const outro = generateFallbackOutro([{ dialogue: 'Привет' }], '   ');
  assert.match(outro, /Manga Voice Studio/);
  assert.doesNotMatch(outro, /undefined|null/);
});
