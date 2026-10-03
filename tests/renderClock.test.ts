import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameTime, startDelayMs } from '../src/lib/pipeline/renderClock';

const LEAD_IN = 0.25;

test('frameTime: при звуке отсчёт идёт от старта аудио, без поправки на leadIn', () => {
  const audioStartedAt = 10 + LEAD_IN; // аудио стартует в t=10.25 по часам AudioContext
  const at = (ctxNow: number) => frameTime({ audioStartedAt, ctxNow, wallNow: 5000, fallbackStart: 4000 });

  assert.equal(at(10), 0, 'до старта аудио кадр 0, а не отрицательное время');
  assert.equal(at(10 + LEAD_IN), 0, 'в момент старта аудио время кадра ровно 0');
  assert.ok(Math.abs(at(10 + LEAD_IN + 1) - 1) < 1e-9, 'через секунду после старта — 1.0');
  assert.ok(Math.abs(at(10 + LEAD_IN + 3.5) - 3.5) < 1e-9, 'картинка не отстаёт от звука');
});

test('frameTime: без звука работает по стенным часам', () => {
  const at = (wallNow: number) => frameTime({ audioStartedAt: null, ctxNow: 0, wallNow, fallbackStart: 1000 });
  assert.equal(at(1000), 0);
  assert.ok(Math.abs(at(2500) - 1.5) < 1e-9);
  assert.equal(at(500), 0, 'отрицательное время клампится в 0');
});

test('startDelayMs: запись ждёт старта аудио ровно на leadIn', () => {
  assert.equal(startDelayMs(10.25, 10), 250, '250 мс до старта аудио');
  assert.equal(startDelayMs(10.25, 10.25), 0);
  assert.equal(startDelayMs(10.25, 12), 0, 'аудио уже играет — ждать нечего');
  assert.equal(startDelayMs(null, 10), 0, 'без звука пишем сразу');
  assert.equal(startDelayMs(10.25, null), 0, 'нет контекста — пишем сразу');
});

/**
 * Регрессионный страж: именно здесь дважды подряд ломали A/V — сначала
 * вычитали leadIn дважды, потом один раз, но в другом месте. Логика вынесена
 * в renderClock (покрыта выше), а эти проверки следят, чтобы assembleVideo
 * не начал снова поправлять время кадра на leadIn и не потерял tick().
 */
test('assembleVideo: время кадра не корректируется на leadIn, планировщик тикает', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/pipeline/assembleVideo.ts'), 'utf8');

  const animateBody = source.slice(source.indexOf('const animate = () => {'));
  assert.ok(animateBody.length > 0, 'animate() найден');
  assert.match(animateBody, /scheduler\?\.tick\(\)/, 'animate обязан тикать планировщиком, иначе WEBM без звука');
  assert.match(animateBody, /mediaClock\(fallbackStart\)/, 'время кадра берётся из mediaClock');
  assert.doesNotMatch(
    animateBody,
    /mediaClock\([^)]*\)\s*-\s*leadIn/,
    'вычитание leadIn в animate() возвращает рассинхрон A/V'
  );

  assert.match(source, /const delay = startDelayMs\(/, 'запись стартует по startDelayMs, а не сразу');
  assert.match(source, /recorder\.start\(100\)/, 'запись всё ещё стартует');
  assert.match(source, /scheduler\?\.tick\(\);[\s\S]{0,80}recorder\.start/, 'первый tick — до старта записи');
});
