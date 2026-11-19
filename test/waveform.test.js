import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import OfflineRenderer from '@elemaudio/offline-renderer';
import { el } from '@elemaudio/core';
import { createHitPeakTracker } from '../src/audio/meterPeaks.js';
import { buildDrumGraph } from '../dsp/engine.js';
import { builtinImpulseKey, createBuiltinImpulses, resampleImpulse } from '../dsp/convolution.js';
import { colorNoise, glueCompressor, saturator } from '../dsp/nodes.js';
import { getEnvelopeSequence, getEnvelopeValueAt } from '../dsp/envelope.js';
import {
  createDefaultState,
  getSampleTrimRange,
  resetBusModuleKnobs,
  resetLayerKnobs,
  restorePatchState,
  serializePatchState,
  swapLayerSamples
} from '../dsp/parameters.js';
import {
  getEnvelopeDisplayValue,
  getEnvelopeDisplayY,
  detectSilenceEnd,
  detectSilenceStart,
  getDefaultSampleTrim,
  getComparisonCursorRange,
  getLayerPreviewWaveform,
  getPhaseOffset,
  getLayerPlaybackInfo,
  getPlayableSourceDurationSec,
  getLayerSumPeaks,
  getTrimmedPreviewRange,
  getZoomedPreviewRange,
  getSampleAreaPath,
  getWaveformFitGain,
  getWaveformPaths,
  mapOutputWaveformToSource,
  mergeStereoWaveform
} from '../src/audio/waveform.js';
import { getPatchDurationSec, renderWavBlob, renderWaveformPreview } from '../src/audio/wavExport.js';
import { LiveComparisonTrace, LiveTrace, reduceComparisonResolution, reduceWaveformResolution } from '../src/audio/liveTrace.js';
import { createPatchHistory, getHistoryShortcut } from '../src/patchHistory.js';

const SAMPLE_RATE = 44100;
const sample = Float32Array.from(
  { length: SAMPLE_RATE },
  (_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE)
);

test('decorative border animation avoids repainting panel backgrounds and shadows', () => {
  const styles = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
  const animation = styles.match(/@keyframes theme-laser-trace\s*\{\s*from\s*\{([^}]*)\}\s*to\s*\{([^}]*)\}/);
  assert.ok(animation);
  assert.match(animation[1], /opacity:\s*0/);
  assert.match(animation[2], /opacity:\s*1/);
  assert.doesNotMatch(animation[0], /background-position|box-shadow/);
});

test('convolution profiles are deterministic, stereo and distinct', () => {
  const first = createBuiltinImpulses();
  const second = createBuiltinImpulses();
  for (const profile of ['room', 'plate', 'chamber']) {
    const left = first[builtinImpulseKey(profile, 'left')];
    const right = first[builtinImpulseKey(profile, 'right')];
    assert.ok(left.length > 0);
    assert.equal(left.length, right.length);
    assert.deepEqual(left, second[builtinImpulseKey(profile, 'left')]);
    assert.notDeepEqual(left, right);
    assert.ok(left.every(Number.isFinite));
  }
  assert.notEqual(first[builtinImpulseKey('room', 'left')].length,
    first[builtinImpulseKey('plate', 'left')].length);
});

test('impulse resampling preserves delay, duration and DC gain at different rates', () => {
  const source = new Float32Array(4410);
  source[441] = 1;
  for (const target of [22050, 48000, 88200]) {
    const result = resampleImpulse(source, 44100, target);
    assert.equal(result.length, Math.ceil(source.length * target / 44100));
    const peak = result.indexOf(Math.max(...result));
    assert.ok(Math.abs(peak / target - 0.01) <= 1 / target);
    assert.ok(Math.abs(result.reduce((sum, value) => sum + value, 0) - 1) < 0.01);
  }
  assert.throws(() => resampleImpulse(source, 0, 44100), /sample rates/);
  assert.throws(() => resampleImpulse(new Float32Array(), 44100, 44100), /non-empty/);
});

test('convolution patch migration and profile restoration retain state', () => {
  const legacy = restorePatchState({ master: { busOrder: ['glue', 'noise', 'saturation'] } });
  assert.deepEqual(legacy.master.busOrder, ['glue', 'noise', 'ringMod', 'convolve', 'saturation']);
  assert.equal(legacy.master.convolveEnabled, false);
  const patch = createDefaultState();
  patch.master.convolveEnabled = true;
  patch.master.convolveProfile = 'chamber';
  const serialized = serializePatchState(patch);
  const restored = restorePatchState(serialized);
  assert.equal(restored.master.convolveProfile, 'chamber');
  assert.equal(restored.master.convolveEnabled, true);
  const reset = resetBusModuleKnobs(restored, 'convolve');
  assert.equal(reset.master.convolveProfile, 'room');
  assert.equal(reset.master.convolveEnabled, true);
  assert.deepEqual(reset.master.busOrder, restored.master.busOrder);
});

test('ring modulation state migrates, validates, round-trips and resets its knobs', () => {
  const legacy = restorePatchState({ master: { busOrder: ['glue', 'noise', 'saturation', 'convolve'] } });
  assert.deepEqual(legacy.master.busOrder, ['glue', 'noise', 'ringMod', 'saturation', 'convolve']);
  assert.equal(legacy.master.ringModEnabled, false);
  assert.deepEqual(
    [legacy.master.ringModPhase, legacy.master.ringModBias, legacy.master.ringModRectify, legacy.master.ringModSpread],
    [0, 0, 0, 0]
  );
  const patch = createDefaultState();
  Object.assign(patch.master, {
    busOrder: ['ringMod', 'noise', 'glue', 'convolve', 'saturation'],
    ringModEnabled: true, ringModMute: true, ringModFrequency: 300, ringModMix: 0.4, ringModGainDb: -6,
    ringModPhase: 90, ringModBias: 0.5, ringModRectify: -0.5, ringModSpread: 0.75
  });
  const restored = restorePatchState(serializePatchState(patch));
  assert.deepEqual(restored.master, patch.master);
  const reset = resetBusModuleKnobs(restored, 'ringMod');
  assert.equal(reset.master.ringModFrequency, 100);
  assert.equal(reset.master.ringModMix, 1);
  assert.equal(reset.master.ringModGainDb, 0);
  assert.deepEqual(
    [reset.master.ringModPhase, reset.master.ringModBias, reset.master.ringModRectify, reset.master.ringModSpread],
    [0, 0, 0, 0]
  );
  assert.equal(reset.master.ringModEnabled, true);
  assert.equal(reset.master.ringModMute, true);
  assert.deepEqual(reset.master.busOrder, patch.master.busOrder);
  const bounded = restorePatchState({ master: {
    ringModFrequency: 9000, ringModMix: -1, ringModGainDb: 99,
    ringModPhase: 500, ringModBias: 2, ringModRectify: -2, ringModSpread: 2
  } });
  assert.equal(bounded.master.ringModFrequency, 5000);
  assert.equal(bounded.master.ringModMix, 0);
  assert.equal(bounded.master.ringModGainDb, 24);
  assert.deepEqual(
    [bounded.master.ringModPhase, bounded.master.ringModBias, bounded.master.ringModRectify, bounded.master.ringModSpread],
    [360, 1, -1, 1]
  );
});

test('ring carrier phase, bias, rectification and spread shape stereo audio', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].sampleRightKey = 'right';
  Object.assign(patch.master, { drive: 0, hardness: 1, ceiling: 1, ringModEnabled: true, ringModFrequency: 100 });
  const resources = { kick: sample, right: Float32Array.from(sample, (value) => value * 0.5) };
  const render = async (changes) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({
      numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: resources
    });
    const state = { ...patch, master: { ...patch.master, ...changes }, gate: 0 };
    await renderer.render(...buildDrumGraph(state, true));
    renderer.process([], Array.from({ length: 22 }, () => new Float32Array(22016)));
    await renderer.render(...buildDrumGraph({ ...state, gate: 1 }, true));
    const outputs = Array.from({ length: 22 }, () => new Float32Array(8192));
    renderer.process([], outputs);
    return outputs;
  };
  const phase = await render({ ringModPhase: 90 });
  const bias = await render({ ringModBias: 0.5 });
  const positive = await render({ ringModRectify: 1 });
  const negative = await render({ ringModRectify: -1 });
  const partial = await render({ ringModRectify: 0.5 });
  const spread = await render({ ringModSpread: 1 });
  const dry = await render({ ringModMix: 0, ringModPhase: 90, ringModBias: 1, ringModRectify: 1, ringModSpread: 1 });
  for (let i = 50; i < 8192; i += 37) {
    const angle = 2 * Math.PI * 100 * i / SAMPLE_RATE;
    const input = phase[3][i];
    assert.ok(Math.abs(phase[0][i] - input * Math.cos(angle)) < 0.001);
    assert.ok(Math.abs(bias[0][i] - input * (Math.sin(angle) + 0.5)) < 0.001);
    assert.ok(Math.abs(positive[0][i] - input * Math.abs(Math.sin(angle))) < 0.001);
    assert.ok(Math.abs(negative[0][i] + input * Math.abs(Math.sin(angle))) < 0.001);
    assert.ok(Math.abs(partial[0][i] - input * (Math.sin(angle) + Math.abs(Math.sin(angle))) * 0.5) < 0.001);
    assert.ok(Math.abs(spread[0][i] - spread[3][i] * Math.sin(2 * Math.PI * 95 * i / SAMPLE_RATE)) < 0.001);
    assert.ok(Math.abs(spread[1][i] - spread[4][i] * Math.sin(2 * Math.PI * 105 * i / SAMPLE_RATE)) < 0.001);
    assert.ok(Math.abs(dry[0][i] - dry[3][i]) < 0.001);
  }
});

test('ring modulation creates sidebands, preserves stereo and follows mix, gain, bypass and order', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].sampleRightKey = 'right';
  Object.assign(patch.master, { drive: 0, hardness: 1, ceiling: 1, ringModEnabled: true, ringModFrequency: 100 });
  const resources = { kick: sample, right: Float32Array.from(sample, (value) => value * 0.5) };
  const render = async (changes) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({
      numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: resources
    });
    const state = { ...patch, master: { ...patch.master, ...changes }, gate: 0 };
    await renderer.render(...buildDrumGraph(state, true));
    renderer.process([], Array.from({ length: 22 }, () => new Float32Array(22016)));
    await renderer.render(...buildDrumGraph({ ...state, gate: 1 }, true));
    const output = Array.from({ length: 22 }, () => new Float32Array(35280));
    renderer.process([], output);
    return output;
  };
  const dry = await render({ ringModMix: 0 });
  const wet = await render({ ringModMix: 1 });
  const half = await render({ ringModMix: 0.5 });
  const gain = await render({ ringModMix: 0, ringModGainDb: 6 });
  const disabled = await render({ ringModEnabled: false, ringModGainDb: 6 });
  const muted = await render({ ringModMute: true, ringModGainDb: 6 });
  assert.deepEqual(disabled[0], muted[0]);
  assert.deepEqual(disabled[20], disabled[21]);
  for (let i = 5000; i < 30000; i += 97) {
    assert.ok(Math.abs(half[0][i] - (dry[0][i] + wet[0][i]) * 0.5) < 1e-5);
    assert.ok(Math.abs(wet[1][i] - wet[0][i] * 0.5) < 1e-5);
    assert.ok(Math.abs(gain[0][i] - dry[0][i] * Math.pow(10, 6 / 20)) < 1e-5);
    assert.ok(Math.abs(wet[21][i] - Math.abs(wet[0][i])) < 1e-5);
  }
  const amplitude = (frequency) => {
    let real = 0, imaginary = 0;
    for (let i = 8820; i < 35280; i += 1) {
      const phase = 2 * Math.PI * frequency * i / SAMPLE_RATE;
      real += wet[0][i] * Math.cos(phase);
      imaginary += wet[0][i] * Math.sin(phase);
    }
    return Math.hypot(real, imaginary);
  };
  assert.ok(amplitude(340) > amplitude(440) * 20);
  assert.ok(amplitude(540) > amplitude(440) * 20);
  const before = await render({ busOrder: ['noise', 'convolve', 'ringMod', 'saturation', 'glue'] });
  assert.deepEqual(before[21], before[13]);
});

test('ring carrier runs through gate release and restarts on retrigger', async () => {
  const patch = createLoadedPatch();
  Object.assign(patch.master, { drive: 0, hardness: 1, ceiling: 1, ringModEnabled: true, ringModFrequency: 100 });
  const renderer = new OfflineRenderer();
  await renderer.initialize({
    numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE,
    blockSize: 128, virtualFileSystem: { kick: sample }
  });
  const render = async (gate, length) => {
    await renderer.render(...buildDrumGraph({ ...patch, gate }, true));
    const outputs = Array.from({ length: 22 }, () => new Float32Array(length));
    renderer.process([], outputs);
    return outputs;
  };
  await render(0, 22016);
  const attack = await render(1, 1408);
  const release = await render(0, 1408);
  const retrigger = await render(1, 1024);
  for (const [outputs, offset] of [[attack, 0], [release, 1408], [retrigger, 0]]) {
    for (let i = 20; i < outputs[0].length; i += 31) {
      const expected = outputs[3][i] * Math.sin(2 * Math.PI * 100 * (i + offset) / SAMPLE_RATE);
      assert.ok(Math.abs(outputs[0][i] - expected) < 0.001, `carrier mismatch at frame ${i + offset}`);
    }
  }
});

test('convolution graph changes rendered audio and mute bypasses it', async () => {
  const patch = createLoadedPatch();
  patch.master.convolveEnabled = true;
  patch.master.convolveMix = 1;
  const resources = { kick: sample, ...createBuiltinImpulses() };
  const render = async (master) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({
      numInputChannels: 0, numOutputChannels: 2, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: resources
    });
    await renderer.render(...buildDrumGraph({ ...patch, master, gate: 1 }));
    const outputs = [new Float32Array(8192), new Float32Array(8192)];
    renderer.process([], outputs);
    return outputs;
  };
  const wet = await render(patch.master);
  const muted = await render({ ...patch.master, convolveMute: true });
  const bypass = await render({ ...patch.master, convolveEnabled: false });
  const legacy = await render({ ...patch.master, convolveEnabled: false, busOrder: ['noise', 'saturation', 'glue'] });
  assert.deepEqual(muted, bypass);
  assert.deepEqual(bypass, legacy);
  assert.ok(wet[0].some((value, index) => Math.abs(value - bypass[0][index]) > 1e-4));
  assert.ok(wet[0].some((value, index) => Math.abs(value - wet[1][index]) > 1e-4));
});

test('convolution extends rendered preview and WAV duration only while active', async () => {
  const patch = createLoadedPatch();
  const buffers = { kick: sample };
  const dryDuration = getPatchDurationSec(patch, buffers);
  Object.assign(patch.master, { convolveEnabled: true, convolveProfile: 'plate', convolvePredelay: 100, convolveMix: 1 });
  const wetDuration = getPatchDurationSec(patch, buffers);
  assert.ok(Math.abs(wetDuration - dryDuration - 0.55) < 1e-9);
  const preview = await renderWaveformPreview(patch, buffers);
  assert.equal(preview.durationSec, wetDuration);
  assert.ok(preview.comparison.final.transient.some((value) => Math.abs(value) > 0));
  patch.master.convolveMute = true;
  assert.equal(getPatchDurationSec(patch, buffers), dryDuration);
});

test('master bus controls and tails do not change channel preview waveforms', async () => {
  const patch = createLoadedPatch();
  const baseline = await renderWaveformPreview(patch, { kick: sample });
  Object.assign(patch.master, {
    convolveEnabled: true,
    convolveProfile: 'plate',
    convolvePredelay: 120,
    convolveMix: 1,
    saturationEnabled: true,
    saturationDrive: 20,
    saturationMix: 0.8,
    glueEnabled: true,
    glueThreshold: -30,
    glueGainDb: 6,
    outputDb: -12
  });
  const processed = await renderWaveformPreview(patch, { kick: sample });
  assert.notEqual(processed.durationSec, baseline.durationSec);
  assert.notDeepEqual(processed.comparison.final.transient, baseline.comparison.final.transient);
  assert.deepEqual(processed.comparison.channelPreviews, baseline.comparison.channelPreviews);
  assert.deepEqual(processed.comparison.layerDurations, baseline.comparison.layerDurations);

  patch.layers[0].inputDb = -6;
  const channelEdited = await renderWaveformPreview(patch, { kick: sample });
  assert.notDeepEqual(channelEdited.comparison.channelPreviews[0], baseline.comparison.channelPreviews[0]);
});

test('one channel preview is independent of another channel playback duration', async () => {
  const patch = createLoadedPatch();
  Object.assign(patch.layers[1], {
    loaded: true,
    sampleKey: 'snare',
    sampleCount: SAMPLE_RATE / 2,
    sampleRate: SAMPLE_RATE,
    envelopePoints: [{ time: 0, value: 1 }, { time: 1, value: 1 }]
  });
  const buffers = { kick: sample, snare: sample.subarray(0, SAMPLE_RATE / 2) };
  const baseline = await renderWaveformPreview(patch, buffers);
  patch.layers[1].delayMs = 300;
  const delayed = await renderWaveformPreview(patch, buffers);
  assert.deepEqual(delayed.comparison.channelPreviews[0], baseline.comparison.channelPreviews[0]);
  assert.notDeepEqual(delayed.comparison.channelPreviews[1], baseline.comparison.channelPreviews[1]);
});

test('convolution predelay delays only the wet audio in rendered previews', async () => {
  const patch = createLoadedPatch();
  const kick = new Float32Array(441);
  kick.fill(0.5, 0, 100);
  patch.layers[0].sampleCount = kick.length;
  Object.assign(patch.master, { convolveEnabled: true, convolveMix: 1, convolvePredelay: 150 });
  const preview = await renderWaveformPreview(patch, { kick }, 2048);
  assert.ok(preview.comparison.final.transient.every((value) => Math.abs(value) < 1e-5));
  assert.ok(preview.comparison.final.max.some((value, index) =>
    index / 2048 * preview.durationSec > 0.15 && Math.abs(value) > 1e-4));
});

