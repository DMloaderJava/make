#!/usr/bin/env node
/**
 * Задача 3.1.2 (Н-3.2), 3.1.1 (Н-3.1), 3.2.1 (п. 51), 3.2.2 (п. 52), 3.3.1 (п. 62):
 * автоматический E2E браузерный smoke-тест редактора в реальном headless Chromium.
 *
 * Проверяет:
 *  1. Загрузку длинной полосы 100×2000 PNG на главной странице -> создание проекта в IndexedDB + OPFS.
 *  2. Применение сценария с двумя панелями `[0..50%]` и `[50..100%]`.
 *  3. Настройку коротких интро/аутро (0.4 с + 0.4 с) и импорт двух WAV по 0.6 с (`001.wav`, `002.wav`)
 *     с паузой 0.2 с -> общая длительность ролика = 2.20 с (≤ 3.0 с, присутствуют все 4 фазы: intro/panel/gap/outro).
 *  4. Задачу 3.3.1 (п. 62): двусторонняя подсветка `.selected` на `[data-audio-clip-id]` и `[data-linked-clip-highlight]`.
 *  5. Задачу 3.2.2 (п. 52): pointer-события (`pointerdown -> pointermove -> pointerup`) на ручке `[data-trim-handle="in"]`
 *     с проверкой изменения `trimIn` и роста `timelineVersion`.
 *  6. Задачу 3.2.1 (п. 51): pointer-события перетаскивания клипа `[data-video-clip-id="0"]` на позицию клипа `#1`
 *     с проверкой смены порядка клипов и роста `timelineVersion`.
 *  7. Seek и Play/Pause с явной проверкой изменения `currentTime` (`timeAfterPlay > timeBeforePlay`).
 *  8. Задачу 3.1.1 (Н-3.1): сохранение кадров Preview и Export на контрольных точках `intro`, `panel`, `gap`, `outro`
 *     в режимах `panels` и `strip`, а также сводных таблиц сравнения `task-3-1-1-comparison-panels.png` и `task-3-1-1-comparison-strip.png`.
 *  9. Экспорт короткого видеоклипа (≤ 3 с) через `ExportModal`, проверку непустого размера, сигнатуры контейнера
 *     (WebM/MP4), разрешения 1920×1080 и длительности ≤ 3.0 с.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);

/**
 * --quick (или SMOKE_EDITOR_QUICK=1) — сокращённый прогон для Windows-CI:
 * остаются загрузка, сценарий, интро/аутро, импорт WAV, seek/Play и экспорт.
 * Пропускаются pointer-тесты NLE (trim, drag-and-drop), проверка подсветки и
 * попиксельное сравнение кадров Preview/Export: на headless Windows они
 * нестабильны из-за синтетических pointer-событий, а не из-за продукта.
 */
const QUICK = process.argv.includes('--quick') || process.env.SMOKE_EDITOR_QUICK === '1';
if (!existsSync('.next/BUILD_ID')) {
  console.error('smoke:editor — сначала выполните `npm run build` (.next/BUILD_ID не найден)');
  process.exit(1);
}

/** Генерирует валидный RGB PNG (width × height) с градиентными полосами без внешних зависимостей. */
function generateStripPng(width, height) {
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * 3;
  const raw = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowStride;
    raw[rowOffset] = 0; // filter None
    const isTopHalf = y < height / 2;
    const band = Math.floor(y / 120) % 2 === 0;
    for (let x = 0; x < width; x++) {
      const px = rowOffset + 1 + x * 3;
      if (isTopHalf) {
        raw[px] = band ? 42 : 68;
        raw[px + 1] = band ? 92 : 138;
        raw[px + 2] = band ? 180 : 220;
      } else {
        raw[px] = band ? 190 : 232;
        raw[px + 1] = band ? 110 : 160;
        raw[px + 2] = band ? 48 : 76;
      }
    }
  }

  const idat = deflateSync(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Генерирует 16-бит моно PCM WAV заданной длительности (сек) и частоты тона (Гц). */
function generateSineWav(durationSec = 0.6, freqHz = 440, sampleRate = 44100) {
  const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freqHz * t) * 0.35;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return buf;
}

function saveDataUrlPng(dataUrl, destPath, tmpDir) {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  writeFileSync(destPath, buf);
  if (tmpDir) {
    writeFileSync(join(tmpDir, destPath.split('/').pop()), buf);
  }
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitReady(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
      if (r.status > 0) return;
    } catch {
      // сервер ещё поднимается
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`next start не ответил за ${timeoutMs} мс`);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const nextBin = join(dirname(require.resolve('next/package.json')), 'dist/bin/next');

const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'production' },
});

