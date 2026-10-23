import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBrowserSupport } from '../src/lib/ui/browserSupport';

/**
 * P1-5: предупреждение о браузере вместо молчаливых сбоев экспорта.
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

test('P1-5: Chrome и Edge — поддерживаемые браузеры без баннера', () => {
  assert.equal(detectBrowserSupport(CHROME_UA, { viewportWidth: 1440 }).shouldWarn, false);
  assert.equal(detectBrowserSupport(EDGE_UA, { viewportWidth: 1440 }).family, 'chromium');
  assert.equal(detectBrowserSupport(EDGE_UA, { viewportWidth: 1440 }).shouldWarn, false);
});

test('P1-5: Safari получает предупреждение про OPFS/WebCodecs', () => {
  const result = detectBrowserSupport(SAFARI_UA, { viewportWidth: 1440, vendor: 'Apple Computer, Inc.' });
  assert.equal(result.family, 'safari');
  assert.equal(result.shouldWarn, true);
  assert.match(String(result.message), /Safari не поддерживается/i);
});

test('P1-5: Firefox предупреждается о canvas-фолбэке', () => {
  const result = detectBrowserSupport(FIREFOX_UA, { viewportWidth: 1440 });
  assert.equal(result.family, 'firefox');
  assert.match(String(result.message), /WebCodecs/i);
});

test('P1-5: узкий экран показывает desktop-only заметку', () => {
  const result = detectBrowserSupport(CHROME_UA, { viewportWidth: 375 });
  assert.equal(result.isNarrowViewport, true);
  assert.match(String(result.message), /десктоп/i);
});

test('P1-5: неизвестный браузер на широком экране не мешает работе', () => {
  const result = detectBrowserSupport('CustomAgent/1.0', { viewportWidth: 1280 });
  assert.equal(result.family, 'unknown');
  assert.equal(result.shouldWarn, false);
});
