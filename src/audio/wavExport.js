import OfflineRenderer from '@elemaudio/offline-renderer';
import { buildDrumGraph, buildDrumPreviewGraph } from '../../dsp/engine.js';
import { getSamplePhaseShift, getSampleTrimRange } from '../../dsp/parameters.js';
import { DEFAULT_WAVEFORM_BIN_COUNT } from './waveform.js';
import { createBuiltinImpulses, getBuiltinImpulseDuration } from '../../dsp/convolution.js';

const SAMPLE_RATE = 44100;
const BLOCK_SIZE = 128;
const WARMUP_SAMPLES = Math.ceil((SAMPLE_RATE * 0.5) / BLOCK_SIZE) * BLOCK_SIZE;

export function getPatchDurationSec(state, vfsBuffers) {
  const hasSolo = state.layers.some((layer) => layer.solo) || (state.noise.enabled && state.noise.solo);
  const layerDurations = state.layers.map((layer) => {
    const samples = layer.sampleKey ? vfsBuffers[layer.sampleKey] : null;
    if (
      !layer.loaded ||
      !samples?.length ||
      layer.mute ||
      (hasSolo && !layer.solo)
    ) {
      return 0;
    }

    const playbackRate = Math.pow(2, layer.pitch / 12);
    const trimRange = getSampleTrimRange(samples.length, layer.trimStart, layer.trimEnd);
    const phase = getSamplePhaseShift(trimRange.sampleCount, layer.phaseOffset);
    const sampleDuration = (trimRange.sampleCount - phase.advanceSamples) /
      ((layer.sampleRate || SAMPLE_RATE) * playbackRate);
    const phaseDelay = phase.delaySamples / ((layer.sampleRate || SAMPLE_RATE) * playbackRate);
    return Math.max(0, layer.delayMs) / 1000 + phaseDelay + sampleDuration;
  });
  const noiseAudible =
    state.noise.enabled && !state.noise.mute &&
    state.noise.gain > 0.0005 &&
    (!hasSolo || state.noise.solo);
  const noiseDuration = noiseAudible ? Math.max(0, state.noise.delayMs ?? 0) / 1000 + state.noise.decay + 0.02 : 0;
  const tail = state.master.convolveEnabled && !state.master.convolveMute && state.master.convolveMix > 0
    ? getBuiltinImpulseDuration(state.master.convolveProfile) + state.master.convolvePredelay / 1000 : 0;
  return Math.max(0.12, ...layerDurations, noiseDuration) + tail + 0.02;
}

function getChannelPreviewDurationSec(layer, vfsBuffers) {
  const samples = layer.sampleKey ? vfsBuffers[layer.sampleKey] : null;
  if (!layer.loaded || !samples?.length) return 0.12;
  const playbackRate = Math.pow(2, layer.pitch / 12);
  const trimRange = getSampleTrimRange(samples.length, layer.trimStart, layer.trimEnd);
  const phase = getSamplePhaseShift(trimRange.sampleCount, layer.phaseOffset);
  const sampleDuration = (trimRange.sampleCount - phase.advanceSamples) /
    ((layer.sampleRate || SAMPLE_RATE) * playbackRate);
  const phaseDelay = phase.delaySamples / ((layer.sampleRate || SAMPLE_RATE) * playbackRate);
  return Math.max(0.12, Math.max(0, layer.delayMs) / 1000 + phaseDelay + sampleDuration);
}

async function initializeRenderer(vfsBuffers, numOutputChannels = 2) {
  const offline = new OfflineRenderer();
  await offline.initialize({
    numInputChannels: 0,
    numOutputChannels,
    sampleRate: SAMPLE_RATE,
    blockSize: BLOCK_SIZE,
    virtualFileSystem: { ...vfsBuffers, ...createBuiltinImpulses() }
  });
  return offline;
}

