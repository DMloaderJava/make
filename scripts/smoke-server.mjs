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
 * Если порт занят чужим процессом (наш next не смог стартовать), запросы всё
 * равно ограничены таймаутом — прогон завершается с внятной ошибкой, а не висит.
 *
 * Ещё проверяем, что после остановки сервера порт действительно освободился:
 * именно за этим на Windows нужен `taskkill /T /F` — иначе повторный прогон
 * упадёт с EADDRINUSE, а CI (один прогон на job) этого не заметит.
 *
 * Чего НЕ проверяем: браузерные пути (экспорт через WebCodecs, MediaRecorder,
 * OPFS) — для них нужен настоящий Chromium (Playwright), которого в песочнице
 * сборки нет. Это честная граница: smoke ловит «сервер не поднялся», но не
 * «кнопка не работает».
 *
 * Запуск: `npm run smoke:server` после `npm run build`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect } from 'node:net';

/**
 * Путь к бинарю next ищем через резолвер Node, а не строкой 'node_modules/next/…':
 * при pnpm/yarn раскладка node_modules другая, и жёсткий путь падал бы.
 */
const require = createRequire(import.meta.url);
let nextBin;
try {
  nextBin = require.resolve('next/dist/bin/next');
} catch {
  console.error('smoke:server — не найден next. Установите зависимости: npm ci --ignore-scripts --no-audit --no-fund');
  process.exit(2);
}

const PORT = Number(process.env.SMOKE_PORT || 3311);
// Таймаут на каждый запрос: без него fetch к «чужому» слушателю на нашем порту
// (процесс есть, HTTP не отвечает) висел бы бесконечно — прогон не завершался.
const REQUEST_TIMEOUT_MS = 5000;
const BASE = `http://127.0.0.1:${PORT}`;
const START_TIMEOUT_MS = 60_000;

const checks = [
  { method: 'GET', path: '/', expect: 200 },
  { method: 'GET', path: '/settings', expect: 200 },
  { method: 'GET', path: '/editor/smoke-probe', expect: 200 },
  { method: 'POST', path: '/api/tts', body: {}, expect: 400 },
];

const server = spawn(process.execPath, [nextBin, 'start', '-p', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production' },
});

let log = '';
server.stdout.on('data', chunk => { log += chunk; });
server.stderr.on('data', chunk => { log += chunk; });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Гасит сервер вместе с потомками.
 *
 * На Windows SIGTERM/SIGKILL — не сигналы: Node эмулирует их терминацией
 * процесса, но дочерние процессы next (если появятся) выживут, и порт 3311
 * останется занятым — следующий запуск упадёт с EADDRINUSE. `taskkill /T /F`
 * снимает всё дерево.
 */
function killServerTree(child, force = false) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

/** Занят ли порт: успешное TCP-соединение = кто-то слушает. */
function isPortBusy(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = busy => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortBusy(port))) return true;
    await sleep(250);
  }
  return !(await isPortBusy(port));
}

async function waitForServer() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`сервер завершился на старте с кодом ${server.exitCode}`);
    }
    try {
      // redirect: 'manual' — 307 на логин (если задан MVS_PASSWORD) тоже признак
      // живого сервера; 500 и выше — уже нет.
      const res = await fetch(`${BASE}/`, { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
  killServerTree(server);
  await sleep(500);
  if (server.exitCode === null) killServerTree(server, true);

  // Порт должен освободиться: на Windows `TerminateProcess` без `/T` оставляет
  // потомков держать сокет, и следующий прогон падает с EADDRINUSE.
  if (!(await waitForPortFree(PORT))) {
    failed = true;
    console.error(`smoke:server — порт ${PORT} не освободился после остановки сервера`);
  }
}

if (failed) {
  console.error('--- лог сервера (хвост) ---');
  console.error(log.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('smoke:server — ok: прод-сборка стартует и отвечает');
