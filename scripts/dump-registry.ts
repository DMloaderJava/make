/**
 * Выгружает реестр провайдеров в JSON.
 *
 * Вызывается из `scripts/check-providers.mjs` через tsx. Если передан путь
 * (`dump-registry.ts <файл>`), JSON пишется в файл — тогда любой случайный
 * `console.log` из реестра/каталогов не может испортить вывод. Без аргумента
 * печатает в stdout (удобно для отладки).
 *
 * Отдельный файл вместо генерации временного `dump.ts` — стабильнее:
 * import-путь резолвится ровно один раз и не зависит от ОС.
 */
import { writeFileSync } from 'node:fs';
import { PROVIDER_REGISTRY } from '../src/lib/providers/registry';

const json = JSON.stringify(PROVIDER_REGISTRY);
const target = process.argv[2];
if (target) writeFileSync(target, json, 'utf8');
else process.stdout.write(json);
