/**
 * Smoke-тест TTS-провайдеров на реальных ключах.
 *
 * В CI не запускается (ключей нет), но даёт честную картину за пару минут:
 * какие провайдеры действительно отвечают аудио, а какие — «мы написали URL
 * из документации, вдруг сработает».
 *
 * Запуск (bash / zsh, включая Git Bash на Windows):
 *   PROVIDER_KEYS='{"openai":"sk-...","cartesia":"..."}' npm run smoke:tts
 *
 * PowerShell (Windows):
 *   $env:PROVIDER_KEYS = '{"openai":"sk-..."}'
 *   npm run smoke:tts
 *
 * cmd.exe (Windows):
 *   set PROVIDER_KEYS={"openai":"sk-..."}
 *   npm run smoke:tts
 *
 * Ещё варианты (одинаково работают во всех оболочках):
 *   файл с ключами:   npm run smoke:tts -- --keys-file .keys.json
 *   отдельные провайдеры: npm run smoke:tts -- openai cartesia
 *   (в PowerShell аргументы после -- тоже передаются: npm run smoke:tts -- openai)
 *
 * Результат (OK/FAIL/skip) выводится таблицей — его же стоит вставлять в README,
 * снимая флаг `experimental` у проверенных провайдеров.
 */

import { readFileSync } from 'node:fs';
import { TTS_PROVIDERS } from '../src/lib/providers/tts/catalog';
import { providerMimeType, resolveAudioMime } from '../src/lib/providers/tts/mime';
import { mustUseProxy } from '../src/lib/providers/tts/cors';
import { FALLBACK_VOICE } from '../src/lib/providers/tts/voice-resolver';

const TEST_TEXT = 'Привет! Это короткий тест синтеза речи.';

interface Result {
  id: string;
  status: 'OK' | 'FAIL' | 'skip';
  detail: string;
}

function parseArgs(): { keys: Record<string, string>; only: string[] } {
  const args = process.argv.slice(2);
  const keysFileIndex = args.indexOf('--keys-file');
  let keys: Record<string, string> = {};

  const fromEnv = process.env.PROVIDER_KEYS;
  if (fromEnv !== undefined) {
    if (fromEnv.trim() === '') {
      // Типичный случай на Windows: переменную задали в другом окне терминала
      // или через `set VAR=` без значения. Молчаливый skip всех провайдеров
      // выглядел бы как «ничего не работает».
      console.error(
        'PROVIDER_KEYS задан, но пуст. Укажите JSON, например:\n' +
        '  bash/zsh:    PROVIDER_KEYS=\'{"openai":"sk-..."}\' npm run smoke:tts\n' +
        '  PowerShell:  $env:PROVIDER_KEYS = \'{"openai":"sk-..."}\'  ; npm run smoke:tts\n' +
        '  cmd.exe:     set PROVIDER_KEYS={"openai":"sk-..."}         && npm run smoke:tts'
      );
      process.exit(2);
    }
    try {
      const parsed = JSON.parse(fromEnv);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('ожидался объект вида {"providerId":"ключ"}');
      }
      keys = parsed as Record<string, string>;
    } catch (e) {
      console.error(
        `PROVIDER_KEYS не является корректным JSON-объектом: ${(e as Error).message}\n` +
        'Ожидается: {"openai":"sk-...","cartesia":"..."}\n' +
        'Подсказки по оболочкам — в шапке scripts/smoke-tts.ts и в README.'
      );
      process.exit(2);
    }
  }

  if (keysFileIndex >= 0) {
    const path = args[keysFileIndex + 1];
    if (!path) {
      console.error('--keys-file требует путь к JSON-файлу');
      process.exit(2);
    }
    keys = { ...keys, ...JSON.parse(readFileSync(path, 'utf8')) };
  }

  const skipIndexes = new Set<number>();
  if (keysFileIndex >= 0) {
    skipIndexes.add(keysFileIndex);
    skipIndexes.add(keysFileIndex + 1);
  }
  const only = args.filter((a, i) => !a.startsWith('--') && !skipIndexes.has(i));
  return { keys, only };
}

async function run(): Promise<void> {
  const { keys, only } = parseArgs();
  const providers = TTS_PROVIDERS.filter(p => only.length === 0 || only.includes(p.id));
  const results: Result[] = [];

  console.log(`Smoke-тест ${providers.length} провайдеров, текст: «${TEST_TEXT}»\n`);
  if (Object.keys(keys).length === 0) {
    console.log('Ключи не переданы (PROVIDER_KEYS пуст или не задан) — все провайдеры будут пропущены.');
    console.log('Это НЕ значит, что они не работают: проверять нечем. Пример задания ключей см. выше.\n');
  }
  if (mustUseProxy(providers[0]?.id ?? '')) {
    console.log('(внимание: часть провайдеров в браузере идёт через /api/tts — здесь вызывается их прямая generate)\n');
  }

  for (const provider of providers) {
    const apiKey = keys[provider.id];
    if (!apiKey) {
      results.push({ id: provider.id, status: 'skip', detail: 'нет ключа' });
      console.log(`skip  ${provider.id.padEnd(14)} нет ключа в PROVIDER_KEYS`);
      continue;
    }

    const started = Date.now();
    try {
      const buffer = await provider.generate(TEST_TEXT, {
        apiKey,
        voice: FALLBACK_VOICE[provider.id] || '',
        language: 'ru',
        model: provider.defaultModel,
      });
      const ms = Date.now() - started;
      const mime = resolveAudioMime(provider.id, buffer);
      const expected = providerMimeType(provider.id);
      const mismatch = mime !== expected ? ` (ожидали ${expected})` : '';
      results.push({ id: provider.id, status: 'OK', detail: `${buffer.byteLength} B, ${mime}${mismatch}, ${ms} мс` });
      console.log(`OK    ${provider.id.padEnd(14)} ${buffer.byteLength} B, ${mime}${mismatch}, ${ms} мс`);
    } catch (e) {
      const message = (e as Error).message.replace(/\s+/g, ' ').slice(0, 200);
      results.push({ id: provider.id, status: 'FAIL', detail: message });
      console.log(`FAIL  ${provider.id.padEnd(14)} ${message}`);
    }
  }

  const ok = results.filter(r => r.status === 'OK');
  const failed = results.filter(r => r.status === 'FAIL');
  const skipped = results.filter(r => r.status === 'skip');

  console.log('\n--- итог ---');
  console.log(`OK: ${ok.length}, FAIL: ${failed.length}, skip: ${skipped.length}`);
  if (ok.length > 0) {
    console.log('\nПроверенные (можно снять experimental):');
    for (const r of ok) console.log(`  - ${r.id}: ${r.detail}`);
  }
  if (failed.length > 0) {
    console.log('\nНЕ работают (нужно чинить или помечать experimental):');
    for (const r of failed) console.log(`  - ${r.id}: ${r.detail}`);
    process.exitCode = 1;
  }
}

void run();
