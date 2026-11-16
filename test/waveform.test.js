import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import OfflineRenderer from '@elemaudio/offline-renderer';
import { el } from '@elemaudio/core';
import { buildDrumGraph } from '../dsp/engine.js';
import { glueCompressor, saturator } from '../dsp/nodes.js';
import { getEnvelopeSequence, getEnvelopeValueAt } from '../dsp/envelope.js';
import {
  createDefaultState,
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
  getLayerPreviewWaveform,
  getPhaseOffset,
  getLayerPlaybackInfo,
  getLayerSumPeaks,
  getTrimmedPreviewRange,
  getZoomedPreviewRange,
  getSampleAreaPath,
  getWaveformFitGain,
  getWaveformPaths,
  mapOutputWaveformToSource,
  mergeStereoWaveform
} from '../src/audio/waveform.js';
import { renderWavBlob, renderWaveformPreview } from '../src/audio/wavExport.js';
import { LiveComparisonTrace, LiveTrace, reduceComparisonResolution, reduceWaveformResolution } from '../src/audio/liveTrace.js';

const SAMPLE_RATE = 44100;
const sample = Float32Array.from(
  { length: SAMPLE_RATE },
  (_, index) => 0.5 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE)
);

test('waveform viewer switches to the trace and shows source and output time axes', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  try {
    const { default: App, AboutDialog, getVisibleWavDragBounds, observeNativeEditorHeight } = await server.ssrLoadModule('/src/App.jsx');
    const app = renderToStaticMarkup(React.createElement(App));
    assert.match(app, /aria-label="Enable noise synth" aria-pressed="false"/);
    assert.doesNotMatch(app, /aria-label="Open noise waveform editor"/);
    assert.match(app, /aria-label="Enable master saturation" aria-pressed="false"[^>]*>OFF · ENABLE/);
    assert.match(app, /aria-label="Enable glue compressor" aria-pressed="false"[^>]*>OFF · ENABLE/);
    assert.match(app, /aria-label="Noise synth settings" aria-haspopup="dialog" disabled/);
    assert.match(app, /aria-label="Saturation settings" aria-haspopup="dialog"/);
    assert.match(app, /aria-label="Glue compressor settings" aria-haspopup="dialog"/);
    assert.doesNotMatch(app, /aria-label="(?:SAT DRIVE|THRESH):/);
    for (let index = 1; index <= 3; index += 1) {
      assert.match(app, new RegExp(`aria-label="Minimize channel ${index}" aria-expanded="true"`));
      assert.match(app, new RegExp(`aria-label="Show all additional controls for channel ${index}" aria-expanded="false"`));
      assert.match(app, new RegExp(`aria-label="Reset knobs for channel ${index}"`));
      assert.match(app, new RegExp(`aria-label="Load sample for CH 0${index}"`));
      assert.match(app, new RegExp(`aria-label="CH 0${index} clip gain"`));
      assert.match(app, new RegExp(`aria-label="CH 0${index} clip gain exact value in dB"`));
    }
    assert.doesNotMatch(app, /channel-extra-controls/);
    const { ChannelStrip } = await server.ssrLoadModule('/src/components/ChannelStrip.jsx');
    const { LayerForgeBridge } = await server.ssrLoadModule('/src/audio/bridge.js');
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
    const savedStereo = createDefaultState();
    Object.assign(savedStereo.layers[0], loaded, { loaded: true });
    const restoredStereo = restorePatchState(serializePatchState(savedStereo), bridge.vfsBuffers);
    assert.equal(restoredStereo.layers[0].sampleRightKey, loaded.sampleRightKey);
    assert.throws(() => restorePatchState(serializePatchState(savedStereo), {
      [loaded.sampleKey]: leftSample
    }), /Stereo sample data.*missing/);
    const changedLayer = { ...createDefaultState().layers[0], hp: 100, phaseOffset: 0.01 };
    const changedChannel = renderToStaticMarkup(React.createElement(ChannelStrip, {
      index: 0, layer: changedLayer, sampleBuffers: {}, sampleRates: {}, onChange: () => {}
    }));
    assert.match(changedChannel, /aria-label="HPF: 100Hz/);
    assert.match(changedChannel, /aria-label="PHASE: 0\.0100/);
    assert.doesNotMatch(changedChannel, /aria-label="PLAY DLY:/);
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
    assert.match(noisePreview, /aria-label="Reset noise gain envelope"/);
    assert.doesNotMatch(noisePreview, /aria-label="Open noise waveform editor"/);
    assert.equal(waveformPath(noiseDuringTrace), waveformPath(noisePreview));
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
    assert.match(app, /aria-pressed="true"[^>]*>TRACE ARMED/);
    assert.match(app, /aria-label="Post-master output peak"[^>]*aria-valuemin="-60"[^>]*aria-valuemax="0"/);
    assert.doesNotMatch(app, /aria-label="Output meter scale"/);
    assert.match(app, /RENDERING/);
    assert.doesNotMatch(app, /LIVE ESTIMATE/);
    const about = renderToStaticMarkup(React.createElement(AboutDialog, { onClose: () => {} }));
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(about.includes(`Version ${version}`));
    assert.match(about, /href="https:\/\/github\.com\/ultimumdesign\/LayerForge"/);
    assert.match(about, /role="dialog"/);
    const { HelpEnabledContext, HelpTip } = await server.ssrLoadModule('/src/components/HelpTip.jsx');
    const help = React.createElement(HelpTip, { text: 'Helpful text' }, 'CONTROL');
    assert.match(renderToStaticMarkup(help), /role="tooltip"[^>]*>Helpful text/);
    assert.doesNotMatch(renderToStaticMarkup(help), /<button/);
    const disabledHelp = renderToStaticMarkup(React.createElement(HelpEnabledContext.Provider, { value: false }, help));
    assert.equal(disabledHelp, 'CONTROL');

    assert.deepEqual(
      getVisibleWavDragBounds({ left: 20, top: -5, right: 90, bottom: 25 }, 100, 100),
      { x: 20, y: 0, width: 70, height: 25 }
    );
    assert.deepEqual(
      getVisibleWavDragBounds({ left: 80, top: 90, right: 120, bottom: 110 }, 100, 100),
      { x: 80, y: 90, width: 20, height: 10 }
    );
    assert.equal(getVisibleWavDragBounds({ left: 0, top: -40, right: 50, bottom: -1 }, 100, 100), null);

    const previousWindow = globalThis.window;
    const previousObserver = globalThis.ResizeObserver;
    let scheduled;
    let resized;
    let observed;
    let disconnected = false;
    let height = 571.2;
    const reported = [];
    try {
      globalThis.window = {
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
      const stop = observeNativeEditorHeight({ getBoundingClientRect: () => ({ height }) }, (value) => reported.push(value));
      scheduled();
      height = 715.2;
      observed();
      scheduled();
      observed();
      scheduled();
      resized();
      scheduled();
      assert.deepEqual(reported, [572, 716, 716]);
      stop();
      assert.equal(disconnected, true);
      assert.equal(resized, null);
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousObserver === undefined) delete globalThis.ResizeObserver;
      else globalThis.ResizeObserver = previousObserver;
    }

    const { WaveformViewer } = await server.ssrLoadModule('/src/components/WaveformViewer.jsx');
    const props = {
      title: 'LAYER SUM', compact: true, previewStatus: 'DSP RENDER', durationOverride: 1,
      peaksOverride: [0.25], fitAmplitude: true, traceEnabled: true,
      onFitAmplitudeChange: () => {}, onTraceEnabledChange: () => {}
    };
    const trace = { min: [-0.1], max: [0.1], capturedSec: 0.5, status: 'CAPTURING' };
    const render = (overrides) => renderToStaticMarkup(React.createElement(WaveformViewer, { ...props, ...overrides }));
    const live = render({ liveTrace: trace });
    assert.match(live, /class="waveform-live-trace"/);
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
      title: 'MIX LAB', compact: true, zoom: 2, durationOverride: 1, playbackId: 1,
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

    const { SumComparison } = await server.ssrLoadModule('/src/components/LayerSumViewer.jsx');
    const { UI_THEMES } = await server.ssrLoadModule('/src/uiThemes.js');
    const waveform = { min: [-0.5], max: [0.5], transient: [0.5, -0.5] };
    const patch = createDefaultState();
    const comparison = { final: waveform, preMaster: waveform, layers: patch.layers.map(() => waveform), noise: waveform, sampleRate: 1000 };
    const liveComparison = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, capturedSec: 0.25, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: 0, live: true
    }));
    assert.match(liveComparison, /LIVE TRACE · FULL HIT/);
    assert.match(liveComparison, /aria-label="CH 03 waveform"/);
    assert.match(liveComparison, /L127\.5,/);
    const transientComparison = renderToStaticMarkup(React.createElement(SumComparison, {
      comparison, durationSec: 1, capturedSec: 0.25, layers: patch.layers,
      noise: patch.noise, theme: UI_THEMES[0], windowMs: 5, live: true
    }));
    assert.match(transientComparison, /LIVE TRACE · SAMPLE-LEVEL · FIRST 5 MS/);
    assert.match(transientComparison, /class="sum-comparison-fill"/);
    assert.match(transientComparison, /Comparison output time in milliseconds/);
  } finally {
    await server.close();
  }
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
    numInputChannels: 0, numOutputChannels: 13, sampleRate: SAMPLE_RATE, blockSize: 128,
    virtualFileSystem: { left, right }
  });
  const render = async (gate, length) => {
    await renderer.render(...buildDrumGraph({ ...state, gate }, true));
    const outputs = Array.from({ length: 13 }, () => new Float32Array(length));
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
    numInputChannels: 0, numOutputChannels: 13, sampleRate: SAMPLE_RATE, blockSize: 128,
    virtualFileSystem: { left, right }
  });
  await coldRenderer.render(...buildDrumGraph({ ...state, gate: 1 }, true));
  const cold = Array.from({ length: 13 }, () => new Float32Array(128));
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
    numInputChannels: 0, numOutputChannels: 13, sampleRate: SAMPLE_RATE, blockSize: 128,
    virtualFileSystem: { kick: samples }
  });
  const render = async (gate, length) => {
    await renderer.render(...buildDrumGraph({ ...state, gate }, true));
    const outputs = Array.from({ length: 13 }, () => new Float32Array(length));
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
    ['glue', 'saturation', 'noise']);
  assert.deepEqual(restorePatchState({ master: { busOrder: ['noise', 'noise', 'glue'] } }).master.busOrder,
    ['noise', 'saturation', 'glue']);
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
  assert.equal(shortRange.end, 0.1);
  assert.deepEqual(getTrimmedPreviewRange(0.5, 1), { start: 0.5, end: 1 });
  assert.deepEqual(getTrimmedPreviewRange(0, 1), { start: 0, end: 1 });
  const nearEdge = getTrimmedPreviewRange(0.02, 0.5);
  assert.ok(Math.abs((nearEdge.start + nearEdge.end) / 2 - 0.26) < 1e-12);
});