async function warmRenderer(offline, state, buildGraph, channelCount) {
  await offline.render(...buildGraph({ ...state, gate: 0, velocity: 1 }));
  const outputs = Array.from({ length: channelCount }, () => new Float32Array(BLOCK_SIZE));
  for (let offset = 0; offset < WARMUP_SAMPLES; offset += BLOCK_SIZE) {
    offline.process([], outputs);
  }
}

/**
 * Renders the active layered drum patch offline to a 24-bit / 44.1kHz stereo WAV file.
 */
export async function renderWavBlob(state, vfsBuffers) {
  const sampleRate = SAMPLE_RATE;
  const gateSamples = Math.ceil((sampleRate * 0.028) / BLOCK_SIZE) * BLOCK_SIZE;
  const durationSec = getPatchDurationSec(state, vfsBuffers);
  const totalSamples = Math.floor(sampleRate * durationSec);
  const offline = await initializeRenderer(vfsBuffers);
  await warmRenderer(offline, state, buildDrumGraph, 2);

  const renderState = {
    ...state,
    gate: 1,
    velocity: 1.0
  };

  const [leftNode, rightNode] = buildDrumGraph(renderState);
  await offline.render(leftNode, rightNode);

  const leftOut = new Float32Array(totalSamples);
  const rightOut = new Float32Array(totalSamples);
  offline.process([], [
    leftOut.subarray(0, gateSamples),
    rightOut.subarray(0, gateSamples)
  ]);
  const [leftReleaseNode, rightReleaseNode] = buildDrumGraph({
    ...renderState,
    gate: 0
  });
  await offline.render(leftReleaseNode, rightReleaseNode);
  offline.process([], [
    leftOut.subarray(gateSamples),
    rightOut.subarray(gateSamples)
  ]);

  // Trim trailing silence below -80dB (keeping minimum 120ms tail)
  const minSamples = Math.floor(sampleRate * 0.12);
  let endSample = totalSamples;
  for (let i = totalSamples - 1; i >= minSamples; i--) {
    if (Math.abs(leftOut[i]) > 0.0001 || Math.abs(rightOut[i]) > 0.0001) {
      endSample = Math.min(totalSamples, i + 441); // 10ms fade-out margin
      break;
    }
  }

  const trimmedLeft = leftOut.subarray(0, endSample);
  const trimmedRight = rightOut.subarray(0, endSample);

  return encodeWav24Bit(trimmedLeft, trimmedRight, sampleRate);
}