test('convolution meter lanes follow bypass and effect output', async () => {
  const patch = createLoadedPatch();
  Object.assign(patch.master, { convolveEnabled: true, convolveMix: 1 });
  const render = async (muted) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({
      numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: { kick: sample, ...createBuiltinImpulses() }
    });
    await renderer.render(...buildDrumGraph({
      ...patch, gate: 1, master: { ...patch.master, convolveMute: muted }
    }, true));
    const output = Array.from({ length: 22 }, () => new Float32Array(8192));
    renderer.process([], output);
    return output;
  };
  const wet = await render(false);
  const muted = await render(true);
  assert.ok(wet[18].some((value) => value > 0));
  assert.ok(wet[19].some((value, index) => Math.abs(value - wet[18][index]) > 1e-4));
  assert.deepEqual(muted[18], muted[19]);
  assert.deepEqual(muted[13], muted[14]);
  assert.deepEqual(muted[15], muted[16]);
});

test('patch undo and redo group gestures, preserve unrelated state, and discard abandoned redo', () => {
  const history = createPatchHistory();
  const initial = createDefaultState();
  const changed = (state, pitch) => ({
    ...state,
    layers: state.layers.map((layer, index) => index ? layer : { ...layer, pitch })
  });
  const gesture = Symbol('drag');
  const first = changed(initial, 4);
  const last = changed(first, 9);
  history.record(initial, first, gesture);
  history.record(first, last, gesture);
  const playing = { ...last, gate: 1, velocity: 0.4, noise: { ...last.noise, gain: 0.7 } };
  const undone = history.undo(playing);
  assert.equal(undone.layers[0].pitch, initial.layers[0].pitch);
  assert.equal(undone.noise.gain, 0.7);
  assert.equal(undone.gate, 1);
  assert.equal(undone.velocity, 0.4);
  assert.equal(history.undo(undone), null);
  const redone = history.redo(undone);
  assert.equal(redone.layers[0].pitch, 9);
  const newEdit = changed(undone, 2);
  history.undo(redone);
  history.record(undone, newEdit);
  assert.equal(history.redo(newEdit), null);
});

test('patch history preserves stereo swaps and invalidates only automated parameters', () => {
  const history = createPatchHistory();
  const initial = createDefaultState();
  const stereo = {
    ...initial,
    layers: initial.layers.map((layer, index) => index === 0
      ? { ...layer, loaded: true, sampleKey: 'left', sampleRightKey: 'right' } : layer)
  };
  const swapped = { ...stereo, layers: swapLayerSamples(stereo.layers, 0, 1) };
  history.record(stereo, swapped);
  const edited = { ...swapped, master: { ...swapped.master, drive: 8, ceiling: 0.5 } };
  history.record(swapped, edited);
  history.invalidate(['master', 'drive']);
  const automated = { ...edited, master: { ...edited.master, drive: 12 } };
  const undoControls = history.undo(automated);
  assert.equal(undoControls.master.drive, 12);
  assert.equal(undoControls.master.ceiling, swapped.master.ceiling);
  const undoSwap = history.undo(undoControls);
  assert.equal(undoSwap.layers[0].sampleKey, 'left');
  assert.equal(undoSwap.layers[0].sampleRightKey, 'right');
  const redoSwap = history.redo(undoSwap);
  assert.equal(redoSwap.layers[1].sampleKey, 'left');
  assert.equal(redoSwap.layers[1].sampleRightKey, 'right');
  history.clear();
  assert.equal(history.undo(redoSwap), null);
  assert.equal(history.redo(redoSwap), null);
});

test('undo shortcuts leave text editing alone and support Mac and Windows redo', () => {
  const event = { key: 'z', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: 'BUTTON' } };
  assert.equal(getHistoryShortcut(event), 'undo');
  assert.equal(getHistoryShortcut({ ...event, key: 'Z', shiftKey: true }), 'redo');
  assert.equal(getHistoryShortcut({ ...event, metaKey: false, ctrlKey: true, key: 'y' }), 'redo');
  assert.equal(getHistoryShortcut({ ...event, target: { tagName: 'INPUT', type: 'text' } }), null);
  assert.equal(getHistoryShortcut({ ...event, target: { tagName: 'TEXTAREA' } }), null);
  assert.equal(getHistoryShortcut({ ...event, target: { isContentEditable: true } }), null);
  assert.equal(getHistoryShortcut({ ...event, target: { tagName: 'INPUT', type: 'range' } }), 'undo');
  assert.equal(getHistoryShortcut({ ...event, target: { tagName: 'SELECT' } }), 'undo');
  assert.equal(getHistoryShortcut({ ...event, defaultPrevented: true }), null);
});