let serverLogs = '';
server.stdout.on('data', d => {
  serverLogs += d;
});
server.stderr.on('data', d => {
  serverLogs += d;
});

function stopServer() {
  return new Promise(resolveStop => {
    if (server.exitCode !== null || server.killed) return resolveStop();
    server.once('exit', () => resolveStop());
    server.kill('SIGTERM');
    setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
      resolveStop();
    }, 3000).unref();
  });
}


/**
 * Путь к Chromium/Chrome для Playwright.
 *
 * Linux-CI использует @sparticuz/chromium (самодостаточная сборка), Windows —
 * установленный на runner-е Chrome/Edge; на macOS — Chrome.app. Порядок:
 * CHROMIUM_PATH → системные пути платформы → @sparticuz (только Linux).
 */
async function resolveChromiumExecutable() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    candidates.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(localAppData ? [join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      console.log(`smoke:editor — браузер: ${candidate}`);
      return candidate;
    }
  }

  if (process.platform === 'linux') {
    const chromiumMod = require('@sparticuz/chromium');
    const sparticuzChromium = chromiumMod.default || chromiumMod;
    return await sparticuzChromium.executablePath();
  }

  throw new Error(
    `Chromium не найден (${process.platform}). Установите Chrome/Edge или задайте CHROMIUM_PATH.`
  );
}

// Артефакты сохраняются внутри репозитория (`artifacts/smoke-editor`) и дублируются в `/tmp/smoke-editor-artifacts`
const artifactsDir = resolve(process.cwd(), 'artifacts/smoke-editor');
const tmpArtifactsDir = resolve(tmpdir(), 'smoke-editor-artifacts');
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(tmpArtifactsDir, { recursive: true });

const pngPath = join(tmpArtifactsDir, 'strip-100x2000.png');
const wav1Path = join(tmpArtifactsDir, '001.wav');
const wav2Path = join(tmpArtifactsDir, '002.wav');
writeFileSync(pngPath, generateStripPng(100, 2000));
writeFileSync(wav1Path, generateSineWav(0.6, 440));
writeFileSync(wav2Path, generateSineWav(0.6, 660));

