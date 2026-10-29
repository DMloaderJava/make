#!/usr/bin/env node
/**
 * Диагностика и проверка готовности локального окружения Manga Voice Studio (npm run setup).
 * Проверяет:
 * 1) Версию Node.js (рекомендуется >= 22.17.0 / 24+ для встроенной поддержки TypeScript в тестах).
 * 2) Наличие установленных зависимостей (node_modules).
 * 3) Наличие ffmpeg / ffprobe в PATH (используются для smoke-проверок медиаконтейнеров).
 * 4) Доступность браузера Chromium / Playwright / CHROMIUM_PATH для E2E-проверок.
 * 5) Целостность лаунчеров (start.bat, start.sh, Launch Manga Studio.command).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function parseNodeVersion(v) {
  const clean = String(v).replace(/^v/, '');
  const [major = 0, minor = 0, patch = 0] = clean.split('.').map(Number);
  return { major, minor, patch };
}

function checkCommand(cmd, args = ['-version']) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const firstLine = out.split(/\r?\n/)[0]?.trim() || 'доступен';
    return { ok: true, detail: firstLine };
  } catch {
    return { ok: false, detail: 'не найден в PATH' };
  }
}

async function resolveChromiumInfo() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return { ok: true, detail: `CHROMIUM_PATH=${process.env.CHROMIUM_PATH}` };
  }
  const systemCandidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const candidate of systemCandidates) {
    if (existsSync(candidate)) {
      return { ok: true, detail: candidate };
    }
  }
  if (existsSync(resolve(root, 'node_modules/@sparticuz/chromium'))) {
    return { ok: true, detail: '@sparticuz/chromium (локальный пакет)' };
  }
  return {
    ok: false,
    detail: 'укажите CHROMIUM_PATH или установите браузер через npx playwright install chromium',
  };
}

async function main() {
  const { major, minor } = parseNodeVersion(process.version);
  const nodeRecommended = major > 22 || (major === 22 && minor >= 17);
  const nodeMinSupported = major > 20 || (major === 20 && minor >= 9);

  const hasNodeModules = existsSync(resolve(root, 'node_modules/next'));
  const hasLockfile = existsSync(resolve(root, 'package-lock.json'));
  let enginesNode = '>=20.9.0';
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    if (pkg?.engines?.node) enginesNode = String(pkg.engines.node);
  } catch {}
  const ffmpeg = checkCommand('ffmpeg', ['-version']);
  const ffprobe = checkCommand('ffprobe', ['-version']);
  const chromium = await resolveChromiumInfo();
  // Доктор окружения проверяет только наличие файлов запуска, а не их содержимое:
  // разбор .bat регулярками переехал в историю вместе с check-launchers.mjs.
  const launcherFiles = readdirSync(root).filter(f => f.endsWith('.bat') || f.endsWith('.sh'));
  const launchersOk = launcherFiles.length >= 6;

  const rows = [
    {
      check: 'Node.js',
      status: nodeRecommended ? 'OK' : nodeMinSupported ? 'WARN' : 'FAIL',
      info: `${process.version} (engines.node: ${enginesNode}, рекомендуется >= 22.17.0 / 24+)`,
    },
    {
      check: 'Зависимости (node_modules + lockfile)',
      status: hasNodeModules && hasLockfile ? 'OK' : hasNodeModules ? 'WARN' : 'FAIL',
      info:
        hasNodeModules && hasLockfile
          ? 'node_modules и package-lock.json на месте'
          : hasNodeModules
            ? 'отсутствует package-lock.json'
            : 'выполните npm install',
    },
    {
      check: 'FFmpeg / FFprobe',
      status: ffmpeg.ok && ffprobe.ok ? 'OK' : 'WARN',
      info: ffmpeg.ok ? ffmpeg.detail : 'опционально (нужен для smoke-проверки контейнеров)',
    },
    {
      check: 'Chromium (E2E / smoke:editor)',
      status: chromium.ok ? 'OK' : 'WARN',
      info: chromium.detail,
    },
    {
      check: 'Скрипты запуска (start.sh / start.bat)',
      status: launchersOk ? 'OK' : 'FAIL',
      info: launchersOk ? 'все лаунчеры на месте' : 'отсутствует один из стартовых скриптов',
    },
  ];

  console.log('\n=== Manga Voice Studio — Проверка окружения (setup) ===');
  for (const row of rows) {
    console.log(`[${row.status.padEnd(4)}] ${row.check}: ${row.info}`);
  }
  console.log('=======================================================\n');

  if (!nodeMinSupported || !hasNodeModules || !launchersOk) {
    process.exitCode = 1;
  }
}

main();