test('waveform viewer switches to the trace and shows source and output time axes', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: App, AboutDialog, BrandSignature, ModuleControls, ModuleSettingsDialog, WavCopyButton, getHelpSettings, hasPatchChanges, isInitialPatch, matchesReferencedSample, observeNativeEditorHeight, reorderBusModules } = await server.ssrLoadModule('/src/App.jsx');
    const { HitButton, AuditionCloseButton } = await server.ssrLoadModule('/src/components/HitButton.jsx');
    assert.deepEqual(getHelpSettings(), { hover: false, dspInfo: true });
    assert.deepEqual(getHelpSettings({ hover: true, dspInfo: false }), { hover: true, dspInfo: false });
    assert.deepEqual(getHelpSettings({ hover: 'true', dspInfo: null }), { hover: false, dspInfo: true });
    const initialPatch = createDefaultState();
    assert.equal(isInitialPatch(initialPatch), true);
    assert.equal(isInitialPatch({ ...initialPatch, layers: initialPatch.layers.map((layer, index) =>
      index === 0 ? { ...layer, pitch: 0.1 } : layer) }), false);
    assert.equal(isInitialPatch({ ...initialPatch, layers: initialPatch.layers.map((layer, index) =>
      index === 0 ? { ...layer, loaded: true, sampleKey: 'sample' } : layer) }), false);
    assert.equal(isInitialPatch({ ...initialPatch, noise: { ...initialPatch.noise, gain: 0.3 } }), false);
    const comparisonPatch = { ...initialPatch, layers: initialPatch.layers.map((layer, index) =>
      index === 0 ? { ...layer, pitch: 5, loaded: true, sampleKey: 'left', sampleRightKey: 'right' } : layer) };
    const baseline = serializePatchState(comparisonPatch);
    assert.equal(hasPatchChanges(comparisonPatch, baseline), false);
    assert.equal(hasPatchChanges({ ...comparisonPatch, layers: comparisonPatch.layers.map((layer, index) =>
      index === 0 ? { ...layer, pitch: 5.1 } : layer) }, baseline), true);
    assert.equal(hasPatchChanges({ ...comparisonPatch, layers: comparisonPatch.layers.map((layer, index) =>
      index === 0 ? { ...layer, sampleRightKey: 'other' } : layer) }, baseline), true);
    assert.equal(hasPatchChanges({ ...comparisonPatch, master: { ...comparisonPatch.master,
      ceiling: Math.fround(comparisonPatch.master.ceiling) } }, baseline), false);
    assert.equal(hasPatchChanges(comparisonPatch, null), true);
    const app = renderToStaticMarkup(React.createElement(App));
    assert.match(app, /data-theme="golden-nugget"/);
    assert.match(app, /data-border-trace="normal" data-border-trace-speed="normal"/);
    assert.match(app, /Hover or focus a knob or control/);
    assert.doesNotMatch(app, /role="tooltip"/);
    assert.match(app, /aria-label="Trigger hit \(Space or MIDI\)" aria-keyshortcuts="Space"/);
    assert.match(app, /class="topbar-hit-label">HIT<\/span><span class="topbar-hit-hint">SPACE \/ MIDI<\/span>/);
    let hits = 0;
    let closes = 0;
    const hitButton = HitButton({ onHit: () => { hits += 1; } });
    hitButton.props.onMouseDown({ button: 0 });
    hitButton.props.onClick({ detail: 1 });
    hitButton.props.onClick({ detail: 0 });
    assert.equal(hits, 2);
    const dialog = ModuleSettingsDialog({
      title: 'SATURATION', onHit: () => { hits += 1; }, onClose: () => { closes += 1; }, onReset: () => {}
    }).props.children;
    const dialogMarkup = renderToStaticMarkup(dialog);
    assert.match(dialogMarkup, /aria-label="Trigger hit \(Space or MIDI\)"[^>]*autofocus/);
    assert.doesNotMatch(dialogMarkup, /RESET KNOBS/);
    const controls = (props) => renderToStaticMarkup(React.createElement(ModuleControls, {
      name: 'saturation', muted: true, onMute: () => {}, onReset: () => {}, ...props
    }));
    assert.match(controls(), /aria-label="Mute saturation" aria-pressed="true"/);
    assert.match(controls(), /aria-label="Reset saturation knobs to defaults"/);
    const noiseControls = controls({ name: 'noise synth', noise: createDefaultState().noise, onNoiseChange: () => {} });
    assert.match(noiseControls, /aria-label="Reset noise gain envelope"/);
    assert.match(noiseControls, /role="slider" tabindex="0" aria-label="NOISE play delay" aria-valuemin="0" aria-valuemax="1000"/);
    assert.match(noiseControls, /aria-label="NOISE play delay exact value in ms"/);
    assert.doesNotMatch(controls(), /aria-label="NOISE play delay"/);
    let prevented = false;
    const closeButton = AuditionCloseButton({ onHit: () => { hits += 1; }, onClose: () => { closes += 1; } });
    closeButton.props.onKeyDown({
      code: 'Space', preventDefault: () => { prevented = true; }
    });
    assert.equal(prevented, true);
    assert.equal(hits, 3);
    assert.equal(closes, 0);
    dialog.props.onKeyDown({
      target: { closest: () => dialog }, currentTarget: dialog, key: 'Escape', preventDefault: () => {}
    });
    assert.equal(closes, 1);
    const appearanceWindow = globalThis.window;
    try {
      globalThis.window = {
        localStorage: {
          getItem: (key) => ({
            'layerforge-ui-theme': 'cyan-volt',
            'layerforge-border-trace-level': 'subtle',
            'layerforge-border-trace-speed': 'fast'
          })[key]
        }
      };
      const restoredAppearance = renderToStaticMarkup(React.createElement(App));
      assert.match(restoredAppearance, /data-theme="cyan-volt"/);
      assert.match(restoredAppearance, /data-border-trace="subtle" data-border-trace-speed="fast"/);
      globalThis.window.localStorage.getItem = () => 'invalid';
      const invalidAppearance = renderToStaticMarkup(React.createElement(App));
      assert.match(invalidAppearance, /data-theme="golden-nugget"/);
      assert.match(invalidAppearance, /data-border-trace="normal" data-border-trace-speed="normal"/);
    } finally {
      globalThis.window = appearanceWindow;
    }
    assert.doesNotMatch(app, /made with love - ayatko/);
    assert.doesNotMatch(app, /MULTI-LAYER TRANSIENT &amp; CLIP ENGINE/);
    const order = ['noise', 'saturation', 'glue'];
    assert.deepEqual(reorderBusModules(order, 'noise', 'glue'), ['saturation', 'glue', 'noise']);
    assert.deepEqual(reorderBusModules(order, 'glue', 'noise'), ['glue', 'noise', 'saturation']);
    assert.equal(reorderBusModules(order, 'noise', 'noise'), order);
    assert.equal(reorderBusModules(order, 'noise', undefined), order);
    assert.deepEqual(order, ['noise', 'saturation', 'glue']);
    assert.match(app, /aria-label="Reorder Noise synth, position 1 of 5"/);
    assert.match(app, /aria-label="Reorder Ring modulation, position 2 of 5"/);
    assert.match(app, /aria-label="Reorder Convolution, position 3 of 5"/);
    assert.match(app, /aria-label="Reorder Saturation, position 4 of 5"/);
    assert.match(app, /aria-label="Reorder Glue compressor, position 5 of 5"/);
    assert.doesNotMatch(app, /aria-label="Move (?:noise|saturation|glue) (?:earlier|later)/);
    assert.match(app, /aria-label="Enable noise synth" aria-pressed="false"/);
    assert.doesNotMatch(app, /aria-label="Open noise waveform editor"/);
    assert.match(app, /aria-label="Enable master saturation" aria-pressed="false"[^>]*>OFF · ENABLE/);
    assert.match(app, /aria-label="Enable convolution" aria-pressed="false"[^>]*>OFF · ENABLE/);
    assert.match(app, /aria-label="Enable glue compressor" aria-pressed="false"[^>]*>OFF · ENABLE/);
    assert.match(app, /aria-label="Enable ring modulation" aria-pressed="false"[^>]*>OFF · ENABLE/);
    assert.match(app, /aria-label="Noise synth settings" aria-haspopup="dialog"[^>]*disabled/);
    assert.match(app, /aria-label="Saturation settings" aria-haspopup="dialog"[^>]*disabled/);
    assert.match(app, /aria-label="Convolution settings" aria-haspopup="dialog"[^>]*disabled/);
    assert.match(app, /aria-label="Glue compressor settings" aria-haspopup="dialog"[^>]*disabled/);
    assert.match(app, /aria-label="Ring modulation settings" aria-haspopup="dialog"[^>]*disabled/);
    assert.match(app, /class="module-title-trigger" aria-label="Noise synth settings"/);
    assert.match(app, /class="module-title-trigger" aria-label="Saturation settings"/);
    assert.doesNotMatch(app, /module-settings-button/);
    assert.match(app, /aria-label="Expand OUTPUT SCOPE waveform view"/);
    assert.doesNotMatch(app, /aria-label="(?:SAT DRIVE|THRESH):/);
    const { GainReductionMeter } = await server.ssrLoadModule('/src/components/EffectMeters.jsx');
    const reduction = (value) => renderToStaticMarkup(React.createElement(GainReductionMeter, { reduction: value }));
    assert.match(reduction(0), /height:0%/);
    assert.match(reduction(18), /aria-valuenow="18"/);
    assert.match(reduction(18), /height:50%/);
    assert.match(reduction(40), /aria-valuenow="36"/);
    assert.match(reduction(40), /−40\.0 dB/);
    assert.match(reduction(40), /height:100%/);
    for (let index = 1; index <= 3; index += 1) {
      assert.match(app, new RegExp(`aria-label="Minimize channel ${index}" aria-expanded="true"`));
      assert.match(app, new RegExp(`aria-label="Show all additional controls for channel ${index}" aria-expanded="false"`));
      assert.match(app, new RegExp(`aria-label="Reset knobs for channel ${index}"`));
      assert.match(app, new RegExp(`aria-label="Load sample for CH 0${index}"`));
      assert.match(app, new RegExp(`aria-label="CH 0${index} clip gain"`));
      assert.match(app, new RegExp(`aria-label="CH 0${index} clip gain exact value in dB"`));
      assert.match(app, new RegExp(`role="slider" tabindex="0" aria-label="CH 0${index} play delay"`));
      assert.match(app, new RegExp(`aria-label="CH 0${index} play delay exact value in ms"`));
    }
    assert.doesNotMatch(app, /channel-extra-controls/);
    const { ChannelStrip } = await server.ssrLoadModule('/src/components/ChannelStrip.jsx');
    const { LayerForgeBridge } = await server.ssrLoadModule('/src/audio/bridge.js');
    const copyButton = (props) => renderToStaticMarkup(React.createElement(WavCopyButton, props));
    assert.match(copyButton({ ready: false }), /disabled[^>]*>COPY WAV/);
    assert.match(copyButton({ ready: true, status: 'COPIED' }), /aria-live="polite"[^>]*>COPIED/);
    assert.match(copyButton({ ready: true, status: 'COPY FAILED' }), />COPY FAILED/);
    assert.doesNotMatch(copyButton({ ready: true }), /draggable|DRAG/);
    assert.match(copyButton({ ready: true, exporting: true }), /disabled/);

    const { PresetBar } = await server.ssrLoadModule('/src/components/PresetBar.jsx');
    const presetProps = {
      presets: [
        { filename: 'kick.lfpreset', name: 'Kick', available: true },
        { filename: 'missing.lfpreset', name: 'Missing', available: false, error: 'Cannot read preset' }
      ],
      ready: true,
      busy: false
    };
    const presetBar = (props) => renderToStaticMarkup(React.createElement(PresetBar, { ...presetProps, ...props }));
    assert.match(presetBar({ selected: 'kick.lfpreset' }), /value="kick\.lfpreset" selected/);
    assert.match(presetBar({ selected: 'kick.lfpreset' }), />LOADED<\/output>/);
    assert.match(presetBar({ selected: 'missing.lfpreset' }), />MISSING<\/output>/);
    assert.match(presetBar({ selected: 'absent.lfpreset' }), />INIT<\/output>/);
    assert.match(presetBar({ selected: 'kick.lfpreset', busy: true }), /disabled[^>]*>[\s\n]*SAVE/);
    assert.match(presetBar({ selected: '', isInitialPatch: false, libraryStatus: 'NO SAVED PRESETS' }),
      /value="__current_patch__" disabled="" selected="">-- CURRENT PATCH --/);
    assert.match(presetBar({ selected: '', isInitialPatch: false, libraryStatus: 'NO SAVED PRESETS' }),
      /value="">-- INIT PATCH --/);
    const presetActions = [];
    const presetSelect = PresetBar({
      ...presetProps,
      selected: 'kick.lfpreset',
      onInitialize: () => presetActions.push('initialize'),
      onSelect: (filename) => presetActions.push(filename)
    }).props.children[0].props.children[0].props.children[1];
    presetSelect.props.onChange({ target: { value: '' } });
    presetSelect.props.onChange({ target: { value: 'kick.lfpreset' } });
    assert.deepEqual(presetActions, ['initialize', 'kick.lfpreset']);

    const originalWindow = globalThis.window;
    try {
      const messages = [];
      globalThis.window = {
        __JUCE__: {},
        _postMessageToPluginBackend: (type, payload) => messages.push({ type, payload }),
        setTimeout,
        clearTimeout
      };
      const echoedBridge = new LayerForgeBridge();
      const echoedChanges = [];
      echoedBridge.pluginStateLoaded = true;
      echoedBridge.resumeParameterUpdates();
      echoedBridge.onParameterChange = (id, value) => echoedChanges.push([id, value]);
      echoedBridge.setHostParameter('l0_pitch', 2);
      const firstSequence = messages.shift().payload.sequence;
      echoedBridge.setHostParameter('l0_pitch', 5);
      const secondSequence = messages.shift().payload.sequence;
      assert.ok(secondSequence > firstSequence);
      echoedBridge.nativeParametersListener({ l0_pitch: { value: 2, sequence: firstSequence, revision: 0 } });
      assert.deepEqual(echoedChanges, []);
      echoedBridge.nativeParametersListener({ l0_pitch: { value: 5, sequence: secondSequence, revision: 0 } });
      assert.deepEqual(echoedChanges, [['l0_pitch', 5]]);
      echoedBridge.setHostParameter('l0_pitch', 0);
      const undoSequence = messages.shift().payload.sequence;
      echoedBridge.nativeParametersListener({ l0_pitch: { value: 5, sequence: secondSequence, revision: 0 } });
      assert.deepEqual(echoedChanges, [['l0_pitch', 5]]);
      echoedBridge.nativeParametersListener({ l0_pitch: { value: 8, sequence: undoSequence, revision: 0 } });
      assert.deepEqual(echoedChanges, [['l0_pitch', 5], ['l0_pitch', 8]]);
      echoedBridge.nativeStateRestoredListener({ revision: 1 });
      echoedBridge.nativeParametersListener({ l0_pitch: { value: 3, sequence: undoSequence, revision: 0 } });
      echoedBridge.stateRevision = 1;
      echoedBridge.resumeParameterUpdates();
      assert.deepEqual(echoedChanges, [['l0_pitch', 5], ['l0_pitch', 8]]);
      echoedBridge.nativeParametersListener({ l0_pitch: { value: 4, sequence: firstSequence, revision: 1 } });
      assert.deepEqual(echoedChanges.at(-1), ['l0_pitch', 4]);

      const knobBridge = new LayerForgeBridge();
      knobBridge.pluginStateLoaded = true;
      knobBridge.resumeParameterUpdates();
      const knobHistory = createPatchHistory();
      const gesture = Symbol('knob drag');
      let knobState = createDefaultState();
      const setPitch = (pitch) => ({
        ...knobState,
        layers: knobState.layers.map((layer, index) => index ? layer : { ...layer, pitch })
      });
      knobBridge.onParameterChange = (id, value) => {
        if (id === 'l0_pitch' && knobState.layers[0].pitch !== value) {
          knobHistory.invalidate(['layers', 0, 'pitch']);
          knobState = setPitch(value);
        }
      };
      const editPitch = (pitch) => {
        const next = setPitch(pitch);
        knobBridge.setHostParameter('l0_pitch', pitch);
        knobHistory.record(knobState, next, gesture);
        knobState = next;
        return messages.shift().payload.sequence;
      };
      const oldDrag = editPitch(2);
      editPitch(5);
      knobBridge.nativeParametersListener({ l0_pitch: { value: 2, sequence: oldDrag, revision: 0 } });
      knobState = knobHistory.undo(knobState);
      assert.equal(knobState.layers[0].pitch, 0);
      knobBridge.setHostParameter('l0_pitch', 0);
      const undoAck = messages.shift().payload.sequence;
      knobBridge.nativeParametersListener({ l0_pitch: { value: 5, sequence: oldDrag, revision: 0 } });
      knobState = knobHistory.redo(knobState);
      assert.equal(knobState.layers[0].pitch, 5);
      knobBridge.setHostParameter('l0_pitch', 5);
      const redoAck = messages.shift().payload.sequence;
      knobBridge.nativeParametersListener({ l0_pitch: { value: 0, sequence: undoAck, revision: 0 } });
      knobBridge.nativeParametersListener({ l0_pitch: { value: 8, sequence: redoAck, revision: 0 } });
      assert.equal(knobState.layers[0].pitch, 8);
      assert.equal(knobHistory.undo(knobState), null);
      let prevented = false;
      BrandSignature({ isNativePlugin: true }).props.onClick({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
      assert.deepEqual(messages.shift(), { type: 'openInstagram', payload: {} });
      prevented = false;
      BrandSignature({ isNativePlugin: false }).props.onClick({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, false);
      const clipboardBridge = new LayerForgeBridge();
      const copy = clipboardBridge.copyNativeWavToClipboard('prepared-wav');
      assert.equal(messages[0].type, 'wavClipboard');
      assert.equal(messages[0].payload.key, 'prepared-wav');
      clipboardBridge.nativeWavClipboardListener({ requestId: messages[0].payload.requestId, success: true });
      await copy;
      const failedCopy = clipboardBridge.copyNativeWavToClipboard('prepared-wav');
      clipboardBridge.nativeWavClipboardListener({
        requestId: messages[1].payload.requestId, success: false, error: 'Clipboard unavailable'
      });
      await assert.rejects(failedCopy, /Clipboard unavailable/);
      assert.equal(clipboardBridge.pendingClipboardWrites.size, 0);
    } finally {
      globalThis.window = originalWindow;
    }
    const automationBridge = new LayerForgeBridge();
    const parameterChanges = [];
    let restoredRevision;
    automationBridge.onParameterChange = (id, value) => parameterChanges.push([id, value]);
    automationBridge.onStateRestored = (revision) => { restoredRevision = revision; };
    automationBridge.nativeParametersListener({ l0_pitch: 2 });
    automationBridge.nativeParametersListener({ l0_pitch: 5, master_outputDb: -6 });
    assert.deepEqual(parameterChanges, []);
    automationBridge.resumeParameterUpdates();
    assert.deepEqual(parameterChanges, [['l0_pitch', 5], ['master_outputDb', -6]]);
    automationBridge.nativeStateRestoredListener({ revision: 3 });
    automationBridge.nativeParametersListener({ l0_pitch: 8 });
    assert.equal(restoredRevision, 3);
    assert.equal(parameterChanges.length, 2);
    automationBridge.resumeParameterUpdates();
    assert.deepEqual(parameterChanges[2], ['l0_pitch', 8]);
    const bridge = new LayerForgeBridge();
    const nativeFile = new Promise((resolve, reject) => {
      bridge.pendingSampleFile = { requestId: 'sample-1', resolve, reject };
    });
    bridge.nativeSampleFileListener({ requestId: 'sample-1', action: 'begin', size: 3, name: 'kick.wav', path: '/samples/kick.wav' });
    bridge.nativeSampleFileListener({ requestId: 'sample-1', action: 'chunk', offset: 0, bytes: [1, 2] });
    bridge.nativeSampleFileListener({ requestId: 'sample-1', action: 'chunk', offset: 2, bytes: [3] });
    bridge.nativeSampleFileListener({ requestId: 'sample-1', action: 'end' });
    const chosenFile = await nativeFile;
    assert.equal(chosenFile.path, '/samples/kick.wav');
    assert.deepEqual([...new Uint8Array(await chosenFile.arrayBuffer())], [1, 2, 3]);
    const incompleteFile = new Promise((resolve, reject) => {
      bridge.pendingSampleFile = { requestId: 'sample-2', resolve, reject };
    });
    bridge.nativeSampleFileListener({ requestId: 'sample-2', action: 'begin', size: 3, name: 'kick.wav', path: '/samples/kick.wav' });
    bridge.nativeSampleFileListener({ requestId: 'sample-2', action: 'chunk', offset: 1, bytes: [1] });
    await assert.rejects(incompleteFile, /invalid or incomplete/);
    const locatedFile = new Promise((resolve, reject) => {
      bridge.pendingSampleFile = { requestId: 'locate-1', resolve, reject, locationOnly: true };
    });
    bridge.nativeSampleFileListener({ requestId: 'locate-1', action: 'location', name: 'kick.wav', path: '/samples/kick.wav' });
    assert.deepEqual(await locatedFile, { name: 'kick.wav', path: '/samples/kick.wav' });
    const invalidLocation = new Promise((resolve, reject) => {
      bridge.pendingSampleFile = { requestId: 'locate-2', resolve, reject, locationOnly: true };
    });
    bridge.nativeSampleFileListener({ requestId: 'locate-2', action: 'location', name: 'kick.wav', path: '' });
    await assert.rejects(invalidLocation, /Invalid sample location/);
    const leftSample = Float32Array.of(0, 0.5, 0);
    const rightSample = Float32Array.of(0, -0.75, 0);
    bridge.audioCtx = {
      decodeAudioData: async () => ({
        numberOfChannels: 2, sampleRate: SAMPLE_RATE, length: 3, duration: 3 / SAMPLE_RATE,
        getChannelData: (index) => index ? rightSample : leftSample
      })
    };
    let registered;
    bridge.core = { updateVirtualFileSystem: async (resources) => { registered = resources; } };
    const loaded = await bridge.loadSampleFile(0, { name: 'stereo.wav', arrayBuffer: async () => new ArrayBuffer(0) });
    assert.deepEqual(registered[loaded.sampleKey], leftSample);
    assert.deepEqual(registered[loaded.sampleRightKey], rightSample);
    assert.equal(bridge.vfsBuffers[loaded.sampleRightKey], rightSample);
    const audio = await bridge.decodeSampleFile({ arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(matchesReferencedSample(audio, loaded, bridge.vfsBuffers), true);
    assert.equal(matchesReferencedSample(audio, { ...loaded, sampleRate: 48000 }, bridge.vfsBuffers), false);
    assert.equal(matchesReferencedSample(audio, loaded, {
      [loaded.sampleKey]: leftSample, [loaded.sampleRightKey]: Float32Array.of(0, 0.75, 0)
    }), false);
    assert.equal(matchesReferencedSample(audio, loaded, { [loaded.sampleKey]: leftSample }), false);
    const monoAudio = { ...audio, numberOfChannels: 1 };
    const monoLayer = { ...loaded, sampleRightKey: null };
    assert.equal(matchesReferencedSample(monoAudio, monoLayer, bridge.vfsBuffers), true);
    assert.equal(matchesReferencedSample(audio, monoLayer, bridge.vfsBuffers), false);
    const savedStereo = createDefaultState();
    Object.assign(savedStereo.layers[0], loaded, { loaded: true });
    const restoredStereo = restorePatchState(serializePatchState(savedStereo), bridge.vfsBuffers);
    assert.equal(restoredStereo.layers[0].sampleRightKey, loaded.sampleRightKey);
    assert.throws(() => restorePatchState(serializePatchState(savedStereo), {
      [loaded.sampleKey]: leftSample
    }), /Stereo sample data.*missing/);
    const paddedLeft = new Float32Array(1000).fill(0.00001);
    const paddedRight = new Float32Array(1000).fill(-0.00001);
    paddedLeft[99] = 0.5;
    paddedRight[199] = 0.25;
    bridge.audioCtx.decodeAudioData = async () => ({
      numberOfChannels: 2, sampleRate: 1000, length: 1000, duration: 1,
      getChannelData: (index) => index ? paddedRight : paddedLeft
    });
    const padded = await bridge.loadSampleFile(0, { name: 'padded.wav', arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(padded.trimStart, 0.094);
    assert.equal(padded.trimEnd, 0.22);
    assert.equal(bridge.vfsBuffers[padded.sampleKey][0], Math.fround(0.00001));
    assert.equal(bridge.vfsBuffers[padded.sampleRightKey][999], Math.fround(-0.00001));
    const referenceWindow = globalThis.window;
    try {
      globalThis.window = { __JUCE__: {}, _postMessageToPluginBackend: () => {}, confirm: () => true };
      const referenceBridge = new LayerForgeBridge();
      const hash = 'a'.repeat(64);
      const referencePatch = createDefaultState();
      Object.assign(referencePatch.layers[0], {
        loaded: true, sampleKey: 'old-left', sampleRightKey: 'old-right'
      });
      const manifest = { version: 2, patch: referencePatch, samples: [{
        key: 'old-left', sourceLocation: '/old/kick.wav', sourceName: 'kick.wav',
        sha256: hash, sampleRate: 44100, sampleCount: 3
      }] };
      const requests = [];
      referenceBridge.requestNativeState = async (type, payload) => {
        requests.push({ type, payload });
        return type === 'presetLoad' ? { referenceManifest: manifest } : { applied: true };
      };
      referenceBridge.readNativeSample = async () => { throw new Error('File moved'); };
      referenceBridge.chooseNativeSample = async () => ({ path: '/new/kick.wav', sha256: hash });
      referenceBridge.loadSampleFile = async () => ({
        sampleRate: 44100, sampleCount: 3, sampleKey: 'new-left', sampleRightKey: 'new-right'
      });
      assert.deepEqual(await referenceBridge.loadNativePreset('kick.lfpreset', undefined, async () => true), { applied: true });
      assert.deepEqual(requests[1].payload.samples, [{
        layer: 0, path: '/new/kick.wav', sampleKey: 'new-left', sampleRightKey: 'new-right'
      }]);
      requests.length = 0;
      referenceBridge.chooseNativeSample = async () => ({ path: '/wrong.wav', sha256: 'b'.repeat(64) });
      await assert.rejects(referenceBridge.loadNativePreset('kick.lfpreset', undefined, async () => true), /does not match/);
      assert.equal(requests.length, 1);
      referenceBridge.chooseNativeSample = async () => null;
      await assert.rejects(referenceBridge.loadNativePreset('kick.lfpreset', undefined, async () => true), /canceled/);
      await assert.rejects(referenceBridge.loadNativePreset('kick.lfpreset', undefined, async () => false), /canceled/);
      requests.length = 0;
      referenceBridge.readNativeSample = async () => ({ path: '/old/kick.wav', sha256: hash });
      await assert.rejects(referenceBridge.loadNativePreset('kick.lfpreset', () => false), /patch changed/);
      assert.equal(requests.length, 1);
      referenceBridge.loadSampleFile = async () => ({
        sampleRate: 44100, sampleCount: 3, sampleKey: 'new-left', sampleRightKey: null
      });
      await assert.rejects(referenceBridge.loadNativePreset('kick.lfpreset'), /decoded differently/);
      assert.equal(requests.length, 2);
    } finally {
      globalThis.window = referenceWindow;
    }
    const changedLayer = { ...createDefaultState().layers[0], hp: 100, phaseOffset: 0.01 };
    const changedChannel = renderToStaticMarkup(React.createElement(ChannelStrip, {
      index: 0, layer: changedLayer, sampleBuffers: {}, sampleRates: {}, onChange: () => {}
    }));
    assert.match(changedChannel, /aria-label="HPF: 100Hz/);
    assert.match(changedChannel, /aria-label="PHASE: 0\.0100/);
    assert.doesNotMatch(changedChannel, /aria-label="PLAY DLY:/);
    assert.match(changedChannel, /class="knob-grid channel-knob-grid" id="channel-knobs-0"/);
    assert.match(changedChannel, /aria-controls="channel-knobs-0"/);
    assert.doesNotMatch(changedChannel, /class="knob-grid channel-extra-controls"/);
    assert.doesNotMatch(changedChannel, /channel-extra-controls-label/);
    assert.match(changedChannel, /strip-channel is-empty/);
    assert.match(changedChannel, /class="channel-load-indicator" role="img" aria-label="Channel 1 empty"/);
    const loadedPatch = createLoadedPatch();
    const renderChannel = (layer, processedWaveform, extra = {}) => renderToStaticMarkup(React.createElement(ChannelStrip, {
      index: 0, layer, allLayers: loadedPatch.layers,
      sampleBuffers: { kick: sample }, sampleRates: { kick: SAMPLE_RATE },
      processedWaveform, processedDuration: 1,
      onChange: () => {}, onSwapSamples: () => {}, ...extra
    }));
    const channelWithPreview = renderChannel(loadedPatch.layers[0], { min: [-0.5], max: [0.5] });
    assert.match(channelWithPreview, /class="channel-load-indicator" role="img" aria-label="Channel 1 sample loaded"/);
    const mutedChannel = renderChannel({ ...loadedPatch.layers[0], mute: true }, null);
    assert.match(mutedChannel, /strip-channel\s+is-muted/);
    assert.match(mutedChannel, /aria-label="Channel 1 sample loaded"/);
    const mutedEmptyChannel = renderChannel({ ...changedLayer, mute: true }, null);
    assert.match(mutedEmptyChannel, /strip-channel is-empty is-muted/);
    assert.match(mutedEmptyChannel, /aria-label="Channel 1 empty"/);
    const filteredChannel = renderChannel({ ...loadedPatch.layers[0], hp: 1800, gain: 0.1 }, { min: [-0.1], max: [0.1] });
    const waveformPath = (markup) => markup.match(/<path d="([^"]*)" class="waveform-amplitude-fill"/)?.[1];
    assert.ok(waveformPath(channelWithPreview));
    assert.notEqual(waveformPath(filteredChannel), waveformPath(channelWithPreview));
    const channelDuringTrace = renderChannel(loadedPatch.layers[0], { min: [-0.5], max: [0.5] }, {
      playbackId: 1, traceEnabled: true,
      liveTrace: { min: [-0.9], max: [0.9], capturedSec: 1, durationSec: 1 }
    });
    assert.equal(waveformPath(channelDuringTrace), waveformPath(channelWithPreview));
    assert.doesNotMatch(channelDuringTrace, />LIVE OUTPUT</);
    const { NoiseWaveform } = await server.ssrLoadModule('/src/components/NoiseWaveform.jsx');
    const noiseProps = {
      noise: createDefaultState().noise, waveform: { min: [-0.5], max: [0.5] },
      durationSec: 1, previewStatus: 'DSP RENDER', onChange: () => {},
      editorResolution: 2048, onEditorResolutionChange: () => {}
    };
    const noisePreview = renderToStaticMarkup(React.createElement(NoiseWaveform, noiseProps));
    const noiseDuringTrace = renderToStaticMarkup(React.createElement(NoiseWaveform, {
      ...noiseProps, playbackId: 1, traceEnabled: true,
      liveTrace: { min: [-0.9], max: [0.9], capturedSec: 1, durationSec: 1 }
    }));
    assert.ok(waveformPath(noisePreview));
    assert.match(noisePreview, /aria-label="NOISE waveform detail"/);
    assert.match(noisePreview, /aria-label="NOISE envelope point 1"/);
    assert.doesNotMatch(noisePreview, /aria-label="Open noise waveform editor"/);
    assert.equal(waveformPath(noiseDuringTrace), waveformPath(noisePreview));
    const delayedNoise = renderToStaticMarkup(React.createElement(NoiseWaveform, {
      ...noiseProps, noise: { ...noiseProps.noise, delayMs: 250 }, playbackId: 1
    }));
    assert.match(delayedNoise, /animation-delay:0\.25s/);
    assert.match(channelWithPreview, /class="waveform-amplitude-fill"/);
    assert.doesNotMatch(channelWithPreview, /channel-output-preview|DSP OUT|DSP · SRC/);
    assert.match(channelWithPreview, /aria-label="Auto-align phase for channel 1"/);
    assert.match(channelWithPreview, /<circle cx="8" cy="8" r="5"><\/circle><path d="M3 13 13 3">/);
    assert.match(channelWithPreview, /role="group" aria-label="Channel 1 editing and controls"[\s\S]*aria-label="Auto-align phase for channel 1"[\s\S]*aria-label="Open CH 01 waveform editor"[\s\S]*aria-label="CH 01 reset gain envelope to default"[\s\S]*aria-label="Show all additional controls for channel 1"[\s\S]*aria-label="Reset knobs for channel 1"/);
    assert.doesNotMatch(channelWithPreview, /aria-label="Move sample from channel 1 to channel 2"/);
    assert.match(channelWithPreview, /aria-label="CH 01 sample start trim"/);
    assert.match(channelWithPreview, /aria-label="CH 01 envelope point 1"/);
    assert.doesNotMatch(channelWithPreview, /aria-label="Load sample for CH 01"/);
    assert.match(channelWithPreview, /class="waveform-sample-name sample-menu-trigger"/);
    assert.match(channelWithPreview, /aria-label="CH 01 sample options:/);
    assert.doesNotMatch(channelWithPreview, /class="dropzone/);
    assert.doesNotMatch(channelWithPreview, /class="waveform-duration"/);
    assert.doesNotMatch(channelWithPreview, /aria-label="Show processed waveform for channel 1"/);
    assert.doesNotMatch(channelWithPreview, />ALIGN PHASE</);
    assert.doesNotMatch(app, /HIDE EMPTY \/ MUTED/);
    assert.match(app, /aria-pressed="true" aria-label="TRACE ARMED"/);
    assert.match(app, /class="waveform-trace-label">TRACE<\/span><span class="waveform-trace-status">ARMED<\/span>/);
    assert.match(app, /aria-label="Post-master output peak"[^>]*aria-valuemin="-60"[^>]*aria-valuemax="0"/);
    assert.doesNotMatch(app, /aria-label="Output meter scale"/);
    assert.match(app, /RENDERING/);
    assert.doesNotMatch(app, /LIVE ESTIMATE/);
    const about = renderToStaticMarkup(React.createElement(AboutDialog, { onClose: () => {} }));
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(about.includes(`Version ${version}`));
    assert.match(about, /href="https:\/\/github\.com\/ultimumdesign\/LayerForge"/);
    assert.match(about, /href="https:\/\/www\.instagram\.com\/ayatkomusic\/"[^>]*>made with love - ayatko<\/a>.*CLOSE<\/button>/);
    assert.match(about, /role="dialog"/);
    const { HelpEnabledContext, HelpTip } = await server.ssrLoadModule('/src/components/HelpTip.jsx');
    const help = React.createElement(HelpTip, { text: 'Helpful text' }, 'CONTROL');
    assert.match(renderToStaticMarkup(help), /role="tooltip"[^>]*>Helpful text/);
    assert.doesNotMatch(renderToStaticMarkup(help), /<button/);
    const disabledHelp = renderToStaticMarkup(React.createElement(HelpEnabledContext.Provider, { value: false }, help));
    assert.equal(disabledHelp, 'CONTROL');
    const { RotaryKnob } = await server.ssrLoadModule('/src/components/RotaryKnob.jsx');
    const knob = renderToStaticMarkup(React.createElement(RotaryKnob, {
      label: 'PITCH', value: 0, min: -12, max: 12, description: 'Changes sample pitch.', onChange: () => {}
    }));
    assert.match(knob, /data-dsp-help="Changes sample pitch\."/);
    assert.match(knob, /role="tooltip"[^>]*>PITCH: Drag vertically to adjust; Shift-drag for fine control\. Click the value to type; double-click the knob to reset\./);

    const previousWindow = globalThis.window;
    const previousObserver = globalThis.ResizeObserver;
    let scheduled;
    let resized;
    let observed;
    let disconnected = false;
    let height = 571.2;
    const editorElement = {
      style: { zoom: '', setProperty: () => {}, removeProperty: () => {} },
      get offsetHeight() { return height; }
    };
    const reported = [];
    try {
      globalThis.window = {
        innerWidth: 1120,
        setTimeout: (callback) => { scheduled = callback; return 1; },
        clearTimeout: () => { scheduled = null; },
        addEventListener: (_, callback) => { resized = callback; },
        removeEventListener: () => { resized = null; }
      };
      globalThis.ResizeObserver = class {
        constructor(callback) { observed = callback; }
        observe() {}
        disconnect() { disconnected = true; }
      };
      const stop = observeNativeEditorHeight(editorElement, (value) => reported.push(value));
      scheduled();
      height = 715.2;
      observed();
      scheduled();
      observed();
      scheduled();
      globalThis.window.innerWidth = 896;
      resized();
      scheduled();
      assert.equal(editorElement.style.zoom, '0.8');
      assert.deepEqual(reported, [572, 716, 573]);
      globalThis.window.innerWidth = 1400;
      resized();
      scheduled();
      assert.equal(editorElement.style.zoom, '1');
      assert.equal(reported.at(-1), 716);
      stop();
      assert.equal(editorElement.style.zoom, '');
      assert.equal(disconnected, true);
      assert.equal(resized, null);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousObserver === undefined) delete globalThis.ResizeObserver;
      else globalThis.ResizeObserver = previousObserver;
    }

    const { WaveformViewer, getWaveformViewCoordinates } = await server.ssrLoadModule('/src/components/WaveformViewer.jsx');
    const oldDOMPoint = globalThis.DOMPoint;
    try {
      globalThis.DOMPoint = class {
        constructor(x, y) { this.x = x; this.y = y; }
        matrixTransform(matrix) {
          return { x: this.x * matrix.a + matrix.e, y: this.y * matrix.d + matrix.f };
        }
      };
      const svg = { getScreenCTM: () => ({
        a: 0.5, b: 0, c: 0, d: 0.5,
        inverse: () => ({ a: 2, d: 2, e: -40, f: -60 })
      }) };
      assert.deepEqual(getWaveformViewCoordinates(svg, { clientX: 70, clientY: 80 }), { x: 100, y: 100 });
      assert.equal(getWaveformViewCoordinates({ getScreenCTM: () => null }, { clientX: 0, clientY: 0 }), null);
    } finally {
      if (oldDOMPoint === undefined) delete globalThis.DOMPoint;
      else globalThis.DOMPoint = oldDOMPoint;
    }
    const props = {
      title: 'LAYER SUM', compact: true, previewStatus: 'DSP RENDER', durationOverride: 1,
      peaksOverride: [0.25], fitAmplitude: true, traceEnabled: true,
      onFitAmplitudeChange: () => {}, onTraceEnabledChange: () => {}
    };
    const trace = { min: [-0.1], max: [0.1], capturedSec: 0.5, status: 'CAPTURING' };
    const render = (overrides) => renderToStaticMarkup(React.createElement(WaveformViewer, { ...props, ...overrides }));
    const live = render({ liveTrace: trace });
    assert.match(live, /class="waveform-live-trace"/);
    assert.match(live, /aria-label="TRACE CAPTURING"/);
    const lastHit = render({ liveTrace: { ...trace, status: 'LAST HIT', limited: true } });
    assert.match(lastHit, /aria-label="TRACE LAST HIT \(4S\)"/);
    assert.match(lastHit, /class="waveform-trace-status">LAST HIT \(4S\)<\/span>/);
    assert.match(render({ liveTrace: { status: 'GAP' } }), /aria-label="TRACE GAP - RETRIGGER"/);
    assert.match(render({ traceEnabled: false }), /aria-label="TRACE OFF"/);
    assert.doesNotMatch(live, /aria-label="LAYER SUM waveform horizontal scroll"/);
    assert.doesNotMatch(live, /waveform-output-fill/);
    assert.match(live, /LAYER SUM live output waveform/);
    assert.doesNotMatch(live, />LIVE OUTPUT</);
    assert.match(live, /FIT x10\.0/);
    const styles = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
    const traceStyle = styles.match(/\.waveform-live-trace\s*\{([^}]*)\}/)?.[1];
    assert.ok(traceStyle);
    assert.match(traceStyle, /fill:\s*var\(--trace-accent\)/);
    assert.match(traceStyle, /stroke:\s*none/);
    assert.doesNotMatch(traceStyle, /(?:fill-)?opacity\s*:/);

    for (const overrides of [
      { liveTrace: null },
      { liveTrace: { status: 'GAP' } },
      { liveTrace: trace, traceEnabled: false }
    ]) {
      const preview = render(overrides);
      assert.match(preview, /waveform-output-fill/);
      assert.doesNotMatch(preview, /class="waveform-live-trace"/);
      assert.match(preview, /LAYER SUM processed output waveform/);
      assert.doesNotMatch(preview, />DSP RENDER</);
    }

    const zoomed = render({ zoom: 2 });
    assert.match(zoomed, /aria-label="LAYER SUM waveform horizontal scroll"/);
    assert.match(zoomed, /output time in milliseconds"[^>]*><span>OUT 0\.0 ms<\/span><span>250\.0 ms<\/span><span>500\.0 ms<\/span>/);
    const channel = renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE,
      trimStart: 0.25, trimEnd: 0.75, fitTrimmed: true, durationOverride: 0.25
    }));
    assert.match(channel, /source time in milliseconds"[^>]*><span>SRC 200\.0 ms<\/span><span>500\.0 ms<\/span><span>800\.0 ms<\/span>/);
    assert.doesNotMatch(channel, /aria-label="CH 01 waveform horizontal scroll"/);
    const renderTrim = (trimStart, trimEnd) => renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE,
      trimStart, trimEnd, fitTrimmed: true, onTrimChange: () => {}
    }));
    const endHandle = renderTrim(0, 0.1).match(/waveform-trim-handle-end[^]*?<line x1="([^"]+)"/);
    const startHandle = renderTrim(0.5, 1).match(/waveform-trim-handle-start[^]*?<line x1="([^"]+)"/);
    assert.ok(endHandle && Number(endHandle[1]) < 495);
    assert.ok(startHandle && Number(startHandle[1]) > 5);
    const zoomedChannel = renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE,
      fitTrimmed: true, zoom: 2
    }));
    assert.match(zoomedChannel, /aria-label="CH 01 waveform horizontal scroll"/);
    const playheadPositions = (markup) => {
      const match = markup.match(/--playhead-from:([^%]+)%;--playhead-to:([^%]+)%/);
      assert.ok(match);
      return match.slice(1).map(Number);
    };
    const playheadProps = {
      title: 'CH 01', samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE,
      trimStart: 0.25, trimEnd: 0.75, fitTrimmed: true, playbackId: 1
    };
    const [fittedStart, fittedEnd] = playheadPositions(renderToStaticMarkup(React.createElement(WaveformViewer, playheadProps)));
    assert.ok(Math.abs(fittedStart - (1 + 98 / 12)) < 1e-9);
    assert.ok(Math.abs(fittedEnd - (99 - 98 / 12)) < 1e-9);
    const [zoomedStart, zoomedEnd] = playheadPositions(renderToStaticMarkup(React.createElement(WaveformViewer, {
      ...playheadProps, zoom: 2
    })));
    assert.ok(Math.abs(zoomedStart - (1 - 98 / 3)) < 1e-9);
    assert.ok(Math.abs(zoomedEnd - (99 + 98 / 3)) < 1e-9);
    const [sumStart, sumEnd] = playheadPositions(renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'OUTPUT SCOPE', compact: true, zoom: 2, durationOverride: 1, playbackId: 1,
      playheads: [{ id: 1, delaySec: 0.25, endTimeSec: 0.75, durationSec: 0.5 }]
    })));
    assert.ok(Math.abs(sumStart - 51) < 1e-9);
    assert.ok(Math.abs(sumEnd - 149) < 1e-9);
    const channelOutput = renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', outputTime: true, durationOverride: 1, previewStatus: 'DSP RENDER',
      stereoWaveform: { leftMin: [-0.5], leftMax: [0.5], rightMin: [-0.5], rightMax: [0.5] }
    }));
    assert.match(channelOutput, /CH 01 output time in milliseconds/);
    assert.match(channelOutput, /CH 01 processed output waveform/);
    assert.doesNotMatch(channelOutput, /sample start trim|envelope point/);
    const channelLive = renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', outputTime: true, durationOverride: 1,
      traceEnabled: true, liveTrace: { min: [-0.2], max: [0.2], capturedSec: 0.5 }
    }));
    assert.match(channelLive, /class="waveform-live-trace"/);
    assert.match(channelLive, /CH 01 live output waveform/);
    const editor = renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE,
      trimStart: 0.25, trimEnd: 0.75,
      envelopePoints: [{ time: 0, value: 1 }, { time: 1, value: 0 }],
      onTrimChange: () => {}
    }));
    assert.match(editor, /source time in milliseconds"[^>]*><span>SRC 0\.0 ms<\/span><span>500\.0 ms<\/span><span>1000\.0 ms<\/span>/);
    assert.match(editor, /class="waveform-envelope"/);
    assert.doesNotMatch(editor, /waveform-envelope-fill/);
    assert.match(editor, /class="waveform-amplitude-fill" style="fill:var\(--wave-accent\)"/);
    assert.doesNotMatch(editor, /linearGradient|waveform-trimmed-region/);
    assert.match(editor, /aria-label="CH 01 sample start trim"/);
    const detailedEditor = renderToStaticMarkup(React.createElement(WaveformViewer, {
      title: 'CH 01', samples: new Float32Array(SAMPLE_RATE), sampleRate: SAMPLE_RATE,
      sourcePreview: {
        waveform: { min: new Array(4096).fill(-0.2), max: new Array(4096).fill(0.2) },
        durationSec: 1, sourceStart: 0, sourceEnd: 1, playbackDurationSec: 1, delaySec: 0
      },
      fitTrimmed: true, detail: 4096, onDetailChange: () => {}
    }));
    assert.match(detailedEditor, /aria-label="CH 01 waveform detail"/);
    assert.match(detailedEditor, /aria-label="CH 01 waveform zoom"/);
    const detailedPath = detailedEditor.match(/<path d="([^"]*)" class="waveform-amplitude-fill"/)?.[1];
    assert.equal((detailedPath?.match(/L/g) || []).length, 8195);

    const { LayerSumViewer, SumComparison } = await server.ssrLoadModule('/src/components/LayerSumViewer.jsx');
    const { UI_THEMES, getUiTheme } = await server.ssrLoadModule('/src/uiThemes.js');
    assert.ok(UI_THEMES.some((theme) => theme.id === 'golden-nugget'));
    const highContrast = getUiTheme('high-contrast');
    assert.equal(highContrast.id, 'high-contrast');
    const luminance = (hex) => {
      const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255);
      return channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    };
    for (const foreground of [highContrast.text, highContrast.muted, highContrast.accent, highContrast.accentSecondary, highContrast.accentTertiary, ...highContrast.channelColors]) {
      for (const background of [highContrast.background, highContrast.surface, highContrast.raised, highContrast.panel]) {
        assert.ok((luminance(foreground) + 0.05) / (luminance(background) + 0.05) >= 4.5, `${foreground} on ${background}`);
      }
    }
    const waveform = { min: [-0.5], max: [0.5], transient: [0.5, -0.5] };
    const patch = createDefaultState();
    const comparison = { final: waveform, preMaster: waveform, layers: patch.layers.map(() => waveform), noise: waveform, sampleRate: 1000 };
    const scope = {
      sum: { ...waveform, comparison, durationSec: 1 }, theme: UI_THEMES[0], layers: patch.layers,
      noise: patch.noise, master: patch.master, resolution: 512, onResolutionChange: () => {},
      onTraceEnabledChange: () => {}, onExpandedChange: () => {}
    };
    assert.doesNotMatch(renderToStaticMarkup(React.createElement(LayerSumViewer, { ...scope, expanded: false })),
      /EXPANDED OUTPUT SCOPE/);
    assert.match(renderToStaticMarkup(React.createElement(LayerSumViewer, { ...scope, expanded: true })),
      /EXPANDED OUTPUT SCOPE/);
    const liveComparison = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, sourceDurationSec: 0.5, capturedSec: 0.25, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: 0, live: true
    }));
    assert.match(liveComparison, /LIVE TRACE · SOURCES/);
    assert.match(liveComparison, /aria-label="CH 03 waveform"/);
    assert.match(liveComparison, /L127\.5,/);
    assert.match(liveComparison, /viewBox="5 0 245 112"/);
    assert.match(liveComparison, /500\.0 MS/);
    const fullComparison = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, sourceDurationSec: 0.5, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: -1
    }));
    assert.match(fullComparison, /DSP PREVIEW · FULL RENDER/);
    assert.match(fullComparison, /viewBox="5 0 490 112"/);
    assert.match(fullComparison, /1000\.0 MS/);
    const limitedCapture = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, sourceDurationSec: 2, capturedSec: 1, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: 0, live: true
    }));
    assert.match(limitedCapture, /viewBox="5 0 980 112"/);
    assert.match(limitedCapture, /2000\.0 MS/);
    assert.match(limitedCapture, /audio beyond the capture is not shown/);
    const fullCapture = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, sourceDurationSec: 0, capturedSec: 1, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: -1, live: true
    }));
    assert.match(fullCapture, /LIVE TRACE · FULL CAPTURE/);
    assert.match(fullCapture, /1000\.0 MS/);
    const transientComparison = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, capturedSec: 0.25, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: 5, live: true
    }));
    assert.match(transientComparison, /LIVE TRACE · SAMPLE-LEVEL · FIRST 5 MS/);
    assert.match(transientComparison, /class="sum-comparison-fill"/);
    for (const label of ['FINAL OUTPUT', 'PRE-MASTER', 'CH 01', 'CH 02', 'CH 03', 'NOISE']) {
      assert.match(transientComparison, new RegExp(`aria-label="${label} output time in milliseconds"`));
    }
    assert.match(transientComparison, /AFTER BUS EFFECTS \+ OUTPUT/);
    assert.match(transientComparison, /SOURCES BEFORE BUS EFFECTS/);
    const { SignalFlowDiagram } = await server.ssrLoadModule('/src/components/SignalFlowDiagram.jsx');
    patch.layers[0].loaded = true;
    patch.layers[1].loaded = true;
    patch.layers[1].mute = true;
    patch.noise.enabled = true;
    patch.noise.solo = true;
    Object.assign(patch.master, {
      busOrder: ['glue', 'noise', 'saturation', 'ringMod', 'convolve'],
      glueEnabled: true, glueMute: true, saturationEnabled: true, ringModEnabled: true
    });
    const flow = renderToStaticMarkup(React.createElement(SignalFlowDiagram, {
      layers: patch.layers, noise: patch.noise, master: patch.master, theme: UI_THEMES[0]
    }));
    assert.match(flow, /data-flow-status="SOLO EXCLUDED"[^>]*>[\s\S]*?<strong>CH 01<\/strong>/);
    assert.match(flow, /data-flow-status="MUTED"[^>]*>[\s\S]*?<strong>CH 02<\/strong>/);
    assert.match(flow, /data-flow-status="ROUTED"[^>]*>[\s\S]*?<strong>NOISE SYNTH<\/strong>/);
    assert.match(flow, /data-flow-status="MUTED"[^>]*>[\s\S]*?<strong>GLUE COMPRESSOR<\/strong>/);
    assert.match(flow, /data-flow-status="ACTIVE"[^>]*>[\s\S]*?<strong>SATURATION<\/strong>/);
    assert.match(flow, /data-flow-status="ACTIVE"[^>]*>[\s\S]*?<strong>RING MOD<\/strong>/);
    assert.ok(flow.indexOf('GLUE COMPRESSOR</strong>') < flow.indexOf('NOISE INSERT</strong>'));
    assert.ok(flow.indexOf('NOISE INSERT</strong>') < flow.indexOf('SATURATION</strong>'));
    assert.ok(flow.indexOf('SATURATION</strong>') < flow.indexOf('RING MOD</strong>'));
    assert.ok(flow.indexOf('RING MOD</strong>') < flow.indexOf('CONVOLUTION</strong>'));
    assert.ok(flow.indexOf('CONVOLUTION</strong>') < flow.indexOf('MASTER CLIPPER</strong>'));
  } finally {
    await server.close();
  }
});