test('source zoom stays centered on the fitted trim without changing the selection', () => {
  const range = getTrimmedPreviewRange(0.25, 0.75);
  const zoomed = getZoomedPreviewRange(range, 2);
  assert.ok(Math.abs(zoomed.start - 0.35) < 1e-12);
  assert.ok(Math.abs(zoomed.end - 0.65) < 1e-12);
  assert.deepEqual(getZoomedPreviewRange({ start: 0, end: 1 }, 1), { start: 0, end: 1 });
  const nearStart = getZoomedPreviewRange(getTrimmedPreviewRange(0, 0.1), 2);
  assert.ok(Math.abs(nearStart.start - 0.025) < 1e-12);
  assert.ok(Math.abs(nearStart.end - 0.075) < 1e-12);
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
    const output = [new Float32Array(128), new Float32Array(128)];
    monitor.process([[left, right, gate, ...lanes]], [output]);
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
      numInputChannels: 0, numOutputChannels: monitor ? 13 : 2, sampleRate: SAMPLE_RATE,
      blockSize: 128, virtualFileSystem: { kick: sample }
    });
    await renderer.render(...buildDrumGraph({ ...patch, gate: 1, velocity: 1 }, monitor));
    const outputs = Array.from({ length: monitor ? 13 : 2 }, () => new Float32Array(4096));
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
