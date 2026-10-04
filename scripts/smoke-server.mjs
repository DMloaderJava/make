#!/usr/bin/env node
/**
 * Smoke-проверка прод-сборки: `next start` действительно поднимается и отвечает.
 *
 * Зачем: зелёная сборка (`next build`) не гарантирует, что сервер стартует —
 * падение на старте (битая env, отсутствующий чанк, кривой конфиг) видно только
 * при запуске. Раньше это проверялось руками через curl; теперь — шагом CI.
 *
 * Что проверяем:
 *   - `/` и `/settings` отвечают 200 (страницы отрендерились);
 *   - `/editor/[id]` отвечает 200 (динамический роут редактора);
 *   - `POST /api/tts` с пустым телом отвечает 400 (роут жив и валидирует вход,
 *     а не падает 500).
 *
 * Чего НЕ проверяем: браузерные пути (экспорт через WebCodecs, MediaRecorder,
 * OPFS) — для них нужен настоящий Chromium (Playwright), которого в песочнице
 * сборки нет. Это честная граница: smoke ловит «сервер не поднялся», но не
 * «кнопка не работает».
 *
 * Запуск: `npm run smoke:server` после `npm run build`.
 */
import { spawn } from 'node:child_process';

const PORT = Number(process.env.SMOKE_PORT || 3311);
const BASE = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 60_000;

const checks = [
  { method: 'GET', path: '/', expect: 200 },
  { method: 'GET', path: '/settings', expect: 200 },
  { method: 'GET', path: '/editor/smoke-probe', expect: 200 },
  { method: 'POST', path: '/api/tts', body: {}, expect: 400 },
];

const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
});

let log = '';
server.stdout.on('data', chunk => { log += chunk; });
server.stderr.on('data', chunk => { log += chunk; });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`сервер завершился на старте с кодом ${server.exitCode}`);
    }
    try {
      // redirect: 'manual' — 307 на логин (если задан MVS_PASSWORD) тоже признак
      // живого сервера; 500 и выше — уже нет.
      const res = await fetch(`${BASE}/`, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      // сервер ещё не слушает порт — ждём
    }
    await sleep(500);
  }
  throw new Error(`сервер не поднялся за ${START_TIMEOUT_MS / 1000} с`);
}

let failed = false;
try {
  await waitForServer();
  for (const check of checks) {
    const res = await fetch(BASE + check.path, {
      method: check.method,
      headers: check.body ? { 'Content-Type': 'application/json' } : undefined,
      body: check.body ? JSON.stringify(check.body) : undefined,
      redirect: 'manual',
    });
    const ok = res.status === check.expect;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${check.method} ${check.path} → ${res.status} (ждали ${check.expect})`);
    if (!ok && check.path.startsWith('/api')) {
      console.log('      тело ответа:', (await res.text()).slice(0, 200));
    }
  }
} catch (error) {
  failed = true;
  console.error(`smoke:server — ${error.message}`);
} finally {
  server.kill('SIGTERM');
  await sleep(500);
  if (server.exitCode === null) server.kill('SIGKILL');
}

if (failed) {
  console.error('--- лог сервера (хвост) ---');
  console.error(log.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('smoke:server — ok: прод-сборка стартует и отвечает');
