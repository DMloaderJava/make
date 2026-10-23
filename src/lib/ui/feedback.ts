"use client";

/**
 * Внутренние уведомления и подтверждения вместо нативных alert/confirm.
 *
 * Причина: встроенное превью и iframe без `allow-modals` молча возвращают
 * `false` из нативного подтверждения и не показывают сообщения — пользователь нажимает
 * «Озвучить», ничего не происходит, и он не понимает почему. Поэтому оба
 * нативных диалога заменены на состояние React (P1-4).
 *
 * Модуль намеренно не использует React-контекст: `confirmAction` вызывается из
 * обычных async-функций (хуки контроллера редактора, обработчики настроек).
 * Подписка — через `useSyncExternalStore` в FeedbackHost.
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface ConfirmRequest {
  id: number;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger: boolean;
}

type Listener = () => void;

let toasts: ToastItem[] = [];
let pendingConfirm: ConfirmRequest | null = null;
let seq = 0;
const listeners = new Set<Listener>();
const confirmResolvers = new Map<number, (ok: boolean) => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeFeedback(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): ToastItem[] {
  return toasts;
}

export function getPendingConfirm(): ConfirmRequest | null {
  return pendingConfirm;
}

/** Показать уведомление (ошибки держатся дольше и помечены `role="alert"`). */
export function toast(message: string, kind: ToastKind = 'info'): number {
  const id = ++seq;
  toasts = [...toasts, { id, message, kind }];
  emit();
  const timeout = kind === 'error' ? 8000 : 4000;
  if (typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emit();
}

export interface ConfirmOptions {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/**
 * Асинхронное подтверждение: возвращает `true`, только если пользователь
 * явно нажал подтверждающую кнопку. Диалог рисует `<FeedbackHost />`.
 */
export function confirmAction({
  message,
  confirmLabel = 'Подтвердить',
  cancelLabel = 'Отмена',
  danger = false,
}: ConfirmOptions): Promise<boolean> {
  if (pendingConfirm) {
    // Второй диалог поверх первого: закрываем предыдущий как отменённый,
    // чтобы его промис не остался висеть.
    resolveConfirm(false);
  }
  const id = ++seq;
  pendingConfirm = { id, message, confirmLabel, cancelLabel, danger };
  emit();
  return new Promise<boolean>((resolve) => {
    confirmResolvers.set(id, resolve);
  });
}

export function resolveConfirm(ok: boolean) {
  const request = pendingConfirm;
  if (!request) return;
  pendingConfirm = null;
  const resolve = confirmResolvers.get(request.id);
  confirmResolvers.delete(request.id);
  emit();
  resolve?.(ok);
}

/** Только для тестов: сбросить состояние между кейсами. */
export function resetFeedbackForTests() {
  toasts = [];
  pendingConfirm = null;
  confirmResolvers.forEach((resolve) => resolve(false));
  confirmResolvers.clear();
  emit();
}
