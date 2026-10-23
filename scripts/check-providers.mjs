#!/usr/bin/env node
/**
 * Сверка README с единым реестром провайдеров (P0-2 / P2-1).
 *
 * README раньше обещал «25+ LLM» и «15+ TTS», хотя в каталоге было 13 и 15:
 * часть строк — только ссылки на сервисы. Теперь таблицы провайдеров в README
 * генерируются из `src/lib/providers/registry.ts`, а этот скрипт падает, если
 * документация разошлась с кодом.
 *
 * Использование:
 *   node scripts/check-providers.mjs          # проверка (входит в verify/CI)
 *   node scripts/check-providers.mjs --write  # перегенерировать блоки в README
 *
 * Registry — TypeScript, поэтому дамп выполняется через tsx (кросс-платформенно,
 * без предположений о раскрытии glob оболочкой).
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const README = 'README.md';
const MARKERS = {
  llm: ['<!-- providers:llm:start -->', '<!-- providers:llm:end -->'],
  tts: ['<!-- providers:tts:start -->', '<!-- providers:tts:end -->'],
  stt: ['<!-- providers:stt:start -->', '<!-- providers:stt:end -->'],
};

function loadRegistry() {
  // Реестр — TypeScript, поэтому дамп идёт через tsx. JSON пишется в файл,
  // а не в stdout: если в реестре или каталогах появится console.log, разбор
  // вывода молча ломался бы, а файл от этого защищён.
  const tsxCli = require.resolve('tsx/cli');
  const dumper = resolve('scripts/dump-registry.ts');
  const tmpFile = join(tmpdir(), `mvs-registry-${process.pid}-${Date.now()}.json`);
  const result = spawnSync(process.execPath, [tsxCli, dumper, tmpFile], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    console.error('Не удалось импортировать реестр провайдеров:\n' + (result.stderr || result.stdout));
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(tmpFile, 'utf8'));
  } catch (error) {
    console.error('Дамп реестра не является JSON: ' + String(error));
    process.exit(1);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function cell(value) {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function keyCell(entry) {
  return entry.keyUrl ? `[ключ](${entry.keyUrl})` : '—';
}

function freeTierLabel(entry) {
  if (entry.freeTier) return 'да';
  if (entry.trialOnly) return 'trial';
  return 'платно';
}

function renderLLM(entries) {
  const implemented = entries.filter(entry => entry.implemented);
  // Anthropic не проксируется намеренно (/v1/messages), поэтому в списке proxy-only его нет.
  const proxyOnly = entries.filter(entry => !entry.implemented && entry.api !== 'anthropic');
  const unsupported = entries.filter(entry => !entry.implemented && entry.api === 'anthropic');
  const lines = [
    `<!-- providers:llm:start -->`,
    `Реализовано в каталоге: **${implemented.length}** провайдеров.`,
    '',
    '| Провайдер | Модели | Vision | Free tier | Лимиты | Ключ |',
    '|-----------|--------|--------|-----------|--------|------|',
    ...implemented.map(entry =>
      `| **${cell(entry.name)}** (\`${entry.id}\`) | ${cell((entry.models || []).slice(0, 3).join(', '))} | ${
        entry.supportsVision ? 'да' : 'нет'
      } | ${freeTierLabel(entry)} | ${cell(entry.limits)} | ${keyCell(entry)} |`
    ),
    '',
  ];
  if (proxyOnly.length > 0) {
    lines.push(
      `Дополнительно через \`/api/llm\` (без карточки в UI, OpenAI-совместимый протокол): ` +
        proxyOnly.map(entry => `\`${entry.id}\``).join(', ') + '.'
    );
    if (unsupported.length > 0) {
      lines.push(
        '',
        `Не поддерживаются прокси-маршрутом (другой протокол, документированный отказ 501): ` +
          unsupported.map(entry => `\`${entry.id}\``).join(', ') + '.'
      );
    }
    lines.push('');
  }
  lines.push('<!-- providers:llm:end -->');
  return lines.join('\n');
}

function renderTTS(entries) {
  const implemented = entries.filter(entry => entry.implemented);
  const lines = [
    '<!-- providers:tts:start -->',
    `Реализовано в каталоге: **${implemented.length}** провайдеров.`,
    '',
    '| Провайдер | Языки | Модель | Статус | CORS | Лимиты | Ключ |',
    '|-----------|--------|--------|--------|------|--------|------|',
    ...implemented.map(entry => {
      const status = entry.experimental ? 'experimental' : entry.freeTier ? 'free tier' : 'платно';
      const cors = entry.cors === 'proxy' ? 'через `/api/tts`' : 'напрямую';
      return `| **${cell(entry.name)}** (\`${entry.id}\`) | ${cell((entry.languages || []).join(', '))} | ${cell(
        entry.defaultModel
      )} | ${status} | ${cors} | ${cell(entry.limits)} | [ключ](${entry.keyUrl}) |`;
    }),
    '',
    '<!-- providers:tts:end -->',
  ];
  return lines.join('\n');
}

function renderSTT(entries) {
  const lines = [
    '<!-- providers:stt:start -->',
    'STT-провайдеры доступны как справка и как опциональный серверный путь',
    '(`/api/whisper`); отдельной кнопки в UI нет — SRT собирается из таймлайна.',
    '',
    '| Провайдер | Free tier | Лимиты | Ключ |',
    '|-----------|-----------|--------|------|',
    ...entries.map(entry =>
      `| **${cell(entry.name)}** | ${entry.freeTier ? 'да' : 'платно'} | ${cell(entry.limits)} | ${keyCell(entry)} |`
    ),
    '',
    '<!-- providers:stt:end -->',
  ];
  return lines.join('\n');
}

function blockFor(readme, kind) {
  const [start, end] = MARKERS[kind];
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return { from, to: to + end.length };
}

const registry = loadRegistry();
const groups = {
  llm: registry.filter(entry => entry.kind === 'llm'),
  tts: registry.filter(entry => entry.kind === 'tts'),
  stt: registry.filter(entry => entry.kind === 'stt'),
};
const rendered = {
  llm: renderLLM(groups.llm),
  tts: renderTTS(groups.tts),
  stt: renderSTT(groups.stt),
};

const write = process.argv.includes('--write');
// Переводы строк нормализуем к LF: `.gitattributes` объявляет `* text=auto`,
// поэтому на Windows README выкладывается с CRLF, а блоки рендерятся с `\n`.
// Без нормализации сверка падала на Windows при побайтно совпадающем тексте.
let readme = readFileSync(README, 'utf8').replace(/\r\n?/g, '\n');
const problems = [];

for (const kind of Object.keys(MARKERS)) {
  const range = blockFor(readme, kind);
  if (!range) {
    problems.push(`README.md: нет блока ${MARKERS[kind][0]} … ${MARKERS[kind][1]}`);
    continue;
  }
  const current = readme.slice(range.from, range.to);
  if (current !== rendered[kind]) {
    if (write) {
      readme = readme.slice(0, range.from) + rendered[kind] + readme.slice(range.to);
    } else {
      problems.push(`README.md: блок «${kind}» разошёлся с реестром — запустите npm run gen:providers`);
    }
  }
}

if (write) {
  writeFileSync(README, readme);
  console.log(`check:providers — README обновлён из реестра (LLM ${groups.llm.filter(e => e.implemented).length}, TTS ${groups.tts.filter(e => e.implemented).length}, STT ${groups.stt.length}).`);
  process.exit(0);
}

if (problems.length > 0) {
  console.error('check:providers — ошибки:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}

console.log(
  `check:providers — ok: README совпадает с реестром ` +
    `(LLM ${groups.llm.filter(e => e.implemented).length} реализовано + ` +
    `${groups.llm.filter(e => !e.implemented && e.api !== 'anthropic').length} proxy-only + 1 unsupported, ` +
    `TTS ${groups.tts.filter(e => e.implemented).length}, STT ${groups.stt.length})`
);
