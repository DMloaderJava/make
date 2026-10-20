#!/usr/bin/env node
/**
 * Браузерный E2E smoke-тест мастера первоначальной настройки (OnboardingWizard)
 * и создания демо-проекта (v1.3.18) со снятием 12 обязательных скриншотов
 * + проверок L-6 (mobile 375×667) и L-11 (Firefox UA) + сбором Console и Network логов:
 *
 *  1) 01-step1-env.png         — Открыть `/` с чистым localStorage (Шаг 1, 5 пунктов)
 *  2) 02-step1-reprobed.png    — Клик «Проверить снова» (пункты обновились без ошибок)
 *  3) 03-step2-tts.png         — «Далее» → Шаг 2 (TTS): Dropdown + поле ключа + «Проверить ключ»
 *  4) 04-step2-tts-empty-err.png — Пустой ключ → «Проверить ключ» (красный error в onboarding-tts-test-result)
 *  5) 05-step3-llm.png         — «Далее» → Шаг 3 (LLM): Dropdown + поле ключа
 *  6) 06-step4-channel.png     — «Далее» → Шаг 4 (Канал): поля channelName / channelTagline
 *  7) 07-step4-channel-filled.png — Заполнить «Test Channel» / «Test Tagline»
 *  8) 08-step5-finish.png      — «Далее» → Шаг 5 (Старт): 2 кнопки + ссылки на README/known-limits/Провайдеры
 *  9) 09-demo-editor.png       — «Создать демо-проект»: переход на /editor/<id>, 2 панели, 2 demo WAV
 * 10) 10-demo-playing.png      — Play в editor: currentTime растёт, звук играет, ошибок=0
 * 11) 11-home-no-autowizard.png — Вернуться на `/`: Wizard НЕ открывается автоматически
 * 12) 12-reopened-wizard.png   — Клик «Настройка» в шапке: Wizard открывается повторно
 * 13) 13-mobile-375x667.png    — L-6: viewport 375×667, wizard помещается, кнопки кликабельны
 * 14) 14-firefox-ua-warn.png   — L-11: Firefox UA, chromium показывает ⚠ (warn), demo-проект не блокируется
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium as playwrightChromium } from 'playwright-core';

const ARTIFACTS_DIR = path.join(process.cwd(), 'artifacts', 'smoke-onboarding');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitForServer(baseUrl, child, logs, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start завершился с кодом ${child.exitCode}:\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Сервер не ответил за ${timeoutMs} мс:\n${logs.join('')}`);
}

async function resolveBrowserLaunchOptions() {
  const cleanArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return { executablePath: process.env.CHROMIUM_PATH, args: cleanArgs };
  }
  const systemCandidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of systemCandidates) {
    if (existsSync(candidate)) {
      return { executablePath: candidate, args: cleanArgs };
    }
  }
  if (!process.env.AWS_EXECUTION_ENV) {
    process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
  }
  const sparticuz = (await import('@sparticuz/chromium')).default;
  const executablePath = await sparticuz.executablePath();
  return { executablePath, args: cleanArgs };
}

async function main() {
  if (!existsSync(path.join(process.cwd(), '.next', 'BUILD_ID'))) {
    console.error('smoke:onboarding — сначала соберите проект (`npm run build`): нет .next/BUILD_ID');
    process.exit(1);
  }

  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const port = await pickFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const nextBin = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next');

  const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  server.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  const consoleMessages = [];
  const pageErrors = [];
  const failedRequests = [];

  let browser = null;
  try {
    await waitForServer(baseUrl, server, logs);
    const launchOpts = await resolveBrowserLaunchOptions();
    browser = await playwrightChromium.launch({
      headless: true,
      executablePath: launchOpts.executablePath,
      args: launchOpts.args,
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    page.on('console', (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    page.on('requestfailed', (req) => {
      failedRequests.push({
        url: req.url(),
        method: req.method(),
        reason: req.failure()?.errorText || 'failed',
      });
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedRequests.push({
          url: res.url(),
          method: res.request().method(),
          status: res.status(),
        });
      }
    });

    const snap = async (filename) => {
      const fullPath = path.join(ARTIFACTS_DIR, filename);
      await page.screenshot({ path: fullPath });
      return fullPath;
    };

    // Скриншот 1: Открыть `/` с чистым localStorage -> Шаг 1, 5 пунктов
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    const wizard = page.getByTestId('onboarding-wizard');
    await wizard.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="env-check-item"]').length === 5,
      null,
      { timeout: 10_000 }
    );
    const envStatuses = await page.locator('[data-testid="env-check-item"]').evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-check-id'),
        status: el.getAttribute('data-check-status'),
        text: el.textContent?.trim(),
      }))
    );
    await snap('01-step1-env.png');
    console.log('smoke:onboarding — [1/12] 01-step1-env.png сохранён (5 пунктов окружения)');

    // Скриншот 2: «Проверить снова» -> пункты обновились без ошибок
    await page.getByTestId('onboarding-reprobe-btn').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="env-check-item"]').length === 5,
      null,
      { timeout: 10_000 }
    );
    await page.waitForTimeout(100);
    await snap('02-step1-reprobed.png');
    console.log('smoke:onboarding — [2/12] 02-step1-reprobed.png сохранён');

    // Скриншот 3: «Далее» → Шаг 2 (TTS)
    await page.getByTestId('onboarding-next-btn').click();
    await page.getByTestId('onboarding-step-tts').waitFor({ state: 'visible' });
    await snap('03-step2-tts.png');
    console.log('smoke:onboarding — [3/12] 03-step2-tts.png сохранён');

    // Скриншот 4: Пустой ключ → «Проверить ключ» -> красный error в onboarding-tts-test-result
    await page.getByTestId('onboarding-tts-key-input').fill('');
    await page.getByTestId('onboarding-test-tts-btn').click();
    const ttsErr = page.getByTestId('onboarding-tts-test-result');
    await ttsErr.waitFor({ state: 'visible', timeout: 5_000 });
    const ttsErrText = await ttsErr.innerText();
    if (!ttsErrText.includes('Введите API-ключ')) {
      throw new Error(`Ожидалась ошибка пустого TTS-ключа, получено: ${ttsErrText}`);
    }
    await snap('04-step2-tts-empty-err.png');
    console.log(`smoke:onboarding — [4/12] 04-step2-tts-empty-err.png сохранён ("${ttsErrText}")`);

    // Скриншот 5: «Далее» → Шаг 3 (LLM)
    await page.getByTestId('onboarding-next-btn').click();
    await page.getByTestId('onboarding-step-llm').waitFor({ state: 'visible' });
    await snap('05-step3-llm.png');
    console.log('smoke:onboarding — [5/12] 05-step3-llm.png сохранён');

    // Скриншот 6: «Далее» → Шаг 4 (Канал)
    await page.getByTestId('onboarding-next-btn').click();
    await page.getByTestId('onboarding-step-channel').waitFor({ state: 'visible' });
    await snap('06-step4-channel.png');
    console.log('smoke:onboarding — [6/12] 06-step4-channel.png сохранён');

    // Скриншот 7: Заполнить «Test Channel» / «Test Tagline»
    await page.getByTestId('onboarding-channel-name').fill('Test Channel');
    await page.getByTestId('onboarding-channel-tagline').fill('Test Tagline');
    await snap('07-step4-channel-filled.png');
    console.log('smoke:onboarding — [7/12] 07-step4-channel-filled.png сохранён');

    // Скриншот 8: «Далее» → Шаг 5 (Старт)
    await page.getByTestId('onboarding-next-btn').click();
    await page.getByTestId('onboarding-step-finish').waitFor({ state: 'visible' });
    await snap('08-step5-finish.png');
    console.log('smoke:onboarding — [8/12] 08-step5-finish.png сохранён');

    // Скриншот 9: «Создать демо-проект» -> Переход на /editor/<id>, 2 панели на таймлайне, 2 demo WAV
    await page.getByTestId('onboarding-create-demo-btn').click();
    await page.waitForURL(/\/editor\/[^/?]+/, { timeout: 15_000 });
    await page.getByTestId('studio-timeline').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-video-clip-id]').length === 2,
      null,
      { timeout: 10_000 }
    );

    // Проверяем прокрутку колёсиком мыши до монтажной ленты (h-[100dvh] + min-h-0 на [data-scroll-area])
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(150);
    const editorScrollTop = await page.evaluate(() => {
      const scrollArea = document.querySelector('[data-testid="editor-root"] > [data-scroll-area]');
      return scrollArea ? scrollArea.scrollTop : 0;
    });
    if (editorScrollTop <= 0) {
      throw new Error(`Ожидалась прокрутка контейнера редактора [data-scroll-area] вниз (> 0), получено ${editorScrollTop}`);
    }

    // Проверяем кнопки «Дублировать» (2 -> 3 клипа) и «Удалить» (3 -> 2 клипа)
    await page.locator('[data-video-clip-id="0"]').click();
    await page.getByTestId('timeline-duplicate-clip-btn').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-video-clip-id]').length === 3,
      null,
      { timeout: 5_000 }
    );
    await page.locator('[data-video-clip-id="2"]').click();
    await page.getByTestId('timeline-delete-clip-btn').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-video-clip-id]').length === 2,
      null,
      { timeout: 5_000 }
    );
    // Возвращаем playhead на первый клип (0.80 с) и ждём автосохранения ("сохранено") перед скриншотом 09
    await page.locator('[data-video-clip-id="0"]').click();
    await page.evaluate(() => {
      const scrollArea = document.querySelector('[data-testid="editor-root"] > [data-scroll-area]');
      if (scrollArea) scrollArea.scrollTop = 0;
    });
    await page.waitForTimeout(2200);
    await snap('09-demo-editor.png');
    console.log(`smoke:onboarding — [9/12] 09-demo-editor.png сохранён (${page.url()})`);

    // Скриншот 10: Play в editor -> currentTime растёт, звук играет, ошибок=0
    const timeBeforePlay = Number(
      await page.getByTestId('studio-timeline').getAttribute('data-current-time')
    );
    const playPauseBtn = page.getByTestId('preview-play-pause-btn');
    await playPauseBtn.click();
    await page.waitForFunction(
      (start) => {
        const el = document.querySelector('[data-testid="studio-timeline"]');
        const now = Number(el?.getAttribute('data-current-time') ?? 0);
        return now >= start + 0.45;
      },
      timeBeforePlay,
      { timeout: 5_000 }
    );
    await snap('10-demo-playing.png');
    await playPauseBtn.click(); // Pause
    const timeAfterPlay = Number(
      await page.getByTestId('studio-timeline').getAttribute('data-current-time')
    );
    const audioAlerts = await page.getByTestId('audio-error-alert').count();
    if (audioAlerts > 0) {
      throw new Error('Неожиданная ошибка аудио при проигрывании демо-проекта');
    }
    console.log(
      `smoke:onboarding — [10/12] 10-demo-playing.png сохранён (currentTime ${timeBeforePlay.toFixed(
        2
      )} с -> ${timeAfterPlay.toFixed(2)} с)`
    );

    const onboardingFlag = await page.evaluate(() => localStorage.getItem('onboardingCompleted'));
    if (onboardingFlag !== 'true') {
      throw new Error(`Ожидался localStorage.onboardingCompleted === "true", получено ${onboardingFlag}`);
    }

    // Проверка скролла колёсиком мыши в ExportModal (min-h-0 + overscroll-contain)
    await page.setViewportSize({ width: 1280, height: 600 });
    await page.getByTestId('open-export-btn').click();
    await page.locator('button:has-text("1920×1080")').first().waitFor({ state: 'attached', timeout: 5_000 });
    const windowScrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(640, 300);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(150);
    const exportScrollState = await page.evaluate(() => {
      const container = document.querySelector(
        '.overflow-y-auto.flex-1.min-h-0.overscroll-contain'
      );
      return {
        found: Boolean(container),
        scrollTop: container ? container.scrollTop : 0,
        scrollHeight: container ? container.scrollHeight : 0,
        clientHeight: container ? container.clientHeight : 0,
        windowScrollY: window.scrollY,
      };
    });
    if (!exportScrollState.found || exportScrollState.scrollTop <= 0) {
      throw new Error(
        `ExportModal должен прокручиваться колёсиком мыши (min-h-0): ${JSON.stringify(exportScrollState)}`
      );
    }
    if (exportScrollState.windowScrollY !== windowScrollBefore) {
      throw new Error(
        `Страница на фоне не должна прокручиваться при скролле ExportModal (overscroll-contain): было=${windowScrollBefore}, стало=${exportScrollState.windowScrollY}`
      );
    }
    await snap('15-export-modal-scrolled.png');
    await page.setViewportSize({ width: 1440, height: 900 });
    console.log(
      `smoke:onboarding — скролл ExportModal проверен: scrollTop=${exportScrollState.scrollTop}px, фон не сместился`
    );

    // Скриншот 11: Вернуться на `/` -> Wizard НЕ открывается автоматически
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(200);
    if ((await wizard.count()) > 0 && (await wizard.isVisible())) {
      throw new Error('Мастер не должен открываться автоматически после завершения onboarding');
    }
    await snap('11-home-no-autowizard.png');
    console.log('smoke:onboarding — [11/12] 11-home-no-autowizard.png сохранён');

    // Скриншот 12: Клик «Настройка» в шапке -> Wizard открывается повторно
    await page.getByTestId('open-onboarding-btn').click();
    await wizard.waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForTimeout(150);
    await snap('12-reopened-wizard.png');
    console.log('smoke:onboarding — [12/12] 12-reopened-wizard.png сохранён');

    // Опционально L-6: viewport 375×667 — wizard помещается, кнопки кликабельны
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(150);
    await snap('13-mobile-375x667.png');
    const nextBtnBox = await page.getByTestId('onboarding-next-btn').boundingBox();
    if (!nextBtnBox || nextBtnBox.y + nextBtnBox.height > 667) {
      throw new Error(`Кнопка Далее выходит за пределы вьюпорта 375x667: ${JSON.stringify(nextBtnBox)}`);
    }
    console.log('smoke:onboarding — [L-6] 13-mobile-375x667.png сохранён (кнопки внутри 375×667)');

    // Опционально L-11: проверка с User-Agent Firefox ≥ 128 — chromium показывает ⚠ (warn), старт не заблокирован
    const ffContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    });
    const ffPage = await ffContext.newPage();
    await ffPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    await ffPage.getByTestId('onboarding-wizard').waitFor({ state: 'visible', timeout: 10_000 });
    await ffPage.waitForFunction(
      () => document.querySelectorAll('[data-testid="env-check-item"]').length === 5,
      null,
      { timeout: 10_000 }
    );
    const ffChromiumStatus = await ffPage
      .locator('[data-check-id="chromium"]')
      .getAttribute('data-check-status');
    if (ffChromiumStatus !== 'warn') {
      throw new Error(`Ожидался статус warn для chromium под Firefox UA, получено: ${ffChromiumStatus}`);
    }
    await ffPage.screenshot({ path: path.join(ARTIFACTS_DIR, '14-firefox-ua-warn.png') });
    await ffContext.close();
    console.log('smoke:onboarding — [L-11] 14-firefox-ua-warn.png сохранён (chromium=warn, не блокер)');

    if (pageErrors.length > 0) {
      throw new Error(`Обнаружены необработанные ошибки страницы (pageerror): ${pageErrors.join('; ')}`);
    }
    const server5xx = failedRequests.filter((r) => (r.status ?? 0) >= 500);
    if (server5xx.length > 0) {
      throw new Error(`Обнаружены ответы 5xx: ${JSON.stringify(server5xx)}`);
    }

    const report = {
      timestamp: new Date().toISOString(),
      envStatuses,
      demoTimeBeforePlay: timeBeforePlay,
      demoTimeAfterPlay: timeAfterPlay,
      onboardingCompleted: onboardingFlag === 'true',
      consoleMessages,
      pageErrors,
      failedRequests,
    };
    writeFileSync(path.join(ARTIFACTS_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      `smoke:onboarding — ok: 14 скриншотов и report.json сохранены в ${ARTIFACTS_DIR}, pageErrors=0, 5xx=0`
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('smoke:onboarding — FAIL:', err);
  process.exit(1);
});
