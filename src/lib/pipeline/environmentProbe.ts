/**
 * Диагностика возможностей браузерного окружения для Onboarding Wizard (v1.3.18).
 *
 * Проверяет 5 ключевых пунктов:
 * 1) OPFS (Origin Private File System) — хранение оригиналов изображений и аудио без раздувания IndexedDB.
 * 2) IndexedDB — база проектов, ревизий и метаданных.
 * 3) WebCodecs H.264 + AAC (mediabunny) — ускоренный MP4-экспорт видео.
 * 4) MediaRecorder VP9/VP8 + Opus — резервный WebM-экспорт видео.
 * 5) Браузер Chromium ≥ 120 — целевой движок рендера и аудиографа.
 */

import { checkCapabilities } from './videoEncoder';
import { isOPFSSupported } from '../storage/opfs';

export type ProbeStatus = 'ok' | 'warn' | 'fail';
export type ProbeIcon = '✅' | '⚠' | '❌';

export interface EnvironmentCheckItem {
  id: 'opfs' | 'indexeddb' | 'webcodecs' | 'mediarecorder' | 'chromium';
  label: string;
  status: ProbeStatus;
  icon: ProbeIcon;
  detail: string;
}

export interface EnvironmentProbeReport {
  items: EnvironmentCheckItem[];
  allReady: boolean;
  hasBlocker: boolean;
  freeBytes: number | null;
  quotaBytes: number | null;
}

export interface EnvironmentProbeDeps {
  isOPFSSupported?: () => boolean;
  hasIndexedDB?: () => boolean;
  checkCapabilities?: () => Promise<{
    webCodecs: boolean;
    h264: boolean;
    aac: boolean;
    mediaRecorder?: boolean;
    mediabunny: boolean;
  }>;
  isMediaRecorderTypeSupported?: (mimeType: string) => boolean;
  estimateStorage?: () => Promise<{ usage?: number; quota?: number } | null>;
  getUserAgent?: () => string;
  getChromiumMajor?: () => number | null;
}

function statusToIcon(status: ProbeStatus): ProbeIcon {
  if (status === 'ok') return '✅';
  if (status === 'warn') return '⚠';
  return '❌';
}