export async function renderWaveformPreview(
  state,
  vfsBuffers,
  barCount = DEFAULT_WAVEFORM_BIN_COUNT
) {
  const durationSec = getPatchDurationSec(state, vfsBuffers);
  const totalSamples = Math.floor(SAMPLE_RATE * durationSec);
  const gateSamples = Math.ceil((SAMPLE_RATE * 0.028) / BLOCK_SIZE) * BLOCK_SIZE;
  const channelCount = (state.layers.length + 3) * 2;
  const offline = await initializeRenderer(vfsBuffers, channelCount);
  await warmRenderer(offline, state, buildDrumPreviewGraph, channelCount);
  const renderState = { ...state, gate: 1, velocity: 1 };
  await offline.render(...buildDrumPreviewGraph(renderState));

  const transientSampleCount = Math.min(totalSamples, Math.floor(SAMPLE_RATE * 0.1));
  const waveforms = Array.from({ length: channelCount / 2 }, () => {
    const min = new Float32Array(barCount);
    const max = new Float32Array(barCount);
    min.fill(Infinity);
    max.fill(-Infinity);
    return {
      min, max,
      transient: new Float32Array(transientSampleCount),
      transientMax: new Float32Array(transientSampleCount)
    };
  });
  const channelDurations = state.layers.map((layer) => getChannelPreviewDurationSec(layer, vfsBuffers));
  const channelWaveforms = channelDurations.map(() => {
    const min = new Float32Array(barCount);
    const max = new Float32Array(barCount);
    min.fill(Infinity);
    max.fill(-Infinity);
    return {
      min,
      max,
      transient: new Float32Array(transientSampleCount),
      transientMax: new Float32Array(transientSampleCount)
    };
  });

  const processRange = (startSample, length) => {
    const chunkSize = 4096;
    let offset = 0;
    while (offset < length) {
      const size = Math.min(chunkSize, length - offset);
      const output = Array.from({ length: channelCount }, () => new Float32Array(size));
      offline.process([], output);
      for (let index = 0; index < size; index += 1) {
        const absoluteIndex = startSample + offset + index;
        const bar = Math.min(barCount - 1, Math.floor((absoluteIndex * barCount) / totalSamples));
        for (let channel = 0; channel < waveforms.length; channel += 1) {
          const left = output[channel * 2][index];
          const right = output[channel * 2 + 1][index];
          const waveform = waveforms[channel];
          waveform.min[bar] = Math.min(waveform.min[bar], left, right);
          waveform.max[bar] = Math.max(waveform.max[bar], left, right);
          if (absoluteIndex < transientSampleCount) {
            waveform.transient[absoluteIndex] = left;
            waveform.transientMax[absoluteIndex] = right;
          }
        }
        for (let channel = 0; channel < channelWaveforms.length; channel += 1) {
          const duration = channelDurations[channel];
          const time = absoluteIndex / SAMPLE_RATE;
          if (time >= duration) continue;
          const laneBar = Math.min(barCount - 1, Math.floor((time * barCount) / duration));
          const left = output[2 + channel * 2][index];
          const right = output[3 + channel * 2][index];
          const waveform = channelWaveforms[channel];
          waveform.min[laneBar] = Math.min(waveform.min[laneBar], left, right);
          waveform.max[laneBar] = Math.max(waveform.max[laneBar], left, right);
          if (absoluteIndex < transientSampleCount) {
            waveform.transient[absoluteIndex] = left;
            waveform.transientMax[absoluteIndex] = right;
          }
        }
      }
      offset += size;
    }
  };

  processRange(0, gateSamples);
  await offline.render(...buildDrumPreviewGraph({ ...renderState, gate: 0 }));
  processRange(gateSamples, Math.max(0, totalSamples - gateSamples));

  for (const waveform of waveforms) {
    for (let index = 0; index < barCount; index += 1) {
      if (!Number.isFinite(waveform.min[index])) waveform.min[index] = 0;
      if (!Number.isFinite(waveform.max[index])) waveform.max[index] = 0;
    }
  }
  for (const waveform of channelWaveforms) {
    for (let index = 0; index < barCount; index += 1) {
      if (!Number.isFinite(waveform.min[index])) waveform.min[index] = 0;
      if (!Number.isFinite(waveform.max[index])) waveform.max[index] = 0;
    }
  }

  const [final, ...remaining] = waveforms;
  const preMaster = remaining.pop();
  const noise = remaining.pop();
  const peaks = Array.from(final.min, (value, index) =>
    Math.max(Math.abs(value), Math.abs(final.max[index]))
  );

  return {
    peaks,
    durationSec,
    stereoWaveform: {
      leftMin: final.min,
      leftMax: final.max,
      rightMin: final.min,
      rightMax: final.max
    },
    comparison: {
      final, layers: remaining, channelPreviews: channelWaveforms, layerDurations: channelDurations,
      noise, preMaster, sampleRate: SAMPLE_RATE
    }
  };
}

export function downloadWav(wavBlob, filename) {
  const url = URL.createObjectURL(wavBlob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function encodeWav24Bit(left, right, sampleRate) {
  const numChannels = 2;
  const bytesPerSample = 3; // 24-bit PCM
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = left.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 24, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < left.length; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const sample = ch === 0 ? left[i] : right[i];
      const clamped = Math.max(-1, Math.min(1, sample));
      const intVal = clamped < 0 ? Math.round(clamped * 0x800000) : Math.round(clamped * 0x7fffff);
      view.setUint8(offset, intVal & 0xff);
      view.setUint8(offset + 1, (intVal >> 8) & 0xff);
      view.setUint8(offset + 2, (intVal >> 16) & 0xff);
      offset += 3;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
