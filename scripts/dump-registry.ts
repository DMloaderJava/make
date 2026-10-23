/**
 * Печатает реестр провайдеров в stdout как JSON без примесей.
 *
 * Вызывается из `scripts/check-providers.mjs` (через tsx). Отдельный файл
 * вместо генерации временного `dump.ts` — стабильнее: import-путь
 * резолвится ровно один раз, а `process.stdout.write` гарантирует, что в
 * вывод не попадёт ничего, кроме JSON.
 */
import { PROVIDER_REGISTRY } from '../src/lib/providers/registry';

process.stdout.write(JSON.stringify(PROVIDER_REGISTRY));