export function parseChromiumMajorFromUA(userAgent: string): number | null {
  if (!userAgent) return null;
  const match = userAgent.match(/(?:Chrom(?:e|ium)|HeadlessChrome)\/(\d+)/i);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

function formatMegabytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'неизвестно';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} ГБ`;
  return `${Math.round(mb)} МБ`;
}

export async function evaluateEnvironment(
  deps: EnvironmentProbeDeps = {}
): Promise<EnvironmentProbeReport> {
  const opfsCheck = deps.isOPFSSupported ?? isOPFSSupported;
  const idbCheck =
    deps.hasIndexedDB ??
    (() => typeof globalThis !== 'undefined' && typeof (globalThis as any).indexedDB !== 'undefined');
  const capsCheck = deps.checkCapabilities ?? checkCapabilities;
  const mrCheck =
    deps.isMediaRecorderTypeSupported ??
    ((mime: string) => {
      try {
        return (
          typeof MediaRecorder !== 'undefined' &&
          typeof MediaRecorder.isTypeSupported === 'function' &&
          MediaRecorder.isTypeSupported(mime)
        );
      } catch {
        return false;
      }
    });
  const estimateFn =
    deps.estimateStorage ??
    (async () => {
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.storage &&
          typeof navigator.storage.estimate === 'function'
        ) {
          return await navigator.storage.estimate();
        }
      } catch {}
      return null;
    });
  const uaString =
    deps.getUserAgent?.() ??
    (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '');
  const chromiumMajor =
    deps.getChromiumMajor !== undefined
      ? deps.getChromiumMajor()
      : parseChromiumMajorFromUA(uaString);

  let freeBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const est = await estimateFn();
    if (est && typeof est.quota === 'number' && Number.isFinite(est.quota) && est.quota > 0) {
      quotaBytes = est.quota;
      const usage = typeof est.usage === 'number' && Number.isFinite(est.usage) ? est.usage : 0;
      freeBytes = Math.max(0, est.quota - usage);
    }
  } catch {
    freeBytes = null;
    quotaBytes = null;
  }

  const opfsSupported = Boolean(opfsCheck());
  const idbSupported = Boolean(idbCheck());
  const caps = await capsCheck();
  const vp9Opus =
    mrCheck('video/webm;codecs=vp9,opus') ||
    mrCheck('video/webm;codecs=vp8,opus') ||
    mrCheck('video/webm');

  const items: EnvironmentCheckItem[] = [];

  // 1. OPFS
  const opfsStatus: ProbeStatus = opfsSupported ? 'ok' : 'warn';
  const storageSuffix =
    freeBytes !== null ? ` (свободно ~${formatMegabytes(freeBytes)})` : '';
  items.push({
    id: 'opfs',
    label: 'Файловое хранилище OPFS',
    status: opfsStatus,
    icon: statusToIcon(opfsStatus),
    detail: opfsSupported
      ? `Доступно для хранения медиафайлов проекта${storageSuffix}`
      : 'OPFS недоступен — медиа будет храниться в памяти/IndexedDB (ограниченный объём)',
  });

  // 2. IndexedDB
  const idbStatus: ProbeStatus = idbSupported ? 'ok' : 'fail';
  items.push({
    id: 'indexeddb',
    label: 'База проектов IndexedDB',
    status: idbStatus,
    icon: statusToIcon(idbStatus),
    detail: idbSupported
      ? 'Доступна для сохранения проектов, таймлайна и истории ревизий'
      : 'IndexedDB отключена или заблокирована (приватный режим браузера)',
  });

  // 3. WebCodecs H.264
  const webcodecsOk = Boolean(caps.webCodecs && caps.h264 && caps.mediabunny);
  const webcodecsStatus: ProbeStatus = webcodecsOk ? 'ok' : 'warn';
  items.push({
    id: 'webcodecs',
    label: 'Ускоренный рендер WebCodecs (MP4 H.264)',
    status: webcodecsStatus,
    icon: statusToIcon(webcodecsStatus),
    detail: webcodecsOk
      ? 'Аппаратное кодирование MP4 (H.264 + AAC через mediabunny) активно'
      : 'WebCodecs H.264 недоступен — экспорт автоматически переключится на WebM (MediaRecorder)',
  });

  // 4. MediaRecorder VP9/Opus
  const mrAvailable = Boolean((caps as { mediaRecorder?: boolean }).mediaRecorder || vp9Opus);
  const mrStatus: ProbeStatus = vp9Opus ? 'ok' : mrAvailable ? 'warn' : !webcodecsOk ? 'fail' : 'warn';
  items.push({
    id: 'mediarecorder',
    label: 'Запись потока MediaRecorder (WebM VP9/Opus)',
    status: mrStatus,
    icon: statusToIcon(mrStatus),
    detail: vp9Opus
      ? 'Поддерживается запись WebM с кодеками VP9/VP8 + Opus'
      : mrAvailable
        ? 'MediaRecorder доступен в базовом режиме контейнера'
        : 'MediaRecorder недоступен в текущем браузере',
  });

  // 5. Chromium >= 120
  let chromiumStatus: ProbeStatus = 'warn';
  let chromiumDetail = 'Не удалось определить версию Chromium (рекомендуется Chrome/Edge/Electron ≥ 120)';
  if (chromiumMajor !== null) {
    if (chromiumMajor >= 120) {
      chromiumStatus = 'ok';
      chromiumDetail = `Обнаружен Chromium v${chromiumMajor} (≥ 120 — полная совместимость)`;
    } else {
      chromiumStatus = 'warn';
      chromiumDetail = `Обнаружен Chromium v${chromiumMajor} (рекомендуется обновить до ≥ 120)`;
    }
  }
  items.push({
    id: 'chromium',
    label: 'Браузерный движок Chromium ≥ 120',
    status: chromiumStatus,
    icon: statusToIcon(chromiumStatus),
    detail: chromiumDetail,
  });

  const hasBlocker = items.some(item => item.status === 'fail');
  const allReady = items.every(item => item.status === 'ok');

  return {
    items,
    allReady,
    hasBlocker,
    freeBytes,
    quotaBytes,
  };
}
