/**
 * Единственный источник версии приложения на клиенте.
 *
 * Значение подставляет сборка (`NEXT_PUBLIC_APP_VERSION` из `package.json`,
 * см. `next.config.ts`). Версию в коде не хардкодим: единственный источник —
 * `package.json`.
 */
export const APP_VERSION: string =
  process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0-dev';

/** Версия для подписи в UI — с префиксом «v». */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
