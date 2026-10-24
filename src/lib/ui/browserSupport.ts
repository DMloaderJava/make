"use client";

/**
 * Определение браузера для баннера «desktop-only» (P1-5).
 *
 * Safari не поддерживается как целевой браузер: нестабильный
 * `OfflineAudioContext` на длинных дорожках, ограничения OPFS и
 * `MediaRecorder` (см. L-2 и L-11 в known-limits.md). Раньше пользователь
 * Safari просто получал непонятные сбои при экспорте.
 */

export type BrowserFamily = 'chromium' | 'firefox' | 'safari' | 'unknown';

export interface BrowserSupport {
  family: BrowserFamily;
  /** Узкие экраны: редактор спроектирован под десктоп. */
  isNarrowViewport: boolean;
  /** Нужно показать предупреждение. */
  shouldWarn: boolean;
  message: string | null;
}

const SAFARI_MESSAGE =
  'Safari не поддерживается: OPFS, WebCodecs и MediaRecorder работают в нём нестабильно, экспорт видео может обрываться. Откройте проект в Chrome, Edge или Chromium.';
const FIREFOX_MESSAGE =
  'Firefox поддерживает не все возможности экспорта (WebCodecs), ролик может собраться через медленный canvas-фолбэк. Рекомендуем Chrome или Edge.';
const NARROW_MESSAGE =
  'Редактор рассчитан на десктоп: на узком экране часть панелей таймлайна не помещается.';

function detectFamily(userAgent: string, vendor = ''): BrowserFamily {
  const ua = userAgent.toLowerCase();
  if (ua.includes('firefox') || ua.includes('fxios')) return 'firefox';
  // Chrome/Edge/Chromium содержат и «safari», и «chrome» — проверяем chrome раньше.
  if (ua.includes('chrome') || ua.includes('crios') || ua.includes('edg/')) return 'chromium';
  if (ua.includes('safari') || vendor.toLowerCase().includes('apple')) return 'safari';
  return 'unknown';
}

export function detectBrowserSupport(
  userAgent: string,
  options: { viewportWidth?: number; vendor?: string } = {}
): BrowserSupport {
  const family = detectFamily(userAgent, options.vendor);
  const viewportWidth = options.viewportWidth ?? Number.POSITIVE_INFINITY;
  const isNarrowViewport = viewportWidth < 768;

  if (family === 'safari') {
    return { family, isNarrowViewport, shouldWarn: true, message: SAFARI_MESSAGE };
  }
  if (family === 'firefox') {
    return { family, isNarrowViewport, shouldWarn: true, message: FIREFOX_MESSAGE };
  }
  if (isNarrowViewport) {
    return { family, isNarrowViewport, shouldWarn: true, message: NARROW_MESSAGE };
  }
  return { family, isNarrowViewport, shouldWarn: false, message: null };
}