test('playable source duration follows audible trim, pitch, delay and solo', () => {
  const state = createDefaultState();
  Object.assign(state.layers[0], {
    loaded: true, sampleKey: 'kick', sampleRate: SAMPLE_RATE,
    trimStart: 0.1, trimEnd: 0.9, pitch: 12, delayMs: 200
  });
  const tracks = () => getLayerPlaybackInfo(state, { kick: sample }, {});
  assert.ok(Math.abs(getPlayableSourceDurationSec(state, tracks()) - 0.6) < 1e-8);
  state.layers[0].phaseOffset = 0.05;
  assert.ok(Math.abs(getPlayableSourceDurationSec(state, tracks()) - 0.62) < 1e-8);
  state.layers[0].phaseOffset = -0.05;
  assert.ok(Math.abs(getPlayableSourceDurationSec(state, tracks()) - 0.58) < 1e-8);
  state.layers[0].phaseOffset = 0;

  Object.assign(state.noise, { enabled: true, gain: 0.5, decay: 2, trimEnd: 0.25, delayMs: 500 });
  assert.ok(Math.abs(getPlayableSourceDurationSec(state, tracks()) - 1.004) < 1e-8);
  state.layers[0].solo = true;
  assert.ok(Math.abs(getPlayableSourceDurationSec(state, tracks()) - 0.6) < 1e-8);
  state.layers[0].mute = true;
  assert.equal(getPlayableSourceDurationSec(state, tracks()), 0);
});

