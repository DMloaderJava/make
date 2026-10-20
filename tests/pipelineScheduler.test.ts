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
  private channelsData: Float32Array[];
  constructor(public numberOfChannels: number, length: number, public sampleRate: number) {
    this.length = length;
    this.duration = length / sampleRate;
    this.channelsData = Array.from({ length: numberOfChannels }, () => {
      const arr = new Float32Array(length);
      arr.fill(0.5);
      return arr;
    });
  }
  getChannelData(ch = 0): Float32Array {
    return this.channelsData[ch] ?? this.channelsData[0];
  }
  copyToChannel(src: Float32Array, ch = 0): void {
    const dest = this.channelsData[ch];
    if (dest) dest.set(src.subarray(0, dest.length));
  }
}

class FakeContext {
  currentTime = 0;
  sampleRate = SAMPLE_RATE;
  /** Что реально попало в граф: когда и как долго. */
  started: Array<{ when: number; playDuration: number; buffer?: FakeAudioBuffer | null }> = [];
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
        started.push({
          when,
          playDuration: playDuration ?? source.buffer?.duration ?? 0,
          buffer: source.buffer,
        });
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

test('createPlacementScheduler: применяет огибающую (muted/gain/trim) и фиксирует startedAt ПОСЛЕ planPlacements', async () => {
  const ctx = installFakeWebAudio();
  // Имитируем продвижение часов AudioContext во время измерения длительностей
  ctx.currentTime = 1.5;
  const scheduler = await createPlacementScheduler(
    ctx as never,
    ctx.destination as never,
    [
      {
        start: 0,
        blob: makeBlob(2),
        label: 'Заглушенная панель',
        role: 'panel',
        muted: true,
      },
    ],
    {
      lookahead: 4,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
    }
  );
  assert.ok(scheduler);
  assert.ok(
    scheduler!.startedAt >= 1.5,
    `startedAt (${scheduler!.startedAt}) должен отсчитываться от текущего времени после planPlacements`
  );
  await scheduler!.prime();
  assert.equal(ctx.started.length, 1);
  const scheduledBuffer = ctx.started[0].buffer as unknown as { getChannelData: (ch: number) => Float32Array };
  const samples = scheduledBuffer.getChannelData(0);
  const maxAbs = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.equal(maxAbs, 0, 'заглушенный клип (muted: true) в планировщике MediaRecorder должен быть тишиной');
});

test('WebCodecsBackend.renderWithMediabunny: реально вызывает output.start() ДО appendPlacements и не обрезает немое аутро', async () => {
  const { WebCodecsBackend } = await import('../src/lib/pipeline/videoEncoder');
  installFakeWebAudio();
  const prevDocument = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        save: () => {},
        restore: () => {},
        fillRect: () => {},
        strokeRect: () => {},
        fillText: () => {},
        drawImage: () => {},
        beginPath: () => {},
        rect: () => {},
        roundRect: () => {},
        arc: () => {},
        clearRect: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arcTo: () => {},
        closePath: () => {},
        fill: () => {},
        stroke: () => {},
        clip: () => {},
        measureText: (t: string) => ({ width: t.length * 8 }),
        createLinearGradient: () => ({ addColorStop: () => {} }),
      }),
    }),
  };

  try {
    const events: string[] = [];
    let outputStarted = false;
    let videoFramesAdded = 0;

    class FakeBufferTarget {
      buffer = new Uint8Array([0x00, 0x00, 0x00, 0x18]).buffer;
    }
    class FakeMp4OutputFormat {}
    class FakeCanvasSource {
      async add() {
        if (!outputStarted) {
          throw new Error('Output has not started.');
        }
        videoFramesAdded++;
        if (videoFramesAdded === 1) events.push('canvasSource.add');
      }
    }
    class FakeAudioBufferSource {
      async add() {
        if (!outputStarted) {
          throw new Error('Output has not started.');
        }
        events.push('audioSource.add');
      }
    }
    class FakeOutput {
      addVideoTrack() {
        events.push('output.addVideoTrack');
      }
      addAudioTrack() {
        events.push('output.addAudioTrack');
      }
      async start() {
        outputStarted = true;
        events.push('output.start');
      }
      async finalize() {
        events.push('output.finalize');
      }
    }

    const backend = new WebCodecsBackend();
    const progressEvents: Array<{ p: number; stage?: string }> = [];
    // 1.0 с аудио панели + 1.0 с немого аутро => timelineDuration = 2.0 с (20 кадров при 10 fps)
    const blob = await backend.renderWithMediabunny(
      {
        images: [],
        audioBlobs: [],
        audioPlacements: [{ start: 0, blob: makeBlob(1), label: 'Панель 1', role: 'panel' }],
        timeline: [
          {
            panelId: 1,
            imageIndex: 0,
            audioStart: 0,
            audioEnd: 1.0,
            panelBbox: { x: 0, y: 0, width: 100, height: 100 },
            voiceId: 'v1',
            text: 'Тест',
            character: 'Герой',
          },
        ],
        introText: '',
        outroText: 'Подписывайтесь!',
        introDuration: 0,
        outroDuration: 1.0,
        srtContent: '',
        width: 320,
        height: 180,
        fps: 10,
        onProgress: (p, stage) => progressEvents.push({ p, stage }),
      },
      {
        Output: FakeOutput,
        Mp4OutputFormat: FakeMp4OutputFormat,
        CanvasSource: FakeCanvasSource,
        AudioBufferSource: FakeAudioBufferSource,
        BufferTarget: FakeBufferTarget,
      }
    );

    assert.equal(blob.type, 'video/mp4');
    assert.deepEqual(events, [
      'output.addVideoTrack',
      'output.addAudioTrack',
      'output.start',
      'audioSource.add',
      'canvasSource.add',
      'output.finalize',
    ]);
    assert.equal(
      videoFramesAdded,
      20,
      'длительность видео должна включать немое аутро (2.0 с * 10 fps = 20 кадров, а не обрезаться до 1.0 с аудио)'
    );
    assert.deepEqual(
      progressEvents.map(item => item.p),
      [0, 0, 0.25, 0.5, 0.75, 0.9, 1],
      'onProgress должен вызываться на инициализации, каждые 5 кадров, на обработке аудио (0.9) и завершении (1)'
    );
    assert.ok(
      progressEvents.some(item => item.stage?.includes('Рендеринг') || item.stage?.includes('Кодирование')),
      'этапы прогресса должны содержать «Рендеринг» или «Кодирование»'
    );
    assert.ok(
      progressEvents.some(item => item.stage?.includes('Обработка аудио')),
      'этапы прогресса должны содержать «Обработка аудио»'
    );

    // Проверка отмены рендеринга через signal.aborted (AbortError)
    const abortCtrl = new AbortController();
    await assert.rejects(
      async () => {
        await backend.renderWithMediabunny(
          {
            images: [],
            audioBlobs: [],
            timeline: [],
            introText: '',
            outroText: '',
            introDuration: 1.0,
            outroDuration: 1.0,
            srtContent: '',
            width: 320,
            height: 180,
            fps: 10,
            signal: abortCtrl.signal,
            onProgress: (p) => {
              if (p >= 0.25) abortCtrl.abort();
            },
          },
          {
            Output: FakeOutput,
            Mp4OutputFormat: FakeMp4OutputFormat,
            CanvasSource: FakeCanvasSource,
            AudioBufferSource: FakeAudioBufferSource,
            BufferTarget: FakeBufferTarget,
          }
        );
      },
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
      'signal.aborted должен прерывать рендеринг с AbortError'
    );
  } finally {
    (globalThis as Record<string, unknown>).document = prevDocument;
  }
});

