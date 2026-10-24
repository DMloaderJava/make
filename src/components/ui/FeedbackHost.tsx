"use client";

import { useSyncExternalStore } from 'react';
import {
  dismissToast,
  getPendingConfirm,
  getToasts,
  resolveConfirm,
  subscribeFeedback,
} from '@/lib/ui/feedback';

const TOAST_STYLES: Record<string, string> = {
  info: 'border-[#26262C] bg-[#16161A] text-[#F5F5F7]',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  error: 'border-[#3A1414] bg-[#1E1010] text-[#E86C4C]',
};

/**
 * Единственное место, где показываются уведомления и подтверждения (P1-4).
 *
 * Раньше это делали нативные диалоги alert/confirm: во встроенном превью iframe без
 * `allow-modals` они молча ничего не делают — пользователь видел «ничего не
 * произошло» вместо причины.
 */
export function FeedbackHost() {
  const toasts = useSyncExternalStore(subscribeFeedback, getToasts, getToasts);
  const confirm = useSyncExternalStore(subscribeFeedback, getPendingConfirm, getPendingConfirm);

  return (
    <>
      <div
        className="fixed bottom-4 right-4 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2"
        data-testid="feedback-toasts"
        aria-live="polite"
      >
        {toasts.map((item) => (
          <div
            key={item.id}
            role={item.kind === 'error' ? 'alert' : 'status'}
            data-testid={`feedback-toast-${item.kind}`}
            className={`rounded-[10px] border px-3 py-2 text-[12px] leading-4 shadow-lg ${TOAST_STYLES[item.kind] ?? TOAST_STYLES.info}`}
          >
            <div className="flex items-start gap-2">
              <p className="flex-1 whitespace-pre-wrap break-words">{item.message}</p>
              <button
                type="button"
                onClick={() => dismissToast(item.id)}
                className="text-[11px] opacity-70 hover:opacity-100"
                aria-label="Закрыть уведомление"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      {confirm && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 px-4"
          data-testid="confirm-dialog"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-[16px] border border-[#26262C] bg-[#16161A] p-5">
            <p className="text-[13px] leading-5 text-[#F5F5F7] whitespace-pre-wrap">{confirm.message}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="confirm-dialog-cancel"
                onClick={() => resolveConfirm(false)}
                className="h-8 px-3 rounded-[6px] border border-[#26262C] text-xs text-[#F5F5F7] hover:bg-[#1E1E23] transition-colors"
              >
                {confirm.cancelLabel}
              </button>
              <button
                type="button"
                data-testid="confirm-dialog-ok"
                onClick={() => resolveConfirm(true)}
                className={`h-8 px-3 rounded-[6px] text-xs font-medium transition-colors ${
                  confirm.danger
                    ? 'bg-[#E86C4C] text-[#0B0B0C] hover:bg-[#C4573B]'
                    : 'bg-[#E8B44C] text-[#0B0B0C] hover:bg-[#B88A2E]'
                }`}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