test('comparison cursor reads stereo samples and peak bins without inventing uncaptured data', () => {
  const waveform = {
    min: [-0.9, -0.2], max: [0.4, 0.8], binCount: 4,
    transient: [-0.2, 0.3], transientMax: [0.7, -0.6]
  };
  assert.deepEqual(getComparisonCursorRange(waveform, 0, 1, 0.5, 1000, 2), { min: -0.2, max: 0.7 });
  assert.deepEqual(getComparisonCursorRange(waveform, 0.002, 1, 0.5, 1000, 2), { min: -0.6, max: 0.3 });
  assert.equal(getComparisonCursorRange(waveform, 0.003, 1, 0.5, 1000, 5), null);
  assert.deepEqual(getComparisonCursorRange(waveform, 0.4, 1, 0.5, 1000, 0), { min: -0.2, max: 0.8 });
  assert.equal(getComparisonCursorRange(waveform, 0.5, 1, 0.5, 1000, 0), null);
  assert.equal(getComparisonCursorRange(waveform, 1.1, 1, 1, 1000, 0), null);
  const complete = { ...waveform, min: [-0.9, -0.2, 0, -0.1], max: [0.4, 0.8, 0, 0.2] };
  assert.deepEqual(getComparisonCursorRange(complete, 1, 1, 1, 1000, 0), { min: -0.1, max: 0.2 });
  assert.deepEqual(getComparisonCursorRange({ ...waveform, transientMax: undefined }, 0, 1, 1, 1000, 2),
    { min: -0.2, max: -0.2 });
  const samples = Array.from({ length: 221 }, (_, index) => index);
  const stepTime = (15 / 221) * (221 / 44100);
  assert.deepEqual(getComparisonCursorRange({ transient: samples }, stepTime, 1, 1, 44100, 221),
    { min: 15, max: 15 });
});

test('swapping samples moves their trims while preserving channel processing and state', () => {
  const patch = createLoadedPatch(0.1, 0.8);
  Object.assign(patch.layers[1], {
    loaded: true, name: 'snare', sampleKey: 'snare', sourceName: 'snare.wav',
    sampleCount: 1234, sampleRate: 48000, trimStart: 0.2, trimEnd: 0.9,
    gain: 0.25, pitch: 7
  });
  patch.layers[0].envelopePoints = [{ time: 0, value: 0 }, { time: 1, value: 1 }];
  const original = patch.layers;
  const swapped = swapLayerSamples(original, 0, 1);
  assert.equal(swapped[0].sampleKey, 'snare');
  assert.equal(swapped[0].trimStart, 0.2);
  assert.equal(swapped[0].gain, original[0].gain);
  assert.equal(swapped[0].envelopePoints, original[0].envelopePoints);
  assert.equal(swapped[1].sampleKey, 'kick');
  assert.equal(swapped[1].trimStart, 0.1);
  assert.equal(swapped[1].gain, 0.25);
  assert.equal(swapped[1].pitch, 7);
  assert.equal(original[0].sampleKey, 'kick');
  const restored = restorePatchState(serializePatchState({ ...patch, layers: swapped }), {
    kick: sample, snare: new Float32Array(1234)
  });
  assert.equal(restored.layers[0].sampleKey, 'snare');
  assert.equal(restored.layers[1].sampleKey, 'kick');
  const moved = swapLayerSamples(swapped, 0, 2);
  assert.equal(moved[2].sampleKey, 'snare');
  assert.equal(moved[0].loaded, false);
  assert.equal(moved[0].name, createDefaultState().layers[0].name);
});

test('resetting channel knobs preserves its sample, trim, envelope and switches', () => {
  const layer = createLoadedPatch(0.2, 0.8).layers[0];
  const knobKeys = ['pitch', 'delayMs', 'attack', 'sustain', 'hp', 'lp', 'clipDrive', 'clipHardness', 'inputDb', 'gain', 'phaseOffset', 'width'];
  for (const key of knobKeys) layer[key] += 1;
  layer.mute = true;
  layer.solo = true;
  const reset = resetLayerKnobs(layer);
  const defaults = createDefaultState().layers[0];
  for (const key of knobKeys) assert.equal(reset[key], defaults[key], key);
  for (const key of ['name', 'sampleKey', 'loaded', 'sampleCount', 'sampleRate', 'trimStart', 'trimEnd', 'envelopePoints', 'mute', 'solo']) {
    assert.equal(reset[key], layer[key], key);
  }
  assert.notEqual(layer.pitch, reset.pitch);
});

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

test('default channels reproduce stereo samples from the first frame and remain one-shot', async () => {
  const left = Float32Array.from({ length: 2048 }, (_, i) => 0.8 * Math.cos(i * 0.17));
  const right = Float32Array.from({ length: 2048 }, (_, i) => 0.6 * Math.sin(i * 0.11 + 0.7));
  const state = createDefaultState();
  Object.assign(state.layers[0], {
    loaded: true, sampleKey: 'left', sampleRightKey: 'right',
    sampleCount: left.length, sampleRate: SAMPLE_RATE
  });
  const renderer = new OfflineRenderer();
  await renderer.initialize({
    numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE, blockSize: 128,
    virtualFileSystem: { left, right }
  });
  const render = async (gate, length) => {
    await renderer.render(...buildDrumGraph({ ...state, gate }, true));
    const outputs = Array.from({ length: 22 }, () => new Float32Array(length));
    renderer.process([], outputs);
    return outputs;
  };
  const silence = await render(0, 22016);
  assert.ok(silence[3].every((value) => value === 0));
  const onset = await render(1, 128);
  const tail = await render(0, 2176);
  for (const [channel, original] of [[3, left], [4, right]]) {
    const rendered = [...onset[channel], ...tail[channel]];
    for (let i = 0; i < original.length; i += 1) {
      assert.ok(Math.abs(rendered[i] - original[i]) < 1e-5, `channel ${channel}, frame ${i}`);
    }
    assert.ok(rendered.slice(original.length).every((value) => value === 0));
  }

  const coldRenderer = new OfflineRenderer();
  await coldRenderer.initialize({
    numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE, blockSize: 128,
    virtualFileSystem: { left, right }
  });
  await coldRenderer.render(...buildDrumGraph({ ...state, gate: 1 }, true));
  const cold = Array.from({ length: 22 }, () => new Float32Array(128));
  coldRenderer.process([], cold);
  const referenceRenderer = new OfflineRenderer();
  await referenceRenderer.initialize({ numInputChannels: 0, numOutputChannels: 1, sampleRate: SAMPLE_RATE, blockSize: 128 });
  await referenceRenderer.render(el.const({ value: 1 }));
  const transition = new Float32Array(128);
  referenceRenderer.process([], [transition]);
  for (const [channel, original] of [[3, left], [4, right]]) {
    for (let i = 0; i < cold[channel].length; i += 1) {
      assert.ok(Math.abs(cold[channel][i] - original[i] * transition[i]) < 1e-5, `cold channel ${channel}, frame ${i}`);
    }
  }
});

test('sample retrigger preserves a fading previous voice without fading in the new onset', async () => {
  const samples = new Float32Array(4096).fill(0.25);
  const state = createDefaultState();
  Object.assign(state.layers[0], {
    loaded: true, sampleKey: 'kick', sampleCount: samples.length, sampleRate: SAMPLE_RATE
  });
  const renderer = new OfflineRenderer();
  await renderer.initialize({
    numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE, blockSize: 128,
    virtualFileSystem: { kick: samples }
  });
  const render = async (gate, length) => {
    await renderer.render(...buildDrumGraph({ ...state, gate }, true));
    const outputs = Array.from({ length: 22 }, () => new Float32Array(length));
    renderer.process([], outputs);
    return outputs[3];
  };
  await render(0, 22016);
  assert.ok(Math.abs((await render(1, 1024))[0] - 0.25) < 1e-5);
  await render(0, 128);
  const retrigger = await render(1, 1024);
  assert.ok(retrigger[0] > 0.45);
  assert.ok(retrigger[1023] > 0.25 && retrigger[1023] < 0.3);
});

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

test('trim markers set the rendered sum and playback duration', () => {
  const state = createLoadedPatch(0.25, 0.75);
  const sum = getLayerSumPeaks(state, { kick: sample }, { kick: SAMPLE_RATE });
  const playback = getLayerPlaybackInfo(state, { kick: sample }, { kick: SAMPLE_RATE });

  assert.equal(sum.durationSec, 0.5);
  assert.equal(sum.peaks.length, 512);
  assert.equal(playback[0].durationSec, 0.5);
});

test('channel waveform preserves signed min/max amplitudes and short transients', () => {
  const waveform = getLayerPreviewWaveform(
    [0.1, -0.8, 0.2, 0.9, 0.3, -1, 0.4, 0.1],
    4
  );

  assert.deepEqual(waveform.min, [-0.8, 0.2, -1, 0.1]);
  assert.deepEqual(waveform.max, [0.1, 0.9, 0.3, 0.4]);
});

test('default channel waveform resolution preserves narrow transients', () => {
  const samples = new Float32Array(4096);
  samples[1024] = -1;
  const waveform = getLayerPreviewWaveform(samples);

  assert.equal(waveform.min.length, 512);
  assert.equal(waveform.max.length, 512);
  assert.equal(waveform.min[128], -1);
});

test('waveform paths reach the bin edges without inventing an onset', () => {
  const transient = getWaveformPaths({ min: [-1, 0], max: [1, 0] });
  assert.ok(transient.area.startsWith('M5.0,11.0'));
  assert.ok(transient.area.endsWith('L5.0,105.0 Z'));

  const delayed = getWaveformPaths({ min: [0, -1], max: [0, 1] }, 0.2, 0.8);
  assert.ok(delayed.area.startsWith('M103.0,58.0'));
  assert.ok(delayed.area.endsWith('L103.0,58.0 Z'));
});

test('envelope controls cover the full display and reach silence at the bottom', () => {
  for (const value of [0, 0.5, 1]) {
    const y = getEnvelopeDisplayY(value);
    assert.equal(getEnvelopeDisplayValue(y), value);
  }
  assert.equal(getEnvelopeDisplayY(0), 101);
  assert.equal(getEnvelopeDisplayY(1), 11);
  assert.equal(getEnvelopeDisplayValue(0), 1);
  assert.equal(getEnvelopeDisplayValue(112), 0);
});

test('processed output maps delay, playback duration and partial traces to source coordinates', () => {
  const mapping = { sourceStart: 0.25, sourceEnd: 0.75, delaySec: 0.25, playbackDurationSec: 0.5 };
  const view = { start: 0, end: 1 };
  const waveform = { min: [-1, -2, -3, -4], max: [1, 2, 3, 4], binCount: 4 };
  const mapped = mapOutputWaveformToSource(waveform, 1, mapping, view, 8);
  assert.deepEqual(mapped.max, [0, 0, 2, 2, 3, 3, 0, 0]);
  const partial = mapOutputWaveformToSource({ ...waveform, min: [-1, -2], max: [1, 2] }, 1, mapping, view, 8);
  assert.deepEqual(partial.max, [0, 0, 2, 2, 0, 0, 0, 0]);
  const zoomed = mapOutputWaveformToSource(waveform, 1, mapping, { start: 0.25, end: 0.75 }, 4);
  assert.deepEqual(zoomed.max, [2, 2, 3, 3]);
});

test('a zero gain envelope silences the channel output', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].envelopePoints = [{ time: 0, value: 0 }, { time: 1, value: 0 }];
  const preview = await renderWaveformPreview(patch, { kick: sample });
  assert.ok(preview.comparison.layers[0].min.every((value) => value === 0));
  assert.ok(preview.comparison.layers[0].max.every((value) => value === 0));
});

test('noise waveform envelope and trim shape the rendered noise and survive restoration', async () => {
  const patch = createDefaultState();
  patch.noise.enabled = true;
  const original = await renderWaveformPreview(patch, {});
  assert.ok(original.comparison.noise.transient.some((value) => Math.abs(value) > 0.001));
  patch.noise.envelopePoints = [{ time: 0, value: 0 }, { time: 1, value: 0 }];
  const silent = await renderWaveformPreview(patch, {});
  assert.ok(silent.comparison.noise.transient.every((value) => Math.abs(value) < 1e-8));
  patch.noise.envelopePoints = [{ time: 0, value: 1, curve: -0.3 }, { time: 1, value: 0.5, curve: 0 }];
  patch.noise.trimStart = 0.2;
  patch.noise.trimEnd = 0.6;
  const trimmed = await renderWaveformPreview(patch, {});
  const audio = trimmed.comparison.noise.transient;
  const duration = patch.noise.decay + 0.016;
  assert.ok(audio.slice(0, Math.floor(duration * 0.18 * SAMPLE_RATE)).every((value) => Math.abs(value) < 1e-8));
  assert.ok(audio.slice(Math.ceil(duration * 0.65 * SAMPLE_RATE)).every((value) => Math.abs(value) < 1e-8));
  assert.ok(audio.slice(Math.ceil(duration * 0.25 * SAMPLE_RATE), Math.floor(duration * 0.55 * SAMPLE_RATE))
    .some((value) => Math.abs(value) > 0.001));
  const restored = restorePatchState(serializePatchState(patch));
  assert.equal(restored.noise.trimStart, 0.2);
  assert.equal(restored.noise.trimEnd, 0.6);
  assert.deepEqual(restored.noise.envelopePoints, patch.noise.envelopePoints);
  assert.deepEqual(restorePatchState({ noise: {} }).noise.envelopePoints, createDefaultState().noise.envelopePoints);
});

