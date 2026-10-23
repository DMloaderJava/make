import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * P0-5/desktop: переносимая сборка Electron должна запускаться.
 *
 * До стабилизации `electron-builder` был devDependency без конфигурации, а
 * main-процесс вызывал `npm run start` через shell — в упакованном
 * приложении npm может отсутствовать. Тест фиксирует контракт: точка входа
 * существует, файлы Next попадают в пакет, а прод-сервер запускается
 * напрямую бинарём Electron в режиме Node.
 */

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('desktop: точка входа Electron существует и объявлена в package.json', () => {
  assert.equal(pkg.main, 'electron/main.js');
  assert.ok(existsSync(join(root, pkg.main)), 'electron/main.js отсутствует');
  assert.ok(existsSync(join(root, 'electron/preload.js')), 'electron/preload.js отсутствует');
});

test('desktop: electron-builder сконфигурирован и кладёт артефакты в release/', () => {
  const build = pkg.build;
  assert.ok(build, 'в package.json нет секции build для electron-builder');
  assert.equal(build.appId, 'com.mangavoice.studio');
  assert.equal(build.directories.output, 'release');
  assert.equal(build.asar, false, 'asar должен быть выключен: Next читает .next с диска');
  for (const glob of ['electron/**/*', '.next/**/*', 'public/**/*']) {
    assert.ok(build.files.includes(glob), `build.files должен включать ${glob}`);
  }
  assert.ok(Array.isArray(build.linux.target) && build.linux.target.length > 0);
});

test('desktop: артефакты сборки не попадают в git', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^\/release\/$/m, 'release/ должен быть в .gitignore');
});

test('desktop: main-процесс не зависит от npm в упакованной сборке', () => {
  const main = readFileSync(join(root, 'electron/main.js'), 'utf8');
  const branchStart = main.indexOf('} else {\n    let nextBin');
  assert.notEqual(branchStart, -1, 'не найден прод-бранч запуска Next');
  const prodBranch = main.slice(branchStart);
  assert.match(prodBranch, /require\.resolve\('next\/dist\/bin\/next'/);
  assert.match(prodBranch, /ELECTRON_RUN_AS_NODE/);

  // Границу «до старта процесса» ищем явно: при рефакторинге main.js
  // `indexOf` может вернуть -1, а slice(0, -1) молча отрежет последний символ
  // и тест пройдёт на пустом фрагменте — это было бы ложное прохождение.
  const spawnEnd = prodBranch.indexOf('nextProcess.on');
  assert.notEqual(spawnEnd, -1, 'в прод-бранче нет nextProcess.on — граница проверки потеряна');
  const prodSpawn = prodBranch.slice(0, spawnEnd);
  assert.ok(prodSpawn.includes('spawn'), 'в прод-бранче нет вызова spawn');
  assert.doesNotMatch(prodSpawn, /npm/, 'прод-запуск не должен идти через npm/shell');
});

test('desktop: скрипты сборки объявлены', () => {
  assert.match(pkg.scripts['desktop:build'], /electron-builder/);
  assert.match(pkg.scripts['desktop:pack'], /electron-builder --dir/);
});
