import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

/**
 * P0-4: структура `.github/workflows/ci.yml` проверяется машинно, а не глазами.
 *
 * Регресс, который этот файл закрывает: шаг «Проверить, что артефакт desktop
 * собрался» однажды оказался в job `verify`, где `electron-builder` не
 * запускается и `release/` пуст — шаг падал с exit 1 на обеих ОС, и весь CI
 * был красным при зелёных локальных проверках.
 *
 * YAML разбирается настоящим парсером (`js-yaml`, явная devDependency):
 * самодельная нарезка по отступу ломалась бы на `matrix.include`, job'ах с
 * `name:` в кавычках и многострочных строках.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  shell?: string;
  with?: Record<string, unknown>;
};

type Job = {
  'runs-on'?: unknown;
  'timeout-minutes'?: number;
  strategy?: { 'fail-fast'?: boolean; matrix?: { os?: string[]; include?: unknown[] } };
  steps?: Step[];
};

const root = process.cwd();
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs?: Record<string, Job>;
};

const jobs = workflow.jobs ?? {};
const stepsOf = (job: string): Step[] => {
  const found = jobs[job];
  assert.ok(found, `в ci.yml нет job'а ${job}`);
  return found.steps ?? [];
};

/**
 * Разворачивает значение `with` в строки. Рекурсия, а не `String(value)`:
 * если в `with` появится объект или массив, `String` дал бы `[object Object]`
 * и проверка молча потеряла бы содержимое.
 *
 * Ключи объектов намеренно не возвращаются: `action` упаковывает в них только
 * имена параметров (`path`, `name`, `retention-days`), а проверяются значения.
 * Иначе `with: { electron-builder: '…' }` дал бы ложное срабатывание на имени
 * ключа, хотя содержимое шага к упаковке отношения не имеет.
 */
function flatten(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(flatten);
  if (typeof value === 'object') return Object.values(value).flatMap(flatten);
  return [String(value)];
}

/** Всё, что job реально делает: имя, команда, экшн и все `with`-значения. */
const actionsOf = (job: string): string =>
  stepsOf(job)
    .map((step) => [...flatten([step.name, step.uses, step.run, step.with])].join('\n'))
    .join('\n');

/** Экшены и команды, специфичные для упаковки desktop. */
const DESKTOP_ONLY = [/electron-builder/, /ls -A release/, /release\/\*\.AppImage/, /desktop-\$\{/];

const verifyActions = actionsOf('verify');
const desktopActions = actionsOf('desktop');

test('ci: desktop-артефакты собираются и проверяются только в job desktop', () => {
  for (const pattern of DESKTOP_ONLY) {
    assert.ok(
      !pattern.test(verifyActions),
      `job verify не собирает desktop, но содержит ${pattern} — там release/ пуст и шаг упадёт`
    );
  }
  assert.match(desktopActions, /electron-builder --publish never/, 'job desktop должен упаковывать приложение');
  assert.match(desktopActions, /ls -A release/, 'job desktop должен проверять, что release/ не пуст');
});

test('ci: smoke-артефакты выгружаются всегда и с ограниченным сроком', () => {
  const upload = stepsOf('verify').find(
    (step) => step.uses?.startsWith('actions/upload-artifact') && String(step.name ?? '').includes('smoke')
  );
  assert.ok(upload, 'в verify нет шага выгрузки smoke-артефактов');
  assert.equal(upload.if, 'always()', 'smoke-артефакты нужны и при падении теста');
  const paths = String(upload.with?.path ?? '');
  assert.match(paths, /artifacts\/smoke-editor/);
  assert.match(paths, /artifacts\/smoke-onboarding/);
  assert.equal(upload.with?.['retention-days'], 14);
});

test('ci: verify идёт матрицей ubuntu+windows с потолком времени', () => {
  const strategy = jobs.verify?.strategy;
  assert.deepEqual(strategy?.matrix?.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(strategy?.['fail-fast'], false, 'падение одной ОС не должно отменять другую');

  const timeout = jobs.verify?.['timeout-minutes'];
  assert.equal(typeof timeout, 'number', 'у verify должен быть timeout-minutes');
  assert.ok(timeout! > 0 && timeout! <= 25, `потолок CI по ТЗ — не больше 25 минут, сейчас ${timeout}`);

  const desktopTimeout = jobs.desktop?.['timeout-minutes'];
  assert.equal(typeof desktopTimeout, 'number', 'у desktop должен быть timeout-minutes');
  assert.ok(desktopTimeout! <= 25, `потолок desktop-джобы — 25 минут, сейчас ${desktopTimeout}`);
});

test('ci: полный smoke только на Linux, на Windows — сокращённый', () => {
  const steps = stepsOf('verify');
  // Шаг может быть обёрнут (лог в артефакт, повтор при флапе), поэтому ищем по
  // вызову скрипта, а не по точной строке: важно, какой сценарий и на какой ОС.
  const runs = steps.map((step) => ({ if: step.if, run: String(step.run ?? '') }));
  const full = runs.find((step) => step.run.includes('npm run smoke:editor') && !step.run.includes('--quick'));
  const quick = runs.find((step) => step.run.includes('npm run smoke:editor -- --quick'));
  assert.ok(full, 'нет полного smoke:editor');
  assert.ok(quick, 'нет сокращённого smoke:editor -- --quick');
  assert.equal(full.if, "runner.os == 'Linux'");
  assert.equal(quick.if, "runner.os == 'Windows'");
  // Падение smoke на Linux должно оставлять лог в артефактах: иначе причина
  // видна только как «Process completed with exit code 1».
  assert.ok(
    full.run.includes('artifacts/smoke-editor/ci-smoke.log'),
    'полный smoke на Linux должен писать лог в artifacts/smoke-editor/ci-smoke.log (артефакт smoke-*)'
  );
});

test('ci: в verify входят проверки согласованности', () => {
  const scripts = stepsOf('verify')
    .flatMap((step) => String(step.run ?? '').split('&&'))
    .map((part) => part.trim());
  for (const script of ['check:versions', 'check:providers', 'check:tests', 'check:launchers']) {
    assert.ok(scripts.includes(`npm run ${script}`), `verify должен запускать ${script}`);
  }
});

test('ci: desktop-артефакты не блокируют сборку из-за формата файла', () => {
  // Формат зависит от ОС (AppImage на Linux, portable exe на Windows),
  // поэтому загрузка не падает, а полноту release/ проверяет отдельный шаг.
  const upload = stepsOf('desktop').find((step) => step.uses?.startsWith('actions/upload-artifact'));
  assert.ok(upload, 'в desktop нет выгрузки артефактов');
  assert.equal(
    upload.with?.['if-no-files-found'],
    'warn',
    'строгий режим ломает CI при смене layout артефактов electron-builder'
  );
});