test('noise playback delay shifts the rendered trim window and extends WAV and preview duration', async () => {
  const patch = createDefaultState();
  Object.assign(patch.noise, { enabled: true, delayMs: 30, trimStart: 0.2, trimEnd: 0.6 });
  const preview = await renderWaveformPreview(patch, {});
  const samples = preview.comparison.noise.transient;
  const noiseDuration = patch.noise.decay + 0.016;
  const start = 0.03 + noiseDuration * 0.2;
  const end = 0.03 + noiseDuration * 0.6;
  assert.ok(samples.slice(0, Math.floor((start - 0.001) * SAMPLE_RATE)).every((value) => Math.abs(value) < 1e-8));
  assert.ok(samples.slice(Math.ceil((start + 0.002) * SAMPLE_RATE), Math.floor((end - 0.002) * SAMPLE_RATE))
    .some((value) => Math.abs(value) > 0.001));
  assert.ok(samples.slice(Math.ceil((end + 0.001) * SAMPLE_RATE)).every((value) => Math.abs(value) < 1e-8));
  assert.equal(restorePatchState(serializePatchState(patch)).noise.delayMs, 30);
  assert.equal(restorePatchState({ noise: {} }).noise.delayMs, 0);
  assert.equal(restorePatchState({ noise: { delayMs: 2000 } }).noise.delayMs, 1000);

  Object.assign(patch.noise, { delayMs: 700, trimStart: 0, trimEnd: 1 });
  const delayed = await renderWaveformPreview(patch, {}, 4096);
  assert.ok(delayed.durationSec >= 0.7 + noiseDuration);
  const onsetBin = Math.floor(0.7 / delayed.durationSec * delayed.comparison.noise.max.length);
  assert.ok(delayed.comparison.noise.max.slice(0, onsetBin - 1).every((value) => Math.abs(value) < 1e-8));
  assert.ok(delayed.comparison.noise.max.slice(onsetBin + 2).some((value) => value > 0.001));
  const wav = new DataView(await (await renderWavBlob(patch, {})).arrayBuffer());
  assert.ok(wav.getUint32(40, true) / 6 > SAMPLE_RATE * 0.7);
  for (let offset = 44; offset < 44 + Math.floor(SAMPLE_RATE * 0.69) * 6; offset += 1)
    assert.equal(wav.getUint8(offset), 0);
  assert.ok(new Uint8Array(wav.buffer, 44 + Math.ceil(SAMPLE_RATE * 0.705) * 6).some((value) => value !== 0));
});

test('stereo width preserves, collapses and widens channel signals and WAV output', async () => {
  const patch = createLoadedPatch();
  patch.noise.mute = true;
  patch.layers[0].sampleRightKey = 'right';
  const silent = new Float32Array(sample.length);
  const buffers = { kick: sample, right: silent };
  const render = async (width) => {
    patch.layers[0].width = width;
    return (await renderWaveformPreview(patch, buffers)).comparison.layers[0];
  };
  const normal = await render(1);
  assert.ok(normal.transient.some((value) => Math.abs(value) > 0.01));
  assert.ok(normal.transientMax.every((value) => Math.abs(value) < 1e-7));
  const mono = await render(0);
  assert.ok(mono.transient.every((value, index) => Math.abs(value - mono.transientMax[index]) < 1e-7));
  const wide = await render(2);
  for (let index = 0; index < normal.transient.length; index += 1) {
    assert.ok(Math.abs(wide.transient[index] - normal.transient[index] * 1.5) < 1e-5);
    assert.ok(Math.abs(wide.transientMax[index] + normal.transient[index] * 0.5) < 1e-5);
  }
  patch.layers[0].width = 1;
  const bytes = new DataView(await (await renderWavBlob(patch, buffers)).arrayBuffer());
  let different = false;
  for (let offset = 44; offset + 5 < bytes.byteLength; offset += 6) {
    if (bytes.getUint8(offset) !== bytes.getUint8(offset + 3) ||
        bytes.getUint8(offset + 1) !== bytes.getUint8(offset + 4) ||
        bytes.getUint8(offset + 2) !== bytes.getUint8(offset + 5)) {
      different = true;
      break;
    }
  }
  assert.equal(different, true);
});

test('stereo silence detection does not discard audio present only on the right', () => {
  const left = new Float32Array(1000);
  const right = new Float32Array(1000);
  right.fill(0.5, 200, 800);
  assert.ok(detectSilenceStart(left, 0.01, right) > 0.15);
  assert.ok(detectSilenceEnd(left, 0.01, right) > 0.75);
});

test('default sample trim fits quiet leading and trailing noise without losing stereo transients', () => {
  const left = new Float32Array(1000).fill(0.00001);
  const right = new Float32Array(1000).fill(-0.00001);
  left.fill(0.5, 200, 300);
  right[400] = 0.1;
  const trim = getDefaultSampleTrim(left, 1000, right);
  assert.deepEqual(trim, { trimStart: 0.195, trimEnd: 0.421 });
  const range = getSampleTrimRange(left.length, trim.trimStart, trim.trimEnd);
  assert.equal(range.startOffset, 195);
  assert.equal(range.endSample, 421);
  assert.equal(left[0], Math.fround(0.00001));
  assert.equal(right[400], Math.fround(0.1));
  assert.deepEqual(getDefaultSampleTrim(new Float32Array(1000), 1000), { trimStart: 0, trimEnd: 1 });
  const rightOnly = new Float32Array(1000);
  rightOnly[2] = 0.25;
  assert.deepEqual(getDefaultSampleTrim(new Float32Array(1000), 1000, rightOnly), {
    trimStart: 0, trimEnd: 0.023
  });
  const quiet = new Float32Array(1000).fill(0.000000001);
  quiet[500] = 0.000001;
  assert.deepEqual(getDefaultSampleTrim(quiet, 1000), { trimStart: 0.495, trimEnd: 0.521 });
  const quietTail = new Float32Array(1000).fill(0.00001);
  quietTail[100] = 0.5;
  quietTail[700] = 0.0006;
  assert.deepEqual(getDefaultSampleTrim(quietTail, 1000), { trimStart: 0.095, trimEnd: 0.721 });
  assert.deepEqual(getDefaultSampleTrim(Float32Array.of(0, 0.5, 0), 44100), { trimStart: 0, trimEnd: 1 });
  const short = new Float32Array(10000);
  short[9999] = 1;
  const shortTrim = getDefaultSampleTrim(short, 1000);
  assert.deepEqual(shortTrim, { trimStart: 0.99, trimEnd: 1 });
});

test('glue compression is stereo-linked and saturation offers a clean mix', async () => {
  const render = async (nodes) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({ numInputChannels: 0, numOutputChannels: 2, sampleRate: SAMPLE_RATE, blockSize: 128 });
    await renderer.render(...nodes);
    const outputs = [new Float32Array(SAMPLE_RATE), new Float32Array(SAMPLE_RATE)];
    renderer.process([], outputs);
    return outputs.map((channel) => channel.at(-1));
  };
  const config = { glueThreshold: -18, glueRatio: 4, glueAttack: 0.01, glueRelease: 0.12 };
  const [left, right] = await render(glueCompressor(el.const({ value: 0.8 }), el.const({ value: 0.2 }), config));
  assert.ok(left > 0 && left < 0.8);
  assert.ok(Math.abs(right / left - 0.25) < 1e-5);
  const [dry, wet] = await render([
    saturator('dry-saturation', el.const({ value: 0.1 }), 12, 0),
    saturator('wet-saturation', el.const({ value: 0.1 }), 12, 1)
  ]);
  assert.ok(Math.abs(dry - 0.1) < 1e-5);
  assert.ok(wet > dry);
  const state = createDefaultState();
  assert.equal(state.master.glueEnabled, false);
  assert.equal(state.master.saturationEnabled, false);
  state.master.glueEnabled = true;
  state.master.saturationEnabled = true;
  const restored = restorePatchState(serializePatchState(state));
  assert.equal(restored.master.glueEnabled, true);
  assert.equal(restored.master.saturationEnabled, true);
  assert.equal(restorePatchState({ layers: [], noise: {}, master: {} }).master.glueEnabled, false);
  assert.equal(restorePatchState({ layers: [], noise: {}, master: {} }).master.saturationEnabled, false);
  const migrated = restorePatchState({ noise: { saturationEnabled: true, saturationDrive: 12, saturationMix: 0.4 } });
  assert.equal(migrated.master.saturationEnabled, true);
  assert.equal(migrated.master.saturationDrive, 12);
  assert.equal(migrated.master.saturationMix, 0.4);
});

test('saturation types produce distinct bounded curves with a dry bypass', async () => {
  const sampleRate = 48000;
  const renderer = new OfflineRenderer();
  await renderer.initialize({ numInputChannels: 0, numOutputChannels: 4, sampleRate, blockSize: 128 });
  const signal = el.mul(0.6, el.cycle(1000));
  await renderer.render(
    saturator('types:tape', signal, 12, 1, 'tape'),
    saturator('types:tube', signal, 12, 1, 'tube'),
    saturator('types:hard', signal, 12, 1, 'hard'),
    saturator('types:dry', signal, 12, 0, 'tube')
  );
  const outputs = Array.from({ length: 4 }, () => new Float32Array(sampleRate));
  renderer.process([], outputs);
  const secondHarmonic = (channel) => {
    let sine = 0, cosine = 0;
    for (let i = sampleRate / 2; i < sampleRate; i += 1) {
      const phase = 2 * Math.PI * 2000 * i / sampleRate;
      sine += channel[i] * Math.sin(phase);
      cosine += channel[i] * Math.cos(phase);
    }
    return Math.hypot(sine, cosine) / (sampleRate / 2);
  };
  assert.ok(secondHarmonic(outputs[1]) > secondHarmonic(outputs[0]) + 0.02);
  assert.ok(secondHarmonic(outputs[1]) > secondHarmonic(outputs[2]) + 0.02);
  assert.ok(outputs[2].some((value) => value === 1));
  assert.ok(outputs[2].some((value) => value === -1));
  for (const channel of outputs) {
    assert.ok(channel.every(Number.isFinite));
    assert.ok(Math.max(...channel.subarray(sampleRate / 2)) <= 1.02);
    assert.ok(Math.min(...channel.subarray(sampleRate / 2)) >= -1.02);
  }
  assert.ok(Math.abs(Math.max(...outputs[3].subarray(sampleRate / 2)) - 0.6) < 0.001);
});

test('noise colors have distinct spectra and patch choices survive state restoration', async () => {
  for (const sampleRate of [44100, 48000]) {
    const renderer = new OfflineRenderer();
    await renderer.initialize({ numInputChannels: 0, numOutputChannels: 3, sampleRate, blockSize: 128 });
    const raw = el.noise({ key: `test:colored:${sampleRate}`, seed: 145 });
    await renderer.render(colorNoise(raw, 'white'), colorNoise(raw, 'pink'), colorNoise(raw, 'brown'));
    const outputs = Array.from({ length: 3 }, () => new Float32Array(sampleRate * 2));
    renderer.process([], outputs);
    const lowHighRatio = (channel) => {
      const pole = Math.exp(-2 * Math.PI * 250 / sampleRate);
      let low = 0, lowEnergy = 0, highEnergy = 0;
      for (let i = sampleRate / 2; i < channel.length; i += 1) {
        low = pole * low + (1 - pole) * channel[i];
        lowEnergy += low * low;
        highEnergy += (channel[i] - low) ** 2;
      }
      assert.ok(channel.every(Number.isFinite));
      return lowEnergy / highEnergy;
    };
    const ratios = outputs.map(lowHighRatio);
    assert.ok(ratios[1] > ratios[0] * 2, `pink versus white: ${ratios}`);
    assert.ok(ratios[2] > ratios[1] * 2, `brown versus pink: ${ratios}`);
  }
  const state = createDefaultState();
  state.noise.type = 'brown';
  state.master.saturationType = 'tube';
  const restored = restorePatchState(serializePatchState(state));
  assert.equal(restored.noise.type, 'brown');
  assert.equal(restored.master.saturationType, 'tube');
  const legacy = restorePatchState({ noise: {}, master: {} });
  assert.equal(legacy.noise.type, 'white');
  assert.equal(legacy.master.saturationType, 'tape');
  const invalid = restorePatchState({ noise: { type: 'invalid' }, master: { saturationType: 'invalid' } });
  assert.equal(invalid.noise.type, 'white');
  assert.equal(invalid.master.saturationType, 'tape');
  assert.equal(resetBusModuleKnobs(state, 'noise').noise.type, 'white');
  assert.equal(resetBusModuleKnobs(state, 'saturation').master.saturationType, 'tape');
});

test('selected noise and saturation types reach the processed preview graph', async () => {
  const patch = createLoadedPatch();
  patch.noise.enabled = true;
  patch.noise.mute = false;
  patch.noise.gain = 0.22;
  patch.master.saturationEnabled = true;
  patch.master.saturationDrive = 18;
  const finalWaveforms = [];
  for (const type of ['tape', 'tube', 'hard']) {
    patch.master.saturationType = type;
    patch.noise.type = 'white';
    const preview = await renderWaveformPreview(patch, { kick: sample });
    finalWaveforms.push(preview.comparison.final.transient);
    assert.ok(preview.comparison.noise.transient.some((value) => Math.abs(value) > 0));
  }
  assert.notDeepEqual(finalWaveforms[0], finalWaveforms[1]);
  assert.notDeepEqual(finalWaveforms[1], finalWaveforms[2]);
  for (const type of ['pink', 'brown']) {
    patch.noise.type = type;
    const preview = await renderWaveformPreview(patch, { kick: sample });
    assert.ok(preview.comparison.noise.transient.some((value) => Math.abs(value) > 0), type);
  }
});

test('master saturation processes the stereo sum before the glue compressor', async () => {
  const patch = createLoadedPatch();
  patch.noise.mute = true;
  patch.layers[0].sampleRightKey = 'right';
  const buffers = { kick: sample, right: Float32Array.from(sample, (value) => value * 0.25) };
  const dry = await renderWaveformPreview(patch, buffers);
  patch.master.saturationEnabled = true;
  patch.master.saturationDrive = 18;
  const saturated = await renderWaveformPreview(patch, buffers);
  assert.deepEqual(saturated.comparison.preMaster.transient, dry.comparison.preMaster.transient);
  assert.notDeepEqual(saturated.comparison.final.transient, dry.comparison.final.transient);
  assert.notDeepEqual(saturated.comparison.final.transientMax, dry.comparison.final.transientMax);
  patch.master.glueEnabled = true;
  patch.master.glueThreshold = -30;
  patch.master.glueRatio = 8;
  const compressed = await renderWaveformPreview(patch, buffers);
  assert.notDeepEqual(compressed.comparison.final.transient, saturated.comparison.final.transient);
  patch.master.busOrder = ['glue', 'saturation', 'noise'];
  const reordered = await renderWaveformPreview(patch, buffers);
  assert.notDeepEqual(reordered.comparison.final.transient, compressed.comparison.final.transient);
  assert.deepEqual(reordered.comparison.preMaster.transient, compressed.comparison.preMaster.transient);
  assert.deepEqual(restorePatchState(serializePatchState(patch), buffers).master.busOrder,
    ['glue', 'saturation', 'noise', 'ringMod', 'convolve']);
  assert.deepEqual(restorePatchState({ master: { busOrder: ['noise', 'noise', 'glue'] } }).master.busOrder,
    ['noise', 'ringMod', 'convolve', 'saturation', 'glue']);
});

test('noise joins the bus at its selected position', async () => {
  const patch = createDefaultState();
  patch.noise.enabled = true;
  Object.assign(patch.master, { drive: 0, hardness: 1, ceiling: 1, saturationEnabled: true, saturationDrive: 24 });
  patch.noise.gain = 0.05;
  patch.master.busOrder = ['saturation', 'noise', 'glue'];
  const after = await renderWaveformPreview(patch, {});
  const finalAfter = after.comparison.final.transient;
  const noiseAfter = after.comparison.noise.transient;
  assert.ok(finalAfter.some((value) => Math.abs(value) > 1e-4));
  assert.ok(finalAfter.every((value, i) => Math.abs(value - noiseAfter[i]) < 1e-5));

  patch.master.busOrder = ['noise', 'saturation', 'glue'];
  const before = await renderWaveformPreview(patch, {});
  assert.ok(before.comparison.final.transient.some((value, i) =>
    Math.abs(value - before.comparison.noise.transient[i]) > 1e-3));
});

test('noise enable and mute are independent and legacy patches retain their sound', async () => {
  const patch = createDefaultState();
  assert.equal(patch.noise.enabled, false);
  assert.equal(patch.noise.mute, false);
  const silent = await renderWaveformPreview(patch, {});
  assert.ok(silent.comparison.final.transient.every((value) => value === 0));
  patch.noise.enabled = true;
  assert.ok((await renderWaveformPreview(patch, {})).comparison.noise.transient.some((value) => Math.abs(value) > 0.001));
  patch.noise.mute = true;
  assert.ok((await renderWaveformPreview(patch, {})).comparison.final.transient.every((value) => value === 0));
  patch.noise.enabled = false;
  const restored = restorePatchState(serializePatchState(patch));
  assert.equal(restored.noise.enabled, false);
  assert.equal(restored.noise.mute, true);
  assert.equal(restorePatchState({ noise: { mute: false } }).noise.enabled, true);
  assert.equal(restorePatchState({ noise: { mute: true } }).noise.mute, true);

  const layerPatch = createLoadedPatch();
  layerPatch.noise.solo = true;
  const withDisabledSolo = await renderWaveformPreview(layerPatch, { kick: sample });
  assert.ok(withDisabledSolo.comparison.layers[0].transient.some((value) => Math.abs(value) > 0.001));
});

test('envelope curves survive patch restoration and old points remain linear', () => {
  const patch = createLoadedPatch();
  patch.layers[0].envelopePoints = [
    { time: 0, value: 0, curve: 0.4 },
    { time: 0.5, value: 1, curve: -0.3 },
    { time: 1, value: 0 }
  ];
  const saved = serializePatchState(patch);
  const points = restorePatchState(saved, { kick: sample }).layers[0].envelopePoints;
  assert.deepEqual(points, [
    { time: 0, value: 0, curve: 0.4 },
    { time: 0.5, value: 1, curve: -0.3 },
    { time: 1, value: 0, curve: 0 }
  ]);
  saved.layers[0].envelopePoints[0].curve = 4;
  assert.equal(restorePatchState(saved, { kick: sample }).layers[0].envelopePoints[0].curve, 0.5);
});

