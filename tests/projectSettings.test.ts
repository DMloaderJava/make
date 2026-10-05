import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTTSProviderId } from '../src/lib/pipeline/projectSettings';

test('the live project selection wins over the app default before autosave completes', () => {
  const storedProject = { settings: { ttsProvider: 'elevenlabs' } };
  const updatedProject = {
    ...storedProject,
    settings: { ...storedProject.settings, ttsProvider: 'gemini' },
  };

  // runAudioGeneration resolves against the current in-memory Project, not a
  // possibly stale IndexedDB copy while the autosave debounce is still pending.
  assert.equal(resolveTTSProviderId(updatedProject.settings.ttsProvider, 'elevenlabs'), 'gemini');
  assert.equal(resolveTTSProviderId('elevenlabs', 'global-default', 'explicit-choice'), 'explicit-choice');
});

test('the app default is used only when the project has no provider selection', () => {
  assert.equal(resolveTTSProviderId('', 'gemini'), 'gemini');
  assert.equal(resolveTTSProviderId(undefined, 'gemini'), 'gemini');
  assert.equal(resolveTTSProviderId('', ''), '');
});
