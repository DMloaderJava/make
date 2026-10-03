import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameTime, startDelayMs, waitForStart } from '../src/lib/pipeline/renderClock';

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

test('waitForStart: ждёт по часам, а не по setTimeout (старт ровно в момент аудио)', () => {
  let ctxNow = 10;
  const started: number[] = [];
  const callbacks: Array<() => void> = [];
  const schedule = (cb: () => void) => { callbacks.push(cb); };

  waitForStart({
    remaining: () => 10.25 - ctxNow,
    onStart: () => started.push(ctxNow),
    schedule,
  });

  assert.equal(started.length, 0, 'пока звук не начался, запись не стартует');
  // кадр 1: 10.1 — ещё рано
  ctxNow = 10.1;
  callbacks.shift()!();
  assert.equal(started.length, 0);
  // кадр 2: 10.24 — разница 10 мс, ещё ждём
  ctxNow = 10.24;
  callbacks.shift()!();
  assert.equal(started.length, 0);
  // кадр 3: 10.253 — звук уже играет (порог 5 мс)
  ctxNow = 10.253;
  callbacks.shift()!();
  assert.equal(started.length, 1);
  assert.ok(Math.abs(started[0] - 10.253) < 1e-9, 'старт привязан к часам AudioContext');
});

test('waitForStart: без звука стартует сразу, без лишних кадров', () => {
  let calls = 0;
  let started = 0;
  waitForStart({
    remaining: () => 0,
    onStart: () => { started++; },
    schedule: () => { calls++; },
  });
  assert.equal(started, 1);
  assert.equal(calls, 0, 'ждать нечего — rAF не запрашивается');
});