test('curved envelope rendering and DSP sequence use the same shape', () => {
  for (const curve of [-0.5, 0, 0.5]) {
    const points = [{ time: 0, value: 0, curve }, { time: 1, value: 1 }];
    const sequence = getEnvelopeSequence(points);
    const midpoint = sequence.find((point) => point.time === 0.5);
    if (curve === 0) {
      assert.equal(sequence.length, 2);
      assert.equal(getEnvelopeValueAt(0.5, points), 0.5);
    } else {
      assert.equal(sequence.length, 33);
      assert.equal(midpoint.value, getEnvelopeValueAt(0.5, points));
      assert.ok(curve > 0 ? midpoint.value > 0.5 : midpoint.value < 0.5);
    }
  }
});

test('sum display fit fills the view for quiet peaks without altering the waveform', () => {
  const waveform = { min: [-0.2, -0.1], max: [0.2, 0.1] };
  const gain = getWaveformFitGain(waveform);
  assert.equal(gain, 5);
  assert.ok(getWaveformPaths(waveform, 0, 1, gain).area.startsWith('M5.0,11.0'));
  assert.ok(getWaveformPaths(waveform).area.startsWith('M5.0,48.6'));
  assert.deepEqual(waveform, { min: [-0.2, -0.1], max: [0.2, 0.1] });
});

test('sum display fit preserves silence and limits quiet-signal amplification', () => {
  assert.equal(getWaveformFitGain({ min: [], max: [] }), 1);
  assert.equal(getWaveformFitGain({ min: [0], max: [0] }), 1);
  assert.equal(getWaveformFitGain({ min: [-0.001], max: [0.001] }), 20);
  assert.equal(getWaveformFitGain({ min: [-1], max: [1] }), 1);
  assert.equal(getWaveformFitGain({ min: [NaN], max: [Infinity] }), 1);
});

test('trimmed channel preview fits the playable range with bounded context', () => {
  const shortRange = getTrimmedPreviewRange(0, 0.1);
  assert.equal(shortRange.start, 0);
  assert.ok(Math.abs(shortRange.end - 0.11) < 1e-12);
  assert.deepEqual(getTrimmedPreviewRange(0.5, 1), { start: 0.45, end: 1 });
  assert.deepEqual(getTrimmedPreviewRange(0, 1), { start: 0, end: 1 });
  const nearEdge = getTrimmedPreviewRange(0.02, 0.5);
  assert.equal(nearEdge.start, 0);
  assert.ok(Math.abs(nearEdge.end - 0.548) < 1e-12);
});

test('source zoom stays centered on the fitted trim without changing the selection', () => {
  const range = getTrimmedPreviewRange(0.25, 0.75);
  const zoomed = getZoomedPreviewRange(range, 2);
  assert.ok(Math.abs(zoomed.start - 0.35) < 1e-12);
  assert.ok(Math.abs(zoomed.end - 0.65) < 1e-12);
  assert.deepEqual(getZoomedPreviewRange({ start: 0, end: 1 }, 1), { start: 0, end: 1 });
  const nearStart = getZoomedPreviewRange(getTrimmedPreviewRange(0, 0.1), 2);
  assert.ok(Math.abs(nearStart.start - 0.0275) < 1e-12);
  assert.ok(Math.abs(nearStart.end - 0.0825) < 1e-12);
  assert.deepEqual(getZoomedPreviewRange({ start: 0.2, end: 0.8 }, 2, 0), { start: 0.2, end: 0.5 });
  const right = getZoomedPreviewRange({ start: 0.2, end: 0.8 }, 2, 1);
  assert.ok(Math.abs(right.start - 0.5) < 1e-12);
  assert.ok(Math.abs(right.end - 0.8) < 1e-12);
  assert.deepEqual(getZoomedPreviewRange({ start: 0.2, end: 0.8 }, 2, -1), getZoomedPreviewRange({ start: 0.2, end: 0.8 }, 2, 0));
});

test('stereo waveform merges both channel bounds into one signed envelope', () => {
  const waveform = mergeStereoWaveform({
    leftMin: [-0.1, -0.6],
    leftMax: [0.2, 0.3],
    rightMin: [-0.7, -0.2],
    rightMax: [0.4, 0.9]
  });

  assert.deepEqual(waveform.min, [-0.7, -0.6]);
  assert.deepEqual(waveform.max, [0.4, 0.9]);
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
  assert.equal(preview.peaks.length, 512);
  assert.ok(preview.peaks.slice(0, 20).some((peak) => peak > 0));
  assert.equal(preview.stereoWaveform.leftMin.length, 512);
  assert.ok(preview.stereoWaveform.leftMax.some((peak) => peak > 0));
  assert.ok(preview.stereoWaveform.rightMin.some((peak) => peak < 0));
});

test('DSP sum waveform reflects channel filter controls, not only channel mix', async () => {
  const baseline = await renderWaveformPreview(
    createLoadedPatch(),
    { kick: sample }
  );
  const filteredPatch = createLoadedPatch();
  filteredPatch.layers[0].hp = 1800;
  const filtered = await renderWaveformPreview(filteredPatch, { kick: sample });

  assert.notDeepEqual(filtered.stereoWaveform.leftMax, baseline.stereoWaveform.leftMax);
  assert.notDeepEqual(filtered.stereoWaveform.rightMin, baseline.stereoWaveform.rightMin);
});

test('output trim is post-master and survives patch restoration', async () => {
  const patch = createLoadedPatch();
  const baseline = await renderWaveformPreview(patch, { kick: sample });
  patch.master.outputDb = -6;
  const trimmed = await renderWaveformPreview(patch, { kick: sample });
  const gain = Math.pow(10, -6 / 20);
  for (let index = 0; index < baseline.comparison.final.transient.length; index += 1) {
    assert.ok(Math.abs(trimmed.comparison.final.transient[index] - baseline.comparison.final.transient[index] * gain) < 1e-6);
    assert.equal(trimmed.comparison.preMaster.transient[index], baseline.comparison.preMaster.transient[index]);
  }
  const saved = serializePatchState(patch);
  assert.equal(restorePatchState(saved, { kick: sample }).master.outputDb, -6);
  delete saved.master.outputDb;
  assert.equal(restorePatchState(saved, { kick: sample }).master.outputDb, 0);
});

test('sample gain is restored and changes the signal before channel clipping', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].clipDrive = 18;
  const baseline = await renderWaveformPreview(patch, { kick: sample });
  patch.layers[0].inputDb = -12;
  const quieter = await renderWaveformPreview(patch, { kick: sample });
  const ratio = Math.pow(10, -12 / 20);
  const peak = (values) => Math.max(...values.map(Math.abs));
  const baselinePeak = peak(baseline.comparison.layers[0].transient);
  const quieterPeak = peak(quieter.comparison.layers[0].transient);
  assert.ok(quieterPeak < baselinePeak);
  assert.ok(quieterPeak > baselinePeak * ratio * 1.1);
  const restored = restorePatchState(serializePatchState(patch), { kick: sample });
  assert.equal(restored.layers[0].inputDb, -12);
  delete patch.layers[0].inputDb;
  assert.equal(restorePatchState(serializePatchState(patch), { kick: sample }).layers[0].inputDb, 0);
});

test('phase alignment advances or delays playback and persists both signs', async () => {
  const patch = createLoadedPatch();
  const pulse = new Float32Array(SAMPLE_RATE);
  pulse[3000] = 1;
  const reference = new Float32Array(SAMPLE_RATE);
  reference[2980] = 1;
  assert.equal(getPhaseOffset(pulse, reference, 30), -20 / SAMPLE_RATE);

  const peakIndex = (values) => values.reduce(
    (best, value, index) => Math.abs(value) > Math.abs(values[best]) ? index : best, 0
  );
  const renderIndex = async () => {
    const preview = await renderWaveformPreview(patch, { kick: pulse });
    return peakIndex(preview.comparison.layers[0].transient);
  };
  const baseline = await renderIndex();
  patch.layers[0].phaseOffset = 0.01;
  assert.ok(Math.abs((await renderIndex()) - baseline - 441) <= 1);
  assert.equal(restorePatchState(serializePatchState(patch), { kick: pulse }).layers[0].phaseOffset, 0.01);
  patch.layers[0].phaseOffset = -0.01;
  const advanced = await renderIndex();
  assert.ok(Math.abs(advanced - baseline + 441) <= 16, `baseline ${baseline}, advanced ${advanced}`);
  assert.equal(restorePatchState(serializePatchState(patch), { kick: pulse }).layers[0].phaseOffset, -0.01);
});

test('live estimate and playback timeline reflect sample gain and signed phase', () => {
  const patch = createLoadedPatch();
  const steady = new Float32Array(SAMPLE_RATE).fill(0.2);
  const estimate = () => getLayerSumPeaks(patch, { kick: steady }, { kick: SAMPLE_RATE });
  const baseline = estimate();
  patch.layers[0].inputDb = -6;
  assert.ok(Math.abs(Math.max(...estimate().peaks) / Math.max(...baseline.peaks) - Math.pow(10, -6 / 20)) < 1e-6);
  patch.layers[0].phaseOffset = 0.01;
  assert.ok(Math.abs(estimate().durationSec - baseline.durationSec - 0.01) < 1e-8);
  assert.ok(Math.abs(getLayerPlaybackInfo(patch, { kick: steady }, { kick: SAMPLE_RATE })[0].delaySec - 0.01) < 1e-8);
  patch.layers[0].phaseOffset = -0.01;
  assert.ok(Math.abs(estimate().durationSec - baseline.durationSec + 0.01) < 1e-8);
});

test('browser output monitor passes stereo through and reports aligned trace and peaks', () => {
  let Monitor;
  const messages = [];
  class MockProcessor {
    constructor() {
      this.port = { postMessage: (message) => messages.push(message) };
    }
  }
  const context = {
    AudioWorkletProcessor: MockProcessor,
    registerProcessor: (_name, processor) => { Monitor = processor; },
    sampleRate: 48000,
    currentFrame: 1000,
    Float32Array
  };
  runInNewContext(readFileSync(new URL('../src/audio/outputMonitorWorklet.js', import.meta.url), 'utf8'), context);
  const monitor = new Monitor();
  monitor.port.onmessage({ data: { type: 'trace', enabled: true, generation: 7 } });
  for (let block = 0; block < 16; block += 1) {
    const left = Float32Array.from({ length: 128 }, (_, i) => (block * 128 + i) / 2048);
    const right = Float32Array.from(left, (value) => -value * 0.5);
    const gate = Float32Array.from(left, (_, i) => block > 0 || i >= 32 ? 1 : 0);
    const lanes = Array.from({ length: 10 }, (_, lane) =>
      Float32Array.from(left, (value) => value * (lane + 1))
    );
    const effectMeters = Array.from({ length: 9 }, (_, lane) =>
      Float32Array.from(left, (value) => value * (lane + 1))
    );
    const output = [new Float32Array(128), new Float32Array(128)];
    monitor.process([[left, right, gate, ...lanes, ...effectMeters]], [output]);
    assert.deepEqual(output[0], left);
    assert.deepEqual(output[1], right);
    context.currentFrame += 128;
  }
  const trace = messages.find((message) => message.type === 'trace');
  assert.equal(trace.generation, 7);
  assert.equal(trace.startFrame, 1000);
  assert.equal(trace.buffers[2][31], 0);
  assert.equal(trace.buffers[2][32], 1);
  assert.equal(trace.buffers[0][2047], 2047 / 2048);
  assert.equal(trace.buffers[1][2047], -2047 / 4096);
  for (let lane = 0; lane < 10; lane += 1) {
    assert.equal(trace.buffers[lane + 3][2047], (2047 / 2048) * (lane + 1));
  }
  assert.ok(messages.some((message) => message.type === 'meter' && message.peak === 1791 / 2048));
  const meter = messages.find((message) => message.type === 'meter');
  for (let lane = 0; lane < 9; lane += 1) {
    assert.ok(Math.abs(meter.effects[lane] - (895 / 2048) * (lane + 1)) < 1e-6);
  }
});

test('WAV export produces audible stereo 24-bit PCM at 44.1 kHz', async () => {
  const blob = await renderWavBlob(createLoadedPatch(), { kick: sample });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint16(34, true), 24);
  assert.equal(view.getUint32(40, true), bytes.length - 44);
  assert.ok(bytes.slice(44).some((value) => value !== 0));
});

test('live trace captures the most recent gated hit and rejects discontinuous data', () => {
  const trace = new LiveTrace(() => 0.08);
  const packet = (audio, gate, start) => ({
    audio,
    gate,
    clock: audio.map((_, index) => start + index)
  });
  const first = packet([0, 0, 0.2, -0.5, 0.3, 0.1], [0, 0, 1, 1, 0, 0], 0);
  const partial = trace.consume([first.audio, first.audio, first.gate, first.clock], 100);
  assert.equal(partial.status, 'CAPTURING');
  assert.equal(partial.capturedSec, 0.04);
  assert.deepEqual(partial.min, [0.2, -0.5, 0.3, 0.1]);
  const second = packet([0.1, 0.2, 0.3, 0.4], [0, 0, 0, 0], 6);
  const complete = trace.consume([second.audio, second.audio, second.gate, second.clock], 100);
  assert.equal(complete.status, 'LAST HIT');
  assert.equal(complete.capturedSec, 0.08);
  const next = packet([0, 0.8, -0.7], [0, 1, 1], 10);
  assert.deepEqual(trace.consume([next.audio, next.audio, next.gate, next.clock], 100).min, [0.8, -0.7]);
  const gap = packet([0, 0], [1, 1], 30);
  assert.deepEqual(trace.consume([gap.audio, gap.audio, gap.gate, gap.clock], 100), { status: 'GAP' });
});

test('native live trace captures consecutive one-sample trigger pulses', () => {
  const trace = new LiveTrace(() => 0.1, 10, true, true);
  const result = trace.consume([[0, 0.2, 0.8, 0.4], [0, 0.2, 0.8, 0.4], [0, 1, 1, 0], [0, 1, 2, 3]], 100);
  assert.deepEqual(result.transient, [0.8, 0.4]);
  assert.equal(result.capturedSec, 0.02);
});

test('live trace limits its duration and does not fabricate a trigger when armed mid-note', () => {
  const trace = new LiveTrace(() => 8);
  assert.equal(trace.consume([[0.5, 0.4], [0.5, 0.4], [1, 1], [0, 1]], 100), null);
  const result = trace.consume([[0, 0.2], [0, -0.3], [0, 1], [2, 3]], 100);
  assert.equal(result.limited, true);
  assert.equal(result.capturedSec, 0.01);
  assert.deepEqual(result.min, [-0.3]);
  assert.deepEqual(result.max, [0.2]);
});

test('live trace uses 512 bins for a full capture', () => {
  const trace = new LiveTrace(() => 1);
  const audio = Array.from({ length: 2049 }, (_, index) => index / 2048);
  const gate = [0, ...Array(2048).fill(1)];
  const result = trace.consume([audio, audio, gate, audio.map((_, index) => index)], 2048);
  assert.equal(result.status, 'LAST HIT');
  assert.equal(result.min.length, 512);
  assert.equal(result.max.length, 512);
  assert.equal(result.min[0], audio[1]);
  assert.equal(result.max[0], audio[4]);
});

test('live comparison captures synchronized lanes and discards interrupted hits', () => {
  const trace = new LiveComparisonTrace(() => 0.1);
  const gate = [0, 0, 1, 1, 0, 0];
  const clock = gate.map((_, index) => index);
  const lanes = [
    [0, 0, 0.5, -0.5, 0.25, 0],
    [0, 0, -0.2, 0.2, 0, 0],
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0.1, 0.1, 0, 0],
    [0, 0, 0.4, -0.2, 0.25, 0]
  ];
  const final = [0, 0, 0.3, -0.15, 0.2, 0];
  const right = [0, 0, -0.4, 0.15, 0.2, 0];
  const stereoLanes = lanes.flatMap((lane) => [lane, lane]);
  const result = trace.consume([final, right, gate, clock, ...stereoLanes], 100);
  assert.equal(result.status, 'CAPTURING');
  assert.equal(result.capturedSec, 0.04);
  assert.deepEqual(result.comparison.layers[0].transient, [0.5, -0.5, 0.25, 0]);
  assert.deepEqual(result.comparison.final.transientMax, [-0.4, 0.15, 0.2, 0]);
  assert.deepEqual(result.comparison.noise.min, [0.1, 0.1, 0, 0]);
  assert.deepEqual(result.comparison.preMaster.min, [0.4, -0.2, 0.25, 0]);
  assert.deepEqual(trace.consume([final, final, gate.map(() => 1), clock.map((frame) => frame + 20), ...stereoLanes], 100), { status: 'GAP' });
  assert.throws(() => trace.consume([final, final, gate, clock], 100), /Invalid live comparison data/);
});

test('live trace supports 512-bin sum display and adjustable expanded detail', () => {
  const trace = new LiveComparisonTrace(() => 1);
  const audio = Array.from({ length: 8193 }, (_, index) => index === 101 ? -0.9 : 0.1);
  const gate = [0, ...Array(8192).fill(1)];
  const clock = audio.map((_, index) => index);
  const result = trace.consume([audio, audio, gate, clock, ...Array(10).fill(audio)], 8192);
  for (const resolution of [512, 2048, 4096]) {
    const displayed = reduceComparisonResolution(result, resolution);
    for (const waveform of [displayed.comparison.final, ...displayed.comparison.layers, displayed.comparison.noise, displayed.comparison.preMaster]) {
      assert.equal(waveform.min.length, resolution);
      assert.equal(waveform.max.length, resolution);
      assert.ok(waveform.min.includes(-0.9));
    }
    assert.equal(displayed.min.length, resolution);
  }
  assert.equal(result.min.length, 4096);
  const offline = { min: Float32Array.from({ length: 2048 }, (_, i) => i === 17 ? -0.9 : 0), max: new Float32Array(2048) };
  const reduced = reduceWaveformResolution(offline, 512);
  assert.equal(reduced.min.length, 512);
  assert.ok(reduced.min.some((value) => value < -0.89));
});

