"use client";

import { useEffect, useState } from 'react';
import { detectBrowserSupport, type BrowserSupport } from '@/lib/ui/browserSupport';

/**
 * Баннер о неподдерживаемом браузере / узком экране (P1-5).
 *
 * Раньше Safari и Firefox узнавали об ограничениях только по оборванному
 * экспорту. Баннер не блокирует работу: это предупреждение, а не запрет.
 */
export function BrowserWarningBanner() {
  const [support, setSupport] = useState<BrowserSupport | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const detect = () =>
      setSupport(
        detectBrowserSupport(navigator.userAgent, {
          viewportWidth: window.innerWidth,
          vendor: navigator.vendor,
        })
      );
    detect();
    window.addEventListener('resize', detect);
    return () => window.removeEventListener('resize', detect);
  }, []);

  if (!support?.shouldWarn || dismissed) return null;

  return (
    <div
      data-testid="browser-warning-banner"
      role="status"
      aria-live="polite"
      className="border-b border-[#3A2E14] bg-[#1E1A10] px-4 py-2"
    >
      <div className="mx-auto flex max-w-[960px] items-start gap-3">
        <span className="text-[13px] leading-5 text-[#E8B44C]" aria-hidden="true">
          ⚠
        </span>
        <p className="flex-1 text-[11px] leading-4 text-[#C9B27A]">{support.message}</p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="h-6 rounded-[6px] border border-[#3A2E14] px-2 text-[11px] text-[#C9B27A] transition-colors hover:bg-[#262010]"
          data-testid="browser-warning-dismiss"
        >
          Понятно
        </button>
      </div>
    </div>
  );
}
