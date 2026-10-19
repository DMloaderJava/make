/**
 * Smoke-проверка WebAudio-конвейера (`OfflineAudioContext` -> `mixAudioPlacements` -> `renderExportAudioMixPreviewWav` -> RIFF/WAVE)
 * (Этап 3.1, Н-3.2).
 */
import assert from 'node:assert/strict';
import '../tests/fixtures/browserEnv';
import { pcmToWav, isWav } from '../src/lib/providers/tts/wav';
import {
  assertValidPackedPlacements,
  buildTimelineAudioPlacements,
  clearBufferCache,
  mixAudioPlacements,
  planPlacements,
} from '../src/lib/pipeline/audioMix';
import { renderExportAudioMixPreviewWav } from '../src/lib/pipeline/projectHealth';

function createSineWavBlob(seconds: number, sampleRate = 24000, freqHz = 440): Blob {
  const samplesCount = Math.max(1, Math.round(seconds * sampleRate));
  const pcmBytes = new Uint8Array(samplesCount * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let i = 0; i < samplesCount; i++) {
    const sample = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.5;
    const int16 = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    view.setInt16(i * 2, int16, true);
  }
  const wavAb = pcmToWav(pcmBytes.buffer, { sampleRate });
  return new Blob([wavAb], {
    type: 'audio/wav',
  });
}

async function main() {
  clearBufferCache();

  // 1. Проверяем mixAudioPlacements без totalDuration с подрезкой playDuration = 2.0 с из 3.0-секундного WAV
  const introWav3s = createSineWavBlob(3.0, 24000, 440);
  const sampleRate = 44100;
  const mixed = await mixAudioPlacements(
    [{ start: 0, blob: introWav3s, playDuration: 2.0, label: 'Интро 2с' }],
    undefined,
    { sampleRate, channels: 2 }
  );
  assert.ok(mixed, 'mixAudioPlacements должен вернуть MixedAudio');
  assert.ok(Math.abs(mixed.duration - 2.0) < 1e-4, `Ожидалась duration=2.0, получено ${mixed.duration}`);
  assert.ok(Math.abs(mixed.buffer.duration - 2.0) < 1e-4, `Ожидалась buffer.duration=2.0, получено ${mixed.buffer.duration}`);
  assert.ok(Math.abs(mixed.buffer.length - 2 * sampleRate) <= 1, `Ожидалось ${2 * sampleRate} сэмплов`);

  // 2. Проверяем инвариант playDuration > 0 в planPlacements / assertValidPackedPlacements (Н-3.5)
  const { plan } = await planPlacements([{ start: 0, blob: introWav3s, playDuration: 1.5, label: 'Тест' }]);
  assertValidPackedPlacements(plan.placements);
  assert.throws(
    () => assertValidPackedPlacements([{ start: 0, playDuration: 0, label: 'Нулевой клип' }]),
    /Некорректный playDuration/
  );

  // 3. Проверяем полный рендер WAV-микса (renderExportAudioMixPreviewWav) и заголовок RIFF/WAVE
  const panelWav = createSineWavBlob(1.5, 24000, 520);
  const placements = buildTimelineAudioPlacements({
    timeline: [
      {
        panelId: 1,
        audioStart: 2.0,
        audioEnd: 3.5,
        gain: 1.1,
        fadeIn: 0.1,
        fadeOut: 0.1,
      },
    ],
    panels: [{ id: 1, character: 'Герой' }],
    panelBlobs: new Map([[1, panelWav]]),
    introAudio: introWav3s,
    introDuration: 2.0,
  });

  const wavPreviewBlob = await renderExportAudioMixPreviewWav(placements, 3.5, {
    sampleRate,
  });
  assert.ok(wavPreviewBlob, 'renderExportAudioMixPreviewWav должен вернуть Blob');
  const wavAb = await wavPreviewBlob.arrayBuffer();
  assert.equal(isWav(wavAb), true, 'Результат должен быть валидным RIFF/WAVE');
  const view = new DataView(wavAb);
  const byteRate = view.getUint32(28, true);
  const dataSize = view.getUint32(40, true);
  const wavDuration = byteRate > 0 ? dataSize / byteRate : 0;
  assert.ok(Math.abs(wavDuration - 3.5) < 1e-2, `Ожидалась длительность WAV 3.5 с, получено ${wavDuration}`);

  console.log(
    `smoke:audio — ok: OfflineAudioContext mix (${mixed.buffer.length} frames @ ${sampleRate}Hz, WAV ${wavAb.byteLength} bytes, ${wavDuration.toFixed(2)}s)`
  );
}

main().catch(err => {
  console.error('smoke:audio — FAIL:', err);
  process.exit(1);
});