test('monitor outputs preserve stereo audio and expose the processed mix', async () => {
  const patch = createLoadedPatch();
  const render = async (monitor) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({
      numInputChannels: 0, numOutputChannels: monitor ? 22 : 2, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: { kick: sample }
    });
    await renderer.render(...buildDrumGraph({ ...patch, gate: 1, velocity: 1 }, monitor));
    const outputs = Array.from({ length: monitor ? 22 : 2 }, () => new Float32Array(4096));
    renderer.process([], outputs);
    return outputs;
  };
  const baseline = await render(false);
  const monitored = await render(true);
  assert.deepEqual(monitored[0], baseline[0]);
  assert.deepEqual(monitored[1], baseline[1]);
  assert.ok(monitored[2].some((value) => value > 0));
  assert.ok(monitored[3].some((value) => value !== 0));
  for (let index = 0; index < monitored[11].length; index += 1) {
    for (let side = 0; side < 2; side += 1) {
      const sum = monitored[3 + side][index] + monitored[5 + side][index] +
        monitored[7 + side][index] + monitored[9 + side][index];
      assert.ok(Math.abs(monitored[11 + side][index] - sum) < 1e-6);
    }
  }
});

test('effect meter taps follow bus order, gain and bypass and survive patch round trips', async () => {
  const patch = createLoadedPatch();
  patch.master.saturationEnabled = true;
  patch.master.glueEnabled = true;
  patch.master.saturationGainDb = 6;
  patch.master.glueGainDb = -6;
  patch.master.glueThreshold = -30;
  patch.master.glueRatio = 8;
  const restored = restorePatchState(serializePatchState(patch), { kick: sample });
  assert.equal(restored.master.saturationGainDb, 6);
  assert.equal(restored.master.glueGainDb, -6);
  const old = restorePatchState({ master: {} });
  assert.equal(old.master.saturationGainDb, 0);
  assert.equal(old.master.glueGainDb, 0);
  assert.equal(old.master.saturationMute, false);
  assert.equal(old.master.glueMute, false);

  const render = async () => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({
      numInputChannels: 0, numOutputChannels: 22, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: { kick: sample }
    });
    await renderer.render(...buildDrumGraph({ ...patch, gate: 1 }, true));
    const outputs = Array.from({ length: 22 }, () => new Float32Array(8192));
    renderer.process([], outputs);
    return outputs;
  };
  const forward = await render();
  for (let index = 0; index < 8192; index += 1) {
    assert.ok(Math.abs(forward[14][index] - forward[15][index]) < 1e-6);
  }
  assert.ok(Math.max(...forward[17]) > 1);
  patch.master.saturationMix = 0;
  patch.master.glueMix = 0;
  const gainOnly = await render();
  const index = 7000;
  assert.ok(gainOnly[13][index] > 0.01);
  assert.ok(Math.abs(gainOnly[14][index] / gainOnly[13][index] - Math.pow(10, 6 / 20)) < 0.01);
  assert.ok(Math.abs(gainOnly[16][index] / gainOnly[15][index] - Math.pow(10, -6 / 20)) < 0.01);
  patch.master.saturationMix = 1;
  patch.master.glueMix = 1;
  patch.master.busOrder = ['noise', 'glue', 'saturation'];
  const reverse = await render();
  for (let index = 0; index < 8192; index += 1) {
    assert.ok(Math.abs(reverse[16][index] - reverse[13][index]) < 1e-6);
  }
  assert.notDeepEqual(forward[0], reverse[0]);
  for (const [muteKey, enabledKey, input, output] of [
    ['saturationMute', 'saturationEnabled', 13, 14],
    ['glueMute', 'glueEnabled', 15, 16]
  ]) {
    patch.master[muteKey] = true;
    const restoredMute = restorePatchState(serializePatchState(patch), { kick: sample });
    assert.equal(restoredMute.master[muteKey], true);
    const muted = await render();
    assert.deepEqual(muted[input], muted[output]);
    if (muteKey === 'glueMute') assert.ok(muted[17].every((value) => value === 0));
    patch.master[muteKey] = false;
    patch.master[enabledKey] = false;
    const disabled = await render();
    assert.deepEqual(muted[0], disabled[0]);
    assert.deepEqual(muted[1], disabled[1]);
    patch.master[enabledKey] = true;
  }
  patch.master.saturationEnabled = false;
  patch.master.glueEnabled = false;
  const bypass = await render();
  assert.deepEqual(bypass[13], bypass[14]);
  assert.deepEqual(bypass[15], bypass[16]);
  assert.ok(bypass[17].every((value) => value === 0));
});

test('compressor meter reports actual wet gain reduction before dry mix', async () => {
  const config = { glueThreshold: -18, glueRatio: 4, glueAttack: 0.01, glueRelease: 0.12, glueMix: 1 };
  const render = async (mix) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({ numInputChannels: 0, numOutputChannels: 3, sampleRate: SAMPLE_RATE, blockSize: 128 });
    await renderer.render(...glueCompressor(el.const({ value: 0.8 }), el.const({ value: 0.2 }), { ...config, glueMix: mix }, true));
    const outputs = Array.from({ length: 3 }, () => new Float32Array(SAMPLE_RATE));
    renderer.process([], outputs);
    return outputs.map((channel) => channel.at(-1));
  };
  const [left, right, reduction] = await render(1);
  const [dry, , dryReduction] = await render(0);
  assert.ok(Math.abs(reduction - 20 * Math.log10(0.8 / left)) < 1e-4);
  assert.ok(Math.abs(right / left - 0.25) < 1e-5);
  assert.ok(Math.abs(dry - 0.8) < 1e-5);
  assert.ok(Math.abs(dryReduction - reduction) < 1e-5);
});

test('bending an envelope changes the processed output in the expected direction', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].envelopePoints = [
    { time: 0, value: 0, curve: 0.5 },
    { time: 1, value: 1, curve: 0 }
  ];
  const easeOut = await renderWaveformPreview(patch, { kick: sample });
  patch.layers[0].envelopePoints[0].curve = -0.5;
  const easeIn = await renderWaveformPreview(patch, { kick: sample });
  const energy = (values) => values.reduce((total, value) => total + Math.abs(value), 0);
  assert.ok(energy(easeOut.comparison.final.transient) > energy(easeIn.comparison.final.transient) * 10);
});

test('updating a bend changes subsequent triggers in the same audio renderer', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].envelopePoints = [
    { time: 0, value: 0, curve: -0.5 },
    { time: 1, value: 1, curve: 0 }
  ];
  const renderer = new OfflineRenderer();
  await renderer.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SAMPLE_RATE,
    blockSize: 128, virtualFileSystem: { kick: sample }
  });
  const render = async (gate, length) => {
    await renderer.render(...buildDrumGraph({ ...patch, gate, velocity: 1 }));
    const left = new Float32Array(length);
    renderer.process([], [left, new Float32Array(length)]);
    return left;
  };
  const easeIn = await render(1, 4096);
  await render(0, 256);
  patch.layers[0].envelopePoints[0].curve = 0.5;
  const easeOut = await render(1, 4096);
  const energy = (values) => values.reduce((total, value) => total + Math.abs(value), 0);
  assert.ok(energy(easeOut) > energy(easeIn) * 10);
});

test('higher sum detail preserves a short transient in more precise time bins', async () => {
  const transient = new Float32Array(SAMPLE_RATE);
  transient.fill(0.8, 441, 485);
  const patch = createLoadedPatch();
  const standard = await renderWaveformPreview(patch, { kick: transient }, 512);
  const fine = await renderWaveformPreview(patch, { kick: transient }, 4096);

  assert.equal(standard.peaks.length, 512);
  assert.equal(fine.peaks.length, 4096);
  assert.equal(fine.stereoWaveform.leftMax.length, 4096);
  const standardPeak = Math.max(...standard.peaks);
  const finePeak = Math.max(...fine.peaks);
  assert.ok(standardPeak > 0);
  assert.ok(Math.abs(standardPeak - finePeak) < 1e-6);
  const firstAudibleFineBin = fine.peaks.findIndex((peak) => peak > 1e-6);
  assert.ok(firstAudibleFineBin >= 0);
  assert.ok(fine.peaks.filter((peak) => peak > 1e-6).length >
    standard.peaks.filter((peak) => peak > 1e-6).length);
});

test('sample-level filled paths preserve polarity, stereo bounds and the selected time window', () => {
  const path = getSampleAreaPath([0, 0.5, -0.5], 5, 1, [0, -0.25, 0.25]);
  assert.equal(path, getWaveformPaths({
    min: [0, -0.25, -0.5],
    max: [0, 0.5, 0.25]
  }, 0, 0.6).area);
  assert.equal(getSampleAreaPath([], 5, 1), '');
});

test('processed comparison uses the same render for layers, noise, and the final output', async () => {
  const patch = createLoadedPatch();
  patch.noise.enabled = true;
  patch.noise.mute = false;
  patch.noise.gain = 0.3;
  const { comparison } = await renderWaveformPreview(patch, { kick: sample });
  const { final, preMaster, layers, noise } = comparison;
  assert.equal(final.transient.length, 4410);
  assert.ok(layers[0].transient.some((value) => Math.abs(value) > 0.001));
  assert.ok(noise.transient.some((value) => Math.abs(value) > 0.001));
  assert.ok(layers[1].transient.every((value) => value === 0));
  for (let index = 0; index < final.transient.length; index += 1) {
    const sum = layers.reduce((value, layer) => value + layer.transient[index], noise.transient[index]);
    assert.ok(Math.abs(preMaster.transient[index] - sum) < 1e-5);
  }
});

test('comparison preserves cancellation and respects solo and master processing', async () => {
  const patch = createLoadedPatch();
  Object.assign(patch.layers[1], { ...patch.layers[0], sampleKey: 'inverse' });
  const buffers = { kick: sample, inverse: Float32Array.from(sample, (value) => -value) };
  const cancelled = await renderWaveformPreview(patch, buffers);
  assert.ok(cancelled.comparison.layers[0].transient.some((value) => Math.abs(value) > 0.01));
  assert.ok(cancelled.comparison.layers[1].transient.some((value) => Math.abs(value) > 0.01));
  assert.ok(cancelled.comparison.preMaster.transient.every((value) => Math.abs(value) < 1e-6));

  patch.layers[0].solo = true;
  patch.master.drive = 18;
  const soloed = await renderWaveformPreview(patch, buffers);
  assert.ok(soloed.comparison.layers[1].transient.every((value) => value === 0));
  assert.ok(soloed.comparison.final.transient.some((value, index) =>
    Math.abs(value - soloed.comparison.preMaster.transient[index]) > 0.01
  ));
});

test('processed channel lanes preserve relative playback delay', async () => {
  const patch = createLoadedPatch();
  Object.assign(patch.layers[1], { ...patch.layers[0], delayMs: 60 });
  const { comparison } = await renderWaveformPreview(patch, { kick: sample });
  const early = comparison.layers.map((lane) => lane.transient.slice(882, 1764));
  const later = comparison.layers[1].transient.slice(3087, 3969);

  assert.ok(early[0].some((value) => Math.abs(value) > 0.01));
  assert.ok(early[1].every((value) => value === 0));
  assert.ok(later.some((value) => Math.abs(value) > 0.01));
});

test('preview and WAV match a settled live-like renderer', async () => {
  const patch = createLoadedPatch();
  patch.layers[0].hp = 500;
  patch.layers[0].clipDrive = 8;
  patch.master.drive = 6;
  Object.assign(patch.master, {
    ringModEnabled: true, ringModFrequency: 350, ringModMix: 0.7,
    ringModPhase: 90, ringModBias: 0.2, ringModRectify: 0.5
  });
  const buffers = { kick: sample };
  const preview = await renderWaveformPreview(patch, buffers);
  const renderer = new OfflineRenderer();
  await renderer.initialize({
    numInputChannels: 0, numOutputChannels: 2, sampleRate: SAMPLE_RATE,
    blockSize: 128, virtualFileSystem: buffers
  });
  const state = { ...patch, gate: 1, velocity: 1 };
  await renderer.render(...buildDrumGraph({ ...state, gate: 0 }));
  const warmupLength = Math.ceil((SAMPLE_RATE * 0.5) / 128) * 128;
  renderer.process([], [new Float32Array(warmupLength), new Float32Array(warmupLength)]);
  await renderer.render(...buildDrumGraph(state));
  const left = new Float32Array(4410);
  const right = new Float32Array(4410);
  renderer.process([], [left.subarray(0, 1280), right.subarray(0, 1280)]);
  await renderer.render(...buildDrumGraph({ ...state, gate: 0 }));
  renderer.process([], [left.subarray(1280), right.subarray(1280)]);
  const wav = new DataView(await (await renderWavBlob(patch, buffers)).arrayBuffer());
  for (let index = 0; index < left.length; index += 1) {
    assert.ok(Math.abs(left[index] - preview.comparison.final.transient[index]) < 1e-6);
    const offset = 44 + index * 6;
    let pcm = wav.getUint8(offset) | (wav.getUint8(offset + 1) << 8) | (wav.getUint8(offset + 2) << 16);
    if (pcm & 0x800000) pcm -= 0x1000000;
    assert.ok(Math.abs(pcm / 0x800000 - Math.max(-1, Math.min(1, left[index]))) < 2e-7);
  }
});

test('glue knee and dry/wet shape compression and persist', async () => {
  const render = async (config) => {
    const renderer = new OfflineRenderer();
    await renderer.initialize({ numInputChannels: 0, numOutputChannels: 2, sampleRate: SAMPLE_RATE, blockSize: 128 });
    await renderer.render(...glueCompressor(el.const({ value: 0.25 }), el.const({ value: 0.25 }), config));
    const outputs = [new Float32Array(SAMPLE_RATE), new Float32Array(SAMPLE_RATE)];
    renderer.process([], outputs);
    return outputs[0].at(-1);
  };
  const base = { glueThreshold: -12, glueRatio: 4, glueAttack: 0.01, glueRelease: 0.12 };
  const hard = await render({ ...base, glueKnee: 0 });
  const soft = await render({ ...base, glueKnee: 24 });
  const wet = await render({ ...base, glueKnee: 6, glueMix: 1 });
  const half = await render({ ...base, glueKnee: 6, glueMix: 0.5 });
  const dry = await render({ ...base, glueKnee: 6, glueMix: 0 });
  assert.ok(Number.isFinite(hard) && Math.abs(hard - 0.25) < 1e-4);
  assert.ok(soft < hard);
  assert.ok(Math.abs(dry - 0.25) < 1e-5);
  assert.ok(wet < half && half < dry);

  const state = createDefaultState();
  assert.equal(state.master.glueKnee, 6);
  assert.equal(state.master.glueMix, 1);
  state.master.glueKnee = 12;
  state.master.glueMix = 0.4;
  const restored = restorePatchState(serializePatchState(state));
  assert.equal(restored.master.glueKnee, 12);
  assert.equal(restored.master.glueMix, 0.4);
  const clamped = restorePatchState({ master: { glueKnee: 99, glueMix: -1 } });
  assert.equal(clamped.master.glueKnee, 24);
  assert.equal(clamped.master.glueMix, 0);
});

test('noise controls accept the extended ranges', () => {
  const noise = restorePatchState({
    noise: { cutoff: 20, q: 30, decay: 3, clipDrive: 36, gain: 2 }
  }).noise;
  assert.deepEqual(
    [noise.cutoff, noise.q, noise.decay, noise.clipDrive, noise.gain],
    [20, 30, 3, 36, 2]
  );
  const over = restorePatchState({ noise: { cutoff: 99999, q: 99, decay: 99, clipDrive: 99, gain: 9 } }).noise;
  assert.deepEqual(
    [over.cutoff, over.q, over.decay, over.clipDrive, over.gain],
    [20000, 30, 3, 36, 2]
  );
});

test('noise decay is not cut short by the trigger gate', async () => {
  const patch = createDefaultState();
  patch.noise.enabled = true;
  patch.noise.decay = 1;
  patch.noise.gain = 1;
  const { comparison } = await renderWaveformPreview(patch, {});
  const { min, max } = comparison.noise;
  const peakAt = (from, to) => {
    let peak = 0;
    for (let index = Math.floor(from * max.length); index < Math.ceil(to * max.length); index += 1) {
      peak = Math.max(peak, Math.abs(min[index]), Math.abs(max[index]));
    }
    return peak;
  };
  assert.ok(peakAt(0.3, 0.4) > 0.001);
  assert.ok(peakAt(0.3, 0.4) < peakAt(0, 0.05));
  assert.ok(peakAt(0.99, 1) < 0.001);
});

test('module knob reset restores defaults but keeps enable state and order', () => {
  const state = createDefaultState();
  state.master.busOrder = ['glue', 'noise', 'saturation'];
  state.master.saturationEnabled = true;
  state.master.saturationMute = true;
  state.master.saturationDrive = 0.9;
  state.noise.enabled = true;
  state.noise.cutoff = 123;
  const defaults = createDefaultState();

  const saturation = resetBusModuleKnobs(state, 'saturation');
  assert.equal(saturation.master.saturationDrive, defaults.master.saturationDrive);
  assert.equal(saturation.master.saturationEnabled, true);
  assert.equal(saturation.master.saturationMute, true);
  assert.deepEqual(saturation.master.busOrder, ['glue', 'noise', 'saturation']);

  const noise = resetBusModuleKnobs(state, 'noise');
  assert.equal(noise.noise.cutoff, defaults.noise.cutoff);
  assert.equal(noise.noise.enabled, true);
});

test('hit peak tracker holds the loudest value until a new hit starts', () => {
  const tracker = createHitPeakTracker([0.001]);
  tracker.update([0.2], 0);
  assert.deepEqual(tracker.update([0.5], 50), [0.5]);
  assert.deepEqual(tracker.update([0], 200), [0.5]);
  assert.deepEqual(tracker.update([0.3], 1000), [0.3]);
});
