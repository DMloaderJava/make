#!/usr/bin/env node
/**
 * Единый источник версии — package.json. Скрипт проверяет все места, где версия
 * продублирована: баннеры лаунчеров, electron-мост, README, lock-файл.
 *
 * Зачем: версия уже дважды разъезжалась из-за ручного обновления по файлам
 * (v1.3.1 в заголовках .bat, v1.3.6 в .sh). Запускается в `npm run verify`,
 * то есть и локально, и в CI на обеих ОС.
 *
 * Регекспы нарочно узкие: README полон исторических «v1.3.x» в разделах
 * изменений, их трогать нельзя — проверяем только заголовок и баннеры.
 */
import { readFileSync } from 'node:fs';

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;

function read(file) {
  return readFileSync(file, 'utf8');
}

/** Все версии, которые «заявляет» файл по своему узкому шаблону. */
function claimVersions(file, pattern) {
  const found = [];
  for (const match of read(file).matchAll(pattern)) found.push(match[1]);
  return found;
}

const lock = JSON.parse(read('package-lock.json'));

const claims = [
  { name: 'package-lock.json (корень + packages[""])', versions: [lock.version, lock.packages?.['']?.version] },
  { name: 'README.md (заголовок)', versions: claimVersions('README.md', /^# .*\(v(\d+\.\d+\.\d+)\)/gm) },
  { name: 'install.sh (баннер)', versions: claimVersions('install.sh', /echo " v(\d+\.\d+\.\d+)"/g) },
  { name: 'run.sh (баннер)', versions: claimVersions('run.sh', /Studio v(\d+\.\d+\.\d+)/g) },
  { name: 'install.bat (баннер)', versions: claimVersions('install.bat', /echo\s+v(\d+\.\d+\.\d+)/g) },
  { name: 'run.bat (баннер)', versions: claimVersions('run.bat', /Studio v(\d+\.\d+\.\d+)/g) },
  { name: 'electron/preload.js (мост)', versions: claimVersions('electron/preload.js', /version:\s*'(\d+\.\d+\.\d+)'/g) },
];

const problems = [];
let checked = 0;

for (const claim of claims) {
  const versions = claim.versions.filter(v => typeof v === 'string' && v.length > 0);
  if (versions.length === 0) {
    problems.push(`${claim.name}: версия не найдена — шаблон устарел или файл переименован`);
    continue;
  }
  for (const version of versions) {
    checked++;
    if (version !== current) problems.push(`${claim.name}: ${version} вместо ${current}`);
  }
}

if (problems.length > 0) {
  console.error(`check:versions — версия в package.json: ${current}, но:\n  - ${problems.join('\n  - ')}`);
  console.error('\nОбновите перечисленные места (или шаблон в scripts/check-version.mjs, если файл переименован).');
  process.exit(1);
}

console.log(`check:versions — ok: ${current} согласована в ${checked} местах (${claims.length} файлов)`);