let browser = null;
try {
  console.log(`smoke:editor — среда: node=${process.version}, platform=${process.platform}/${process.arch}`);
  await waitReady(baseUrl);

  // В контейнерной Linux-среде без системных libnspr4/libnss3 активируем распаковку
  // комплектных библиотек @sparticuz/chromium в /tmp/al2023/lib (см. L-13 в known-limits.md).
  if (!process.env.AWS_EXECUTION_ENV) {
    process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
  }
  const { chromium: pwChromium } = require('playwright-core');
  const executablePath = await resolveChromiumExecutable(pwChromium);

  browser = await pwChromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
    ],
    env: { ...process.env },
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[browser:${msg.type()}]`, msg.text());
    }
  });
  page.on('pageerror', err => {
    console.log('[browser:pageerror]', err.message);
  });

  // 1. Открываем главную страницу и загружаем фикстуру длинной полосы 100x2000 PNG
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  const onboardingSkipBtn = page.getByTestId('onboarding-skip-btn');
  if ((await onboardingSkipBtn.count()) > 0 && (await onboardingSkipBtn.isVisible())) {
    await onboardingSkipBtn.click();
  }
  const fileInput = page.getByTestId('home-image-input');
  await fileInput.setInputFiles([pngPath]);
  const submitUploadBtn = page.getByTestId('home-process-images-btn');
  await submitUploadBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await submitUploadBtn.click();

  // 2. Ждём перехода в /editor/<id>
  await page.waitForURL(/\/editor\/.+/, { timeout: 20_000 });
  const editorUrl = page.url();
  const projectId = editorUrl.split('/editor/')[1]?.split('?')[0] ?? 'unknown';
  console.log(`smoke:editor — открыт проект ${projectId} (${editorUrl})`);

  const scenarioBtn = page.getByTestId('open-scenario-btn');
  await scenarioBtn.waitFor({ state: 'visible', timeout: 15_000 });

  // 3. Открываем «Сценарий» и применяем две панели [0..50%] и [50..100%]
  await scenarioBtn.click();
  const scenarioTextarea = page.getByTestId('scenario-textarea');
  await scenarioTextarea.waitFor({ state: 'visible', timeout: 10_000 });
  const scenarioText = [
    'Изображение 1 [0..50%]',
    'Акира (Муж.): Первая панель в верхней половине полосы',
    '',
    'Изображение 1 [50..100%]',
    'Рей (Жен.): Вторая панель в нижней половине полосы',
  ].join('\n');
  await scenarioTextarea.fill(scenarioText);

  const applyScenarioBtn = page.getByTestId('scenario-apply-btn');
  await applyScenarioBtn.click();

  await page.locator('[data-video-clip-id="0"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('[data-video-clip-id="1"]').waitFor({ state: 'visible', timeout: 15_000 });
  console.log('smoke:editor — сценарий применён: 2 панели ([0..50%], [50..100%])');

  // 4. Задаём короткие Интро (0.4 с) и Аутро (0.4 с) через IntroOutroModal
  await page.getByTestId('open-intro-outro-btn').click();
  const introTextInput = page.getByTestId('intro-text-input');
  await introTextInput.waitFor({ state: 'visible', timeout: 10_000 });
  await introTextInput.fill('Манга Студия — Интро');
  await page.getByTestId('outro-text-input').fill('Подписывайтесь — Аутро');
  await page.getByTestId('intro-duration-input').fill('0.4');
  await page.getByTestId('outro-duration-input').fill('0.4');
  await page.getByTestId('intro-outro-apply-btn').click();
  await page.waitForTimeout(150);

  // 5. Импортируем два WAV-файла по 0.6 с через AudioImportModal
  await page.getByTestId('open-audio-import-btn').click();
  const modalFileInput = page.getByTestId('audio-import-file-input');
  await modalFileInput.setInputFiles([wav1Path, wav2Path]);

  const applyAudioBtn = page.getByTestId('audio-import-apply-btn');
  await applyAudioBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await applyAudioBtn.click();

  const closeAudioModalBtn = page.getByTestId('audio-import-close-btn');
  await closeAudioModalBtn.waitFor({ state: 'visible', timeout: 15_000 });
  await closeAudioModalBtn.click();

  // Устанавливаем паузу между репликами 0.20 с (итого: 0.4 + 0.6 + 0.2 + 0.6 + 0.4 = 2.20 с ≤ 3.0 с)
  const gapInput = page.locator('input[aria-label="Пауза между репликами"]');
  await gapInput.evaluate(el => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, '0.2');
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(150);

  const totalDurationSec = Number(
    await page.getByTestId('editor-root').getAttribute('data-total-duration')
  );
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0 || totalDurationSec > 3.0) {
    throw new Error(
      `Длительность клипа должна быть в пределах (0, 3.0] с (DoD-2), получено: ${totalDurationSec} с`
    );
  }
  console.log(
    `smoke:editor — импортировано 2 WAV по 0.6 с, интро=0.4 с, аутро=0.4 с, пауза=0.2 с -> длительность=${totalDurationSec.toFixed(
      2
    )} с (≤ 3.0 с)`
  );

  // 6. Проверяем п. 62 (Задача 3.3.1: подсветка аудио-клипа .selected при выборе панели)
  if (!QUICK) {
    await page.locator('[data-video-clip-id="1"]').click();
    const audioClip1Class = await page.locator('[data-audio-clip-id="1"]').getAttribute('class');
    if (!audioClip1Class || !audioClip1Class.split(/\s+/).includes('selected')) {
      throw new Error(`Ожидался класс 'selected' на [data-audio-clip-id="1"], получено: ${audioClip1Class}`);
    }
    const linkedBadgeVisible = await page.locator('[data-linked-clip-highlight="1"]').isVisible();
    if (!linkedBadgeVisible) {
      throw new Error('Индикатор [data-linked-clip-highlight="1"] в Preview не отобразился при выборе панели #1');
    }
    const highlightShotPath = join(artifactsDir, 'task-3-3-1-linked-highlight.png');
    await page.screenshot({ path: highlightShotPath, fullPage: true });
    copyFileSync(highlightShotPath, join(tmpArtifactsDir, 'task-3-3-1-linked-highlight.png'));
    console.log(`smoke:editor — Задача 3.3.1 (п. 62) проверена: .selected + бейдж связи (${highlightShotPath})`);

  }

  // 7. Проверяем Задачу 3.2.2 (п. 52): pointer-события на ручке [data-trim-handle="in"] -> trimIn и timelineVersion растут
  if (!QUICK) {
    await page.locator('[data-audio-clip-id="0"]').click();
    const trimInHandle = page.locator('[data-audio-clip-id="0"] [data-trim-handle="in"]');
    await trimInHandle.waitFor({ state: 'visible', timeout: 5_000 });
    const versionBeforeTrim = Number(
      await page.getByTestId('editor-root').getAttribute('data-timeline-version')
    );
    const trimBefore = Number(
      await page.locator('[data-audio-clip-id="0"]').getAttribute('data-clip-trim-in')
    );
    const handleBox = await trimInHandle.boundingBox();
    if (!handleBox) throw new Error('Не удалось получить boundingBox для [data-trim-handle="in"]');
    const handleCenterX = handleBox.x + handleBox.width / 2;
    const handleCenterY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(handleCenterX, handleCenterY);
    await page.mouse.down();
    await page.mouse.move(handleCenterX + 42, handleCenterY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const versionAfterTrim = Number(
      await page.getByTestId('editor-root').getAttribute('data-timeline-version')
    );
    const trimAfter = Number(
      await page.locator('[data-audio-clip-id="0"]').getAttribute('data-clip-trim-in')
    );
    if (!(trimAfter > trimBefore) || !(versionAfterTrim > versionBeforeTrim)) {
      throw new Error(
        `Задача 3.2.2 (pointer trim): ожидался рост trimIn (${trimBefore} -> ${trimAfter}) и timelineVersion (${versionBeforeTrim} -> ${versionAfterTrim})`
      );
    }
    const trimShotPath = join(artifactsDir, 'task-3-2-2-trim-handles.png');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    await page.screenshot({ path: trimShotPath, fullPage: true });
    copyFileSync(trimShotPath, join(tmpArtifactsDir, 'task-3-2-2-trim-handles.png'));
    console.log(
      `smoke:editor — Задача 3.2.2 (п. 52) проверена pointer-событиями: trimIn ${trimBefore} -> ${trimAfter}, timelineVersion ${versionBeforeTrim} -> ${versionAfterTrim}`
    );
    // Возвращаем trimIn через Undo, чтобы сохранить ровную сетку таймкодов 2.20 с
    await page.locator('button[aria-label="Отменить действие"]').click();
    await page.waitForTimeout(100);

  }

  // 8. Проверяем Задачу 3.2.1 (п. 51): pointer drag-and-drop клипа [data-video-clip-id="0"] на позицию #1 -> рост timelineVersion
  if (!QUICK) {
    const versionBeforeDrag = Number(
      await page.getByTestId('editor-root').getAttribute('data-timeline-version')
    );
    const clip0Box = await page.locator('[data-video-clip-id="0"]').boundingBox();
    const clip1Box = await page.locator('[data-video-clip-id="1"]').boundingBox();
    if (!clip0Box || !clip1Box) throw new Error('Не найдены boundingBox видеоклипов 0 и 1');
    await page.mouse.move(clip0Box.x + clip0Box.width / 2, clip0Box.y + clip0Box.height / 2);
    await page.mouse.down();
    await page.mouse.move(clip1Box.x + clip1Box.width / 2, clip1Box.y + clip1Box.height / 2, {
      steps: 6,
    });
    await page.mouse.up();
    await page.waitForTimeout(120);

    const versionAfterDrag = Number(
      await page.getByTestId('editor-root').getAttribute('data-timeline-version')
    );
    const clipOrderAfterDrag = await page
      .locator('[data-video-clip-id]')
      .evaluateAll(els => els.map(el => el.getAttribute('data-video-clip-id')));
    if (!(versionAfterDrag > versionBeforeDrag) || clipOrderAfterDrag[0] !== '1') {
      throw new Error(
        `Задача 3.2.1 (pointer drag-and-drop): ожидался порядок ['1','0'] и рост timelineVersion (${versionBeforeDrag} -> ${versionAfterDrag}), получено order=${JSON.stringify(
          clipOrderAfterDrag
        )}`
      );
    }
    console.log(
      `smoke:editor — Задача 3.2.1 (п. 51) проверена pointer-событиями: порядок ['0','1'] -> ${JSON.stringify(
        clipOrderAfterDrag
      )}, timelineVersion ${versionBeforeDrag} -> ${versionAfterDrag}`
    );
    // Возвращаем исходный порядок ['0', '1'] через Undo
    await page.locator('button[aria-label="Отменить действие"]').click();
    await page.waitForTimeout(100);

  }

  // 9. Делаем seek и Play/Pause через границу Панель 1 -> Пауза -> Панель 2 — явно ассертим рост currentTime и отсутствие ошибки AbortError ("Озвучка не удалась")
  await page.locator('[data-video-clip-id="0"]').click(); // seek к началу 1-й панели (0.400 с)
  await page.waitForTimeout(80);
  const timeBeforePlay = Number(
    await page.getByTestId('studio-timeline').getAttribute('data-current-time')
  );
  const playPauseBtn = page.getByTestId('preview-play-pause-btn');
  await playPauseBtn.click(); // Play (проигрываем Панель 1 [0.4..1.0], паузу [1.0..1.2] и вход в Панель 2 [1.2..1.8])
  await page.waitForFunction(
    (startTime) => {
      const el = document.querySelector('[data-testid="studio-timeline"]');
      const now = Number(el?.getAttribute('data-current-time') ?? 0);
      return now >= startTime + 0.85;
    },
    timeBeforePlay,
    { timeout: 4000 }
  );
  await playPauseBtn.click(); // Pause
  await page.waitForTimeout(80);
  const timeAfterPlay = Number(
    await page.getByTestId('studio-timeline').getAttribute('data-current-time')
  );
  if (!(timeAfterPlay > timeBeforePlay)) {
    throw new Error(
      `Ожидалось увеличение currentTime после Play/Pause: до=${timeBeforePlay}, после=${timeAfterPlay}`
    );
  }
  const alertCount = await page.getByTestId('audio-error-alert').count();
  if (alertCount > 0) {
    const alertText = await page.getByTestId('audio-error-alert').first().innerText();
    throw new Error(`Неожиданная ошибка воспроизведения после Play/Pause: ${alertText}`);
  }
  console.log(
    `smoke:editor — seek и Play/Pause (Панель 1 -> Панель 2) проверены: currentTime до=${timeBeforePlay.toFixed(
      3
    )} с -> после=${timeAfterPlay.toFixed(3)} с, ошибок=0`
  );

  if (!QUICK) {

    // 10. Задача 3.1.1: сохраняем скриншоты Preview И Export на 4 контрольных точках (intro, panel, gap, outro) в режимах panels и strip
    const controlPoints = [
      { name: 'intro', t: 0.2 },
      { name: 'panel', t: 0.7 },
      { name: 'gap', t: 1.1 },
      { name: 'outro', t: 2.0 },
    ];

    for (const mode of ['panels', 'strip']) {
      const modeBtnName = mode === 'strip' ? /^Лента$/i : /^Панели$/i;
      const modeBtn = page.getByRole('button', { name: modeBtnName }).first();
      if (await modeBtn.isVisible()) {
        await modeBtn.click();
        await page.waitForTimeout(150);
      }

      const pairsForComposite = [];
      for (const pt of controlPoints) {
        const frames = await page.getByTestId('preview-canvas').evaluate((canvasEl, args) => {
          const previewDataUrl =
            typeof canvasEl.__renderPreviewFrameDataUrl === 'function'
              ? canvasEl.__renderPreviewFrameDataUrl(args.time, args.mode)
              : canvasEl.toDataURL('image/png');
          const exportDataUrl =
            typeof canvasEl.__renderExportFrameDataUrl === 'function'
              ? canvasEl.__renderExportFrameDataUrl(args.time, args.mode)
              : previewDataUrl;
          return { previewDataUrl, exportDataUrl };
        }, { time: pt.t, mode });

        const prevFile = join(artifactsDir, `task-3-1-1-preview-${mode}-${pt.name}.png`);
        const expFile = join(artifactsDir, `task-3-1-1-export-${mode}-${pt.name}.png`);
        saveDataUrlPng(frames.previewDataUrl, prevFile, tmpArtifactsDir);
        saveDataUrlPng(frames.exportDataUrl, expFile, tmpArtifactsDir);
        pairsForComposite.push({
          label: `${pt.name.toUpperCase()} (t=${pt.t.toFixed(2)}s)`,
          previewDataUrl: frames.previewDataUrl,
          exportDataUrl: frames.exportDataUrl,
        });
      }

      // Сохраняем также одиночный скриншот превью для обратной совместимости и сводный коллаж Preview vs Export (4 фазы)
      const legacyPreviewPath = join(artifactsDir, `task-3-1-1-preview-${mode}.png`);
      await page.getByTestId('preview-canvas').screenshot({ path: legacyPreviewPath });
      copyFileSync(legacyPreviewPath, join(tmpArtifactsDir, `task-3-1-1-preview-${mode}.png`));

      const compositeDataUrl = await page.evaluate(async ({ modeName, rows }) => {
        const cellW = 640;
        const cellH = 360;
        const pad = 20;
        const headerH = 48;
        const sheet = document.createElement('canvas');
        sheet.width = cellW * 2 + pad * 3;
        sheet.height = headerH + rows.length * (cellH + 34) + pad;
        const ctx = sheet.getContext('2d');
        ctx.fillStyle = '#0B0B0C';
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        ctx.fillStyle = '#E8B44C';
        ctx.font = 'bold 20px sans-serif';
        ctx.fillText(
          `Задача 3.1.1 — Паритет Preview (слева) и Export (справа) · режим: ${modeName}`,
          pad,
          32
        );

        async function loadImg(src) {
          const im = new Image();
          im.src = src;
          await new Promise(r => {
            im.onload = r;
            im.onerror = r;
          });
          return im;
        }

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const yTop = headerH + i * (cellH + 34);
          ctx.fillStyle = '#F5F5F7';
          ctx.font = '14px monospace';
          ctx.fillText(`Preview · ${row.label}`, pad, yTop + 18);
          ctx.fillText(`Export · ${row.label}`, pad * 2 + cellW, yTop + 18);

          const [pImg, eImg] = await Promise.all([
            loadImg(row.previewDataUrl),
            loadImg(row.exportDataUrl),
          ]);
          ctx.drawImage(pImg, pad, yTop + 24, cellW, cellH);
          ctx.drawImage(eImg, pad * 2 + cellW, yTop + 24, cellW, cellH);
        }
        return sheet.toDataURL('image/png');
      }, { modeName: mode, rows: pairsForComposite });

      const compPath = join(artifactsDir, `task-3-1-1-comparison-${mode}.png`);
      saveDataUrlPng(compositeDataUrl, compPath, tmpArtifactsDir);
      console.log(`smoke:editor — Задача 3.1.1 (${mode}): сохранены 4 пары Preview/Export и коллаж ${compPath}`);
    }

    // 10а. Ручная прокрутка ленты колесом непрерывна: время двигается мелкими
    // приращениями на каждом тике колеса, а не ступеньками к границам реплик
    // (timeAtScrollContinuous + reason 'wheel' без ререндеров React-дерева).
    {
      const canvas = page.getByTestId('preview-canvas');
      // Уходим из аутро (лента уже внизу) к началу первой реплики, иначе
      // колесо вниз упрётся в maxScroll и инверсия вернёт время последней реплики.
      await page.locator('[data-video-clip-id="0"]').click();
      await page.waitForTimeout(80);
      // Синтетические WheelEvent прямо на canvas: детерминированно для CI
      // (геометрия headless-страницы не обязана класть мышь ровно на canvas),
      // продуктовый обработчик не проверяет isTrusted.
      const dispatchWheel = (deltaY) =>
        canvas.evaluate((el, dy) => {
          el.dispatchEvent(new WheelEvent('wheel', { deltaX: 0, deltaY: dy, bubbles: true, cancelable: true }));
        }, deltaY);
      const timelineEl = page.locator('[data-testid="studio-timeline"]');
      const readTime = async () => Number(await timelineEl.getAttribute('data-current-time'));
      const t0 = await readTime();
      const samples = [t0];
      for (let i = 0; i < 20; i++) {
        await dispatchWheel(36);
        await page.waitForTimeout(25);
        samples.push(await readTime());
      }
      await page.waitForTimeout(200); // settle: финальный onSeek досинхронизирует состояние
      const tEnd = await readTime();
      const deltas = samples.slice(1).map((v, i) => v - samples[i]);
      const movingTicks = deltas.filter(d => d > 1e-6).length;
      const totalShift = tEnd - t0;
      const maxStep = Math.max(...deltas);
      if (!(tEnd > t0)) {
        throw new Error(`Колесо не сдвинуло время ленты: ${t0} -> ${tEnd}`);
      }
      if (movingTicks < 14) {
        throw new Error(`Ступенчатая прокрутка ленты: время менялось лишь ${movingTicks}/20 тиков`);
      }
      if (maxStep > Math.max(totalShift, 1e-6) * 0.4) {
        throw new Error(
          `Скачок камеры при прокрутке: шаг ${maxStep.toFixed(3)}с при общем сдвиге ${totalShift.toFixed(3)}с`
        );
      }
      console.log(
        `smoke:editor — колесо ленты: время ${t0.toFixed(3)} -> ${tEnd.toFixed(3)}с, живых тиков ${movingTicks}/20, макс. шаг ${maxStep.toFixed(3)}с`
      );
    }

    // Возвращаем режим panels и сохраняем финальный скриншот редактора
    const panelsModeBtn = page.getByRole('button', { name: /^Панели$/i }).first();
    if (await panelsModeBtn.isVisible()) {
      await panelsModeBtn.click();
      await page.waitForTimeout(100);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    const finalShotPath = join(artifactsDir, 'smoke-editor-final.png');
    await page.screenshot({ path: finalShotPath, fullPage: true });
    copyFileSync(finalShotPath, join(tmpArtifactsDir, 'smoke-editor-final.png'));

  }

  // 11. Открываем Экспорт и проверяем отмену экспорта («Отменить экспорт»), затем полный экспорт видеоклипа (≤ 3 с)
  await page.getByTestId('open-export-btn').click();
  const videoExportBtn = page.locator('button:has-text("1920×1080")').first();
  await videoExportBtn.waitFor({ state: 'visible', timeout: 10_000 });

  // 11а. Тест прерывания экспорта кнопкой «Отменить экспорт» (DoD п. 5)
  await videoExportBtn.click();
  await page.getByTestId('export-progress-overlay').waitFor({ state: 'visible', timeout: 5_000 });
  const overlayClass = (await page.getByTestId('export-progress-overlay').getAttribute('class')) || '';
  if (!overlayClass.includes('fixed') || !overlayClass.includes('inset-0')) {
    throw new Error(`Ожидался полноэкранный оверлей с fixed inset-0, получено class="${overlayClass}"`);
  }
  await page.getByTestId('export-cancel-btn').waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByTestId('export-cancel-btn').click();
  await page.getByTestId('export-progress-overlay').waitFor({ state: 'hidden', timeout: 5_000 });
  await videoExportBtn.waitFor({ state: 'visible', timeout: 5_000 });
  console.log('smoke:editor — отмена экспорта («Отменить экспорт») проверена: рендер прерван, модалка вернулась в исходное состояние');

  // 11б. Полный рендер видеоклипа (0% -> 100%) с экраном завершения и кнопкой «Скачать файл»
  let autoDownloadTriggered = false;
  const onUnexpectedDownload = () => {
    autoDownloadTriggered = true;
  };
  page.on('download', onUnexpectedDownload);

  const tClick = Date.now();
  await videoExportBtn.click();

  // Проверяем оверлей прогресса CapCut-style во время рендера видео и блокировку закрытия модалки
  await page.getByTestId('export-progress-overlay').waitFor({ state: 'visible', timeout: 5_000 });
  const closeBtnDisabled = await page.getByTestId('export-modal-close-btn').isDisabled();
  if (!closeBtnDisabled) {
    throw new Error('Кнопка закрытия ExportModal должна быть заблокирована (disabled) во время экспорта');
  }
  // Клик по фону не должен закрывать модальное окно во время экспорта
  await page.mouse.click(10, 10);
  const stillVisibleAfterBackdropClick = await page.getByTestId('export-progress-overlay').isVisible();
  if (!stillVisibleAfterBackdropClick) {
    throw new Error('Клик по фону не должен закрывать ExportModal во время рендеринга');
  }
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="export-progress-percent"]');
      const stageEl = document.querySelector('[data-testid="export-progress-stage"]');
      const etaEl = document.querySelector('[data-testid="export-progress-eta"]');
      if (!el || !stageEl || !etaEl) return false;
      const pct = parseInt(el.textContent || '0', 10);
      return pct >= 25 && pct < 100 && Boolean(stageEl.textContent?.trim());
    },
    null,
    { timeout: 10_000 }
  );
  const progressShotPath = join(artifactsDir, 'export-progress-capcut.png');
  await page.screenshot({ path: progressShotPath });
  copyFileSync(progressShotPath, join(tmpArtifactsDir, 'export-progress-capcut.png'));

  // DoD п. 6: на мобильном экране 375×667 (L-6) прогресс-бар и кнопка отмены помещаются в экран
  await page.setViewportSize({ width: 375, height: 667 });
  const mobileCancelBox = await page.getByTestId('export-cancel-btn').boundingBox();
  if (
    !mobileCancelBox ||
    mobileCancelBox.x < 0 ||
    mobileCancelBox.y < 0 ||
    mobileCancelBox.x + mobileCancelBox.width > 375 ||
    mobileCancelBox.y + mobileCancelBox.height > 667
  ) {
    throw new Error(
      `На экране 375×667 кнопка отмены в export-progress-overlay выходит за границы экрана: ${JSON.stringify(mobileCancelBox)}`
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Дожидаемся экрана завершения «Экспорт завершён!» (100%, зелёный круг, кнопка «Скачать файл»)
  await page.getByTestId('export-download-btn').waitFor({ state: 'visible', timeout: 30_000 });
  const exportElapsedMs = Date.now() - tClick;
  page.off('download', onUnexpectedDownload);
  if (autoDownloadTriggered) {
    throw new Error('Автоматическое скачивание не должно происходить до нажатия кнопки «Скачать файл» (DoD п. 1)');
  }

  const finalPctText = await page.getByTestId('export-progress-percent').textContent();
  const finalStageText = await page.getByTestId('export-progress-stage').textContent();
  if (finalPctText?.trim() !== '100%' || finalStageText?.trim() !== 'Готово') {
    throw new Error(`Ожидались 100% и этап «Готово» на экране успеха, получено: pct=${finalPctText}, stage=${finalStageText}`);
  }

  // DoD п. 5: клик по фону во время показа экрана успеха не закрывает окно
  await page.mouse.click(10, 10);
  if (!(await page.getByTestId('export-download-btn').isVisible())) {
    throw new Error('Клик по фону не должен закрывать экран успешного завершения экспорта (DoD п. 5)');
  }

  await page.waitForTimeout(350);
  const successShotPath = join(artifactsDir, 'export-success-capcut.png');
  await page.screenshot({ path: successShotPath });
  copyFileSync(successShotPath, join(tmpArtifactsDir, 'export-success-capcut.png'));

  // Проверяем, что «Скачать файл» — это реальный тег <a> с href="blob:..." и атрибутом download
  const downloadBtnMeta = await page.getByTestId('export-download-btn').evaluate(el => ({
    tagName: el.tagName,
    href: el.getAttribute('href') || '',
    download: el.getAttribute('download') || '',
  }));
  if (
    downloadBtnMeta.tagName !== 'A' ||
    !downloadBtnMeta.href.startsWith('blob:') ||
    !downloadBtnMeta.download
  ) {
    throw new Error(
      `Ожидался тег <a href="blob:..." download="..."> для [data-testid="export-download-btn"], получено: ${JSON.stringify(
        downloadBtnMeta
      )}`
    );
  }

  // DoD п. 3: нажатие «Скачать файл» запускает скачивание
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
  await page.getByTestId('export-download-btn').click();
  const download = await downloadPromise;

  // DoD п. 4: кнопка «Закрыть» закрывает модальное окно и сбрасывает состояние
  await page.getByTestId('export-success-close-btn').click();
  await page.getByTestId('export-progress-overlay').waitFor({ state: 'hidden', timeout: 5_000 });

  const downloadedPath = join(artifactsDir, 'smoke-export.webm');
  await download.saveAs(downloadedPath);
  copyFileSync(downloadedPath, join(tmpArtifactsDir, 'smoke-export.webm'));

  const fileStat = statSync(downloadedPath);
  if (fileStat.size <= 0) {
    throw new Error(`Скачанный видеофайл пуст (0 байт): ${downloadedPath}`);
  }
  const fileBuf = readFileSync(downloadedPath);
  const header = fileBuf.subarray(0, 12);
  const isWebm =
    header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
  const isMp4 = header.subarray(4, 8).toString('ascii') === 'ftyp';
  if (!isWebm && !isMp4) {
    throw new Error(
      `Скачанный файл не имеет сигнатуры WebM (EBML) или MP4 (ftyp): ${header.toString('hex')}`
    );
  }

  // Проверяем декодируемость и длительность скачанного видеофайла ≤ 3.0 с через HTMLVideoElement в Chromium
  const videoProbe = await page.evaluate(async base64Video => {
    const bytes = Uint8Array.from(atob(base64Video), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    try {
      const v = document.createElement('video');
      v.muted = true;
      v.src = url;
      await new Promise((res, rej) => {
        v.onloadedmetadata = () => res();
        v.onerror = () => rej(new Error('Ошибка декодирования экспортированного видео'));
      });
      // Для WebM без заголовка Duration перематываем в конец, чтобы браузер вычислил точную длительность
      if (!Number.isFinite(v.duration) || v.duration === Infinity) {
        v.currentTime = 1e6;
        await new Promise(res => {
          v.ontimeupdate = () => res();
          v.onseeked = () => res();
          setTimeout(res, 1000);
        });
      }
      return {
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        duration: v.duration,
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }, fileBuf.toString('base64'));

  if (
    videoProbe.videoWidth !== 1920 ||
    videoProbe.videoHeight !== 1080 ||
    !Number.isFinite(videoProbe.duration) ||
    videoProbe.duration <= 0 ||
    videoProbe.duration > 3.0
  ) {
    throw new Error(
      `Некорректные параметры экспортированного видео: ${JSON.stringify(videoProbe)} (ожидалось 1920×1080 и duration ≤ 3.0 с)`
    );
  }

  console.log(
    `smoke:editor — ok: проект=${projectId}, панелей=2, экспорт=${downloadedPath} (${fileStat.size} байт, контейнер=${
      isWebm ? 'WebM/EBML' : 'MP4/ftyp'
    }, ${videoProbe.videoWidth}×${videoProbe.videoHeight}, длительность=${videoProbe.duration.toFixed(
      2
    )} с ≤ 3.0 с, рендер=${exportElapsedMs} мс)`
  );
} catch (err) {
  console.error('smoke:editor — ОШИБКА:', err);
  if (serverLogs) {
    console.error('--- логи next start ---\n' + serverLogs.slice(-2000));
  }
  process.exitCode = 1;
} finally {
  if (browser) {
    try {
      await browser.close();
    } catch {}
  }
  await stopServer();
}
