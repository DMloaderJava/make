/**
 * Единственный источник версии приложения на клиенте.
 *
 * Значение подставляет сборка (`NEXT_PUBLIC_APP_VERSION` из `package.json`,
 * см. `next.config.ts`). Хардкодить версию в коде нельзя — это проверяет
 * `npm run check:versions`.
 */
export const APP_VERSION: string =
  process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0-dev';

/** Версия для подписи в UI — с префиксом «v». */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;
