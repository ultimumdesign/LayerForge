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

function createLoadedPatch(trimStart = 0, trimEnd = 1) {
  const state = createDefaultState();
  Object.assign(state.layers[0], {
    loaded: true,
    sampleKey: 'kick',
    sampleCount: sample.length,
    sampleRate: SAMPLE_RATE,
    trimStart,
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
  const state = createLoadedPatch(0.25, 0.75);
  const restored = restorePatchState(serializePatchState(state), { kick: sample });
  assert.equal(restored.layers[0].trimStart, 0.25);
  assert.equal(restored.layers[0].trimEnd, 0.75);

  const invalid = serializePatchState(state);
  invalid.layers[0].trimStart = 0.8;
  invalid.layers[0].trimEnd = 0.2;
  const clamped = restorePatchState(invalid, { kick: sample }).layers[0];
  assert.equal(clamped.trimStart, 0.8);
  assert.ok(clamped.trimEnd - clamped.trimStart >= 0.01);
});

test('channel and sum previews respect both trim markers', () => {
  const state = createLoadedPatch(0.25, 0.75);
  const channelPeaks = getLayerPreviewPeaks(sample, state.layers[0], SAMPLE_RATE);
  const sum = getLayerSumPeaks(state, { kick: sample }, { kick: SAMPLE_RATE });
  const playback = getLayerPlaybackInfo(state, { kick: sample }, { kick: SAMPLE_RATE });

  assert.ok(channelPeaks.slice(0, 32).every((peak) => peak === 0));
  assert.ok(channelPeaks.slice(32, 96).some((peak) => peak > 0));
  assert.ok(channelPeaks.slice(96).every((peak) => peak === 0));
  assert.equal(sum.durationSec, 0.5);
  assert.equal(playback[0].durationSec, 0.5);
});

test('offline DSP waveform preview renders the selected trim range', async () => {
  const sampleWithLeadingSilence = new Float32Array(SAMPLE_RATE);
  for (let index = SAMPLE_RATE / 4; index < (SAMPLE_RATE * 3) / 4; index += 1) {
    sampleWithLeadingSilence[index] = sample[index];
  }
  const preview = await renderWaveformPreview(
    createLoadedPatch(0.25, 0.75),
    { kick: sampleWithLeadingSilence }
  );

  assert.equal(preview.durationSec, 0.52);
  assert.equal(preview.peaks.length, 176);
  assert.ok(preview.peaks.slice(0, 20).some((peak) => peak > 0));
});
