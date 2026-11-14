import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDefaultState,
  restorePatchState,
  serializePatchState
} from '../dsp/parameters.js';
import {
  getLayerPlaybackInfo,
  getLayerPreviewPeaks,
  getLayerSumPeaks
} from '../src/audio/waveform.js';
import { renderWaveformPreview } from '../src/audio/wavExport.js';

const SAMPLE_RATE = 44100;
const sample = Float32Array.from(
  { length: SAMPLE_RATE },
  (_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE)
);

function createLoadedPatch(trimEnd = 1) {
  const state = createDefaultState();
  Object.assign(state.layers[0], {
    loaded: true,
    sampleKey: 'kick',
    sampleCount: sample.length,
    sampleRate: SAMPLE_RATE,
    trimEnd,
    envelopePoints: [
      { time: 0, value: 1 },
      { time: 1, value: 1 }
    ],
    gain: 1,
    hp: 20,
    lp: 20000,
    clipDrive: 0,
    clipHardness: 0
  });
  state.noise.mute = true;
  state.noise.gain = 0;
  state.master.drive = 0;
  state.master.hardness = 0;
  state.master.ceiling = 1;
  return state;
}

test('trim is persisted and clamped when restoring a patch', () => {
  const state = createLoadedPatch(0.42);
  const restored = restorePatchState(serializePatchState(state), { kick: sample });
  assert.equal(restored.layers[0].trimEnd, 0.42);

  const invalid = serializePatchState(state);
  invalid.layers[0].trimEnd = 4;
  assert.equal(restorePatchState(invalid, { kick: sample }).layers[0].trimEnd, 1);
});

test('channel and sum previews respect the trimmed sample boundary', () => {
  const state = createLoadedPatch(0.5);
  const channelPeaks = getLayerPreviewPeaks(sample, state.layers[0], SAMPLE_RATE);
  const sum = getLayerSumPeaks(state, { kick: sample }, { kick: SAMPLE_RATE });
  const playback = getLayerPlaybackInfo(state, { kick: sample }, { kick: SAMPLE_RATE });

  assert.ok(channelPeaks.slice(0, 64).some((peak) => peak > 0));
  assert.ok(channelPeaks.slice(64).every((peak) => peak === 0));
  assert.equal(sum.durationSec, 0.5);
  assert.equal(playback[0].durationSec, 0.5);
});

test('offline DSP waveform preview renders the trimmed duration', async () => {
  const preview = await renderWaveformPreview(createLoadedPatch(0.5), { kick: sample });

  assert.equal(preview.durationSec, 0.52);
  assert.equal(preview.peaks.length, 176);
  assert.ok(preview.peaks.some((peak) => peak > 0));
});
