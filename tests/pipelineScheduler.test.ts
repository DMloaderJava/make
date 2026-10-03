import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacementScheduler, clearBufferCache, type AudioPlacement } from '../src/lib/pipeline/audioMix';

/**
 * Поведенческие тесты планировщика на фейковом Web Audio.
 *
 * Раньше это место «проверялось» поиском подстроки по исходнику — такой тест
 * ломается от переименования переменной и молчит при реальной гонке. Здесь мы
 * запускаем настоящий code path: декодирование (через заглушку), prime(), tick(),
 * dispose() и проверяем, что источники действительно попадают в граф.
 */

const SAMPLE_RATE = 44100;
const CHANNELS = 2;

/** Длительность фрагмента закодирована в первом байте блоба. */
function makeBlob(durationSeconds: number): Blob {
  return new Blob([new Uint8Array([Math.round(durationSeconds * 10)])]);
}

function durationOf(buffer: ArrayBuffer): number {
  return new Uint8Array(buffer)[0] / 10;
}

class FakeAudioBuffer {
  length: number;
  duration: number;
  constructor(public numberOfChannels: number, length: number, public sampleRate: number) {
    this.length = length;
    this.duration = length / sampleRate;
  }
  getChannelData(): Float32Array {
    return new Float32Array(this.length);
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = SAMPLE_RATE;
  /** Что реально попало в граф: когда и как долго. */
  started: Array<{ when: number; playDuration: number }> = [];
  /** Декодирования, которые нужно придержать (для проверки гонки с dispose). */
  held: Array<() => void> = [];
  holdNext = false;

  destination = {
    connect: () => {},
    disconnect: () => {},
  };

  createBuffer(channels: number, length: number, rate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, rate);
  }

  createBufferSource() {
    const started = this.started;
    const source = {
      buffer: null as FakeAudioBuffer | null,
      onended: null as null | (() => void),
      connect: () => {},
      disconnect: () => {},
      stop: () => {},
      start: (when: number, _offset?: number, playDuration?: number) => {
        started.push({ when, playDuration: playDuration ?? source.buffer?.duration ?? 0 });
      },
    };
    return source;
  }

  decodeAudioData(ab: ArrayBuffer): Promise<FakeAudioBuffer> {
    const duration = durationOf(ab);
    const buffer = new FakeAudioBuffer(CHANNELS, Math.round(duration * SAMPLE_RATE), SAMPLE_RATE);
    if (!this.holdNext) return Promise.resolve(buffer);
    this.holdNext = false;
    return new Promise<FakeAudioBuffer>(resolve => {
      this.held.push(() => resolve(buffer));
    });
  }
}

function installFakeWebAudio(): FakeContext {
  const ctx = new FakeContext();
  (globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext =
    function OfflineAudioContextStub() { return ctx; };
  clearBufferCache();
  return ctx;
}

function placements(): AudioPlacement[] {
  return [
    { start: 0, blob: makeBlob(3), label: 'Интро', role: 'intro' },
    { start: 3, blob: makeBlob(2), label: 'Панель 1', role: 'panel' },
    { start: 30, blob: makeBlob(2), label: 'Панель 2', role: 'panel' },
  ];
}

test('prime() дожидается декодирования и планирует ранние фрагменты', async () => {
  const ctx = installFakeWebAudio();
  const scheduler = await createPlacementScheduler(ctx as never, ctx.destination as never, placements(), {
    startAt: 0,
    lookahead: 4,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
  assert.ok(scheduler);
  assert.equal(scheduler!.total, 3);
  assert.equal(ctx.started.length, 0, 'до prime в графе пусто');

  const added = await scheduler!.prime();
  assert.equal(added, 2, 'в окно опережения попали интро и первая панель');
  assert.equal(scheduler!.scheduled, 2, 'и они реально запланированы, а не просто начаты декодироваться');
  assert.equal(ctx.started.length, 2);
  assert.deepEqual(ctx.started.map(s => s.when), [0, 3], 'играют по своему времени, а не «сразу»');
  assert.equal(ctx.started[0].playDuration, 3);
});

test('prime() не планирует то, что за окном опережения', async () => {
  const ctx = installFakeWebAudio();
  const scheduler = await createPlacementScheduler(ctx as never, ctx.destination as never, placements(), {
    startAt: 0,
    lookahead: 4,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
  await scheduler!.prime(1);
  assert.equal(scheduler!.scheduled, 1, 'в первую секунду попадает только интро');
});

test('tick() добирает фрагменты по мере движения часов', async () => {
  const ctx = installFakeWebAudio();
  const scheduler = await createPlacementScheduler(ctx as never, ctx.destination as never, placements(), {
    startAt: 0,
    lookahead: 4,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
  await scheduler!.prime();

  assert.equal(scheduler!.tick(), 0, 'пока время не ушло вперёд, добирать нечего');
  ctx.currentTime = 27; // до третьего фрагмента осталось 3 с < lookahead
  assert.equal(scheduler!.tick(), 1);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(scheduler!.scheduled, 3);
  assert.equal(ctx.started.length, 3);
});

test('dispose() останавливает источники и закрывает планировщик', async () => {
  const ctx = installFakeWebAudio();
  const scheduler = await createPlacementScheduler(ctx as never, ctx.destination as never, placements(), {
    startAt: 0,
    lookahead: 4,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
  await scheduler!.prime();
  assert.equal(scheduler!.scheduled, 2);

  scheduler!.dispose();
  assert.equal(scheduler!.tick(), 0, 'после dispose новые источники не берутся');
  await scheduler!.prime(1000);
  assert.equal(scheduler!.scheduled, 2, 'prime после dispose ничего не планирует');
});

test('гонка dispose(): декод, завершившийся ПОСЛЕ dispose, не создаёт источник', async () => {
  const ctx = installFakeWebAudio();
  const scheduler = await createPlacementScheduler(ctx as never, ctx.destination as never, placements(), {
    startAt: 0,
    lookahead: 4,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
  });
  assert.ok(scheduler);
  assert.equal(scheduler!.scheduled, 0);

  // tick() запускает декодирование асинхронно и сразу возвращает управление —
  // именно в этом окне раньше и происходила утечка: dispose() очищал active,
  // а завершившийся позже декод добавлял источник, который уже никто не остановит.
  assert.equal(scheduler!.tick(), 2, 'в окно опережения попали два фрагмента');
  scheduler!.dispose();
  const afterDispose = scheduler!.scheduled;

  await new Promise(r => setTimeout(r, 0)); // даём всем декодам завершиться
  assert.equal(scheduler!.scheduled, afterDispose, 'поздние декоды не должны планировать источники');
  assert.equal(afterDispose, 0, 'dispose до применения декодов = в графе пусто');
});
