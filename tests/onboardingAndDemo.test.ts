import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateEnvironment,
  parseChromiumMajorFromUA,
} from '../src/lib/pipeline/environmentProbe';
import {
  buildDemoProjectData,
  createDemoWavBlob,
  DEMO_PLACEHOLDER_SVG_DATA_URL,
} from '../src/lib/pipeline/demoProject';
import {
  deletePanelClipWithRipple,
  duplicatePanelClip,
} from '../src/lib/pipeline/nleOperations';

test('parseChromiumMajorFromUA: распознаёт Chrome, Chromium и HeadlessChrome', () => {
  assert.equal(
    parseChromiumMajorFromUA(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36'
    ),
    131
  );
  assert.equal(
    parseChromiumMajorFromUA('Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36'),
    120
  );
  assert.equal(
    parseChromiumMajorFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15'),
    null
  );
});

test('evaluateEnvironment: возвращает 5 пунктов ✅ при полном окружении Chromium >= 120', async () => {
  const report = await evaluateEnvironment({
    isOPFSSupported: () => true,
    hasIndexedDB: () => true,
    checkCapabilities: async () => ({
      webCodecs: true,
      h264: true,
      aac: true,
      mediaRecorder: true,
      mediabunny: true,
    }),
    isMediaRecorderTypeSupported: (mime) => mime === 'video/webm;codecs=vp9,opus',
    estimateStorage: async () => ({ usage: 50 * 1024 * 1024, quota: 1050 * 1024 * 1024 }),
    getUserAgent: () => 'Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36',
  });

  assert.equal(report.items.length, 5);
  assert.equal(report.allReady, true);
  assert.equal(report.hasBlocker, false);
  assert.ok(report.freeBytes !== null && report.freeBytes > 900 * 1024 * 1024);
  assert.deepEqual(
    report.items.map((i) => [i.id, i.status, i.icon]),
    [
      ['opfs', 'ok', '✅'],
      ['indexeddb', 'ok', '✅'],
      ['webcodecs', 'ok', '✅'],
      ['mediarecorder', 'ok', '✅'],
      ['chromium', 'ok', '✅'],
    ]
  );
});

test('evaluateEnvironment: отмечает warn/fail при отсутствии OPFS, IndexedDB, WebCodecs и старом Chromium', async () => {
  const report = await evaluateEnvironment({
    isOPFSSupported: () => false,
    hasIndexedDB: () => false,
    checkCapabilities: async () => ({
      webCodecs: false,
      h264: false,
      aac: false,
      mediaRecorder: false,
      mediabunny: false,
    }),
    isMediaRecorderTypeSupported: () => false,
    estimateStorage: async () => null,
    getUserAgent: () => 'Mozilla/5.0 Chrome/114.0.0.0 Safari/537.36',
  });

  assert.equal(report.items.length, 5);
  assert.equal(report.allReady, false);
  assert.equal(report.hasBlocker, true);
  assert.equal(report.freeBytes, null);

  const byId = new Map(report.items.map((item) => [item.id, item]));
  assert.equal(byId.get('opfs')?.status, 'warn');
  assert.equal(byId.get('opfs')?.icon, '⚠');
  assert.equal(byId.get('indexeddb')?.status, 'fail');
  assert.equal(byId.get('indexeddb')?.icon, '❌');
  assert.equal(byId.get('webcodecs')?.status, 'warn');
  assert.equal(byId.get('mediarecorder')?.status, 'fail');
  assert.equal(byId.get('chromium')?.status, 'warn');
});

test('buildDemoProjectData и createDemoWavBlob: формируют 2 панели, сценарий, интро/аутро и валидный WAV', async () => {
  const demo = buildDemoProjectData('20.10.2026');
  assert.equal(demo.panels.length, 2);
  assert.equal(demo.timeline.length, 2);
  assert.ok(demo.scenarioText.includes('[0..50%]'));
  assert.ok(demo.scenarioText.includes('[50..100%]'));
  assert.ok(demo.intro.length > 10);
  assert.ok(demo.outro.length > 10);
  assert.equal(demo.introDuration, 1.5);
  assert.equal(demo.outroDuration, 1.5);
  assert.ok(DEMO_PLACEHOLDER_SVG_DATA_URL.startsWith('data:image/svg+xml;utf8,'));

  const wav = createDemoWavBlob(0.5, 220, 22050);
  assert.equal(wav.type, 'audio/wav');
  const bytes = new Uint8Array(await wav.arrayBuffer());
  assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'RIFF');
  assert.equal(String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]), 'WAVE');
});

test('duplicatePanelClip и deletePanelClipWithRipple: дублируют клип со сдвигом и удаляют со сдвигом (Ripple Delete)', () => {
  const demo = buildDemoProjectData('20.10.2026');
  const duplicated = duplicatePanelClip(demo.panels, demo.audioDurations, 0, {
    introDuration: 1.5,
    outroDuration: 1.5,
    panelGap: 0.2,
    currentTimelineVersion: 2,
  });
  assert.equal(duplicated.panels.length, 3);
  assert.deepEqual(
    duplicated.panels.map((p) => p.order),
    [0, 1, 2]
  );
  assert.equal(duplicated.panels[1].id, 2);
  assert.equal(duplicated.panels[1].sourceAudioPanelId, 0);
  assert.equal(duplicated.timeline.length, 3);
  assert.equal(duplicated.timelineVersion, 3);

  const afterDelete = deletePanelClipWithRipple(duplicated.panels, duplicated.audioDurations, 2, {
    introDuration: 1.5,
    outroDuration: 1.5,
    panelGap: 0.2,
    currentTimelineVersion: duplicated.timelineVersion,
  });
  assert.equal(afterDelete.panels.length, 2);
  assert.deepEqual(
    afterDelete.panels.map((p) => p.id),
    [0, 1]
  );
  assert.deepEqual(
    afterDelete.panels.map((p) => p.order),
    [0, 1]
  );
  assert.equal(afterDelete.timeline.length, 2);
  assert.equal(afterDelete.timelineVersion, 4);
});

