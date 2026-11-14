import OfflineRenderer from '@elemaudio/offline-renderer';
import { buildDrumGraph } from '../../dsp/engine.js';
import { getSampleTrimRange } from '../../dsp/parameters.js';

const SAMPLE_RATE = 44100;
const BLOCK_SIZE = 128;

function getPatchDurationSec(state, vfsBuffers) {
  const hasSolo = state.layers.some((layer) => layer.solo) || state.noise.solo;
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
    const sampleDuration =
      trimRange.sampleCount / ((layer.sampleRate || SAMPLE_RATE) * playbackRate);
    return Math.max(0, layer.delayMs) / 1000 + sampleDuration;
  });
  const noiseAudible =
    !state.noise.mute &&
    state.noise.gain > 0.0005 &&
    (!hasSolo || state.noise.solo);
  return Math.max(0.12, ...layerDurations, noiseAudible ? state.noise.decay + 0.02 : 0) + 0.02;
}

async function initializeRenderer(vfsBuffers) {
  const offline = new OfflineRenderer();
  await offline.initialize({
    numInputChannels: 0,
    numOutputChannels: 2,
    sampleRate: SAMPLE_RATE,
    blockSize: BLOCK_SIZE,
    virtualFileSystem: vfsBuffers
  });
  return offline;
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

export async function renderWaveformPreview(state, vfsBuffers, barCount = 176) {
  const durationSec = getPatchDurationSec(state, vfsBuffers);
  const totalSamples = Math.floor(SAMPLE_RATE * durationSec);
  const gateSamples = Math.ceil((SAMPLE_RATE * 0.028) / BLOCK_SIZE) * BLOCK_SIZE;
  const offline = await initializeRenderer(vfsBuffers);
  const renderState = { ...state, gate: 1, velocity: 1 };
  const [leftNode, rightNode] = buildDrumGraph(renderState);
  await offline.render(leftNode, rightNode);

  const peaks = new Float32Array(barCount);
  const leftMin = new Float32Array(barCount);
  const leftMax = new Float32Array(barCount);
  const rightMin = new Float32Array(barCount);
  const rightMax = new Float32Array(barCount);
  leftMin.fill(Infinity);
  rightMin.fill(Infinity);
  leftMax.fill(-Infinity);
  rightMax.fill(-Infinity);

  const processRange = (startSample, length) => {
    const chunkSize = 4096;
    let offset = 0;
    while (offset < length) {
      const size = Math.min(chunkSize, length - offset);
      const left = new Float32Array(size);
      const right = new Float32Array(size);
      offline.process([], [left, right]);
      for (let index = 0; index < size; index += 1) {
        const absoluteIndex = startSample + offset + index;
        const bar = Math.min(barCount - 1, Math.floor((absoluteIndex * barCount) / totalSamples));
        const leftSample = left[index];
        const rightSample = right[index];
        peaks[bar] = Math.max(peaks[bar], Math.abs(leftSample), Math.abs(rightSample));
        leftMin[bar] = Math.min(leftMin[bar], leftSample);
        leftMax[bar] = Math.max(leftMax[bar], leftSample);
        rightMin[bar] = Math.min(rightMin[bar], rightSample);
        rightMax[bar] = Math.max(rightMax[bar], rightSample);
      }
      offset += size;
    }
  };

  processRange(0, gateSamples);
  const [leftReleaseNode, rightReleaseNode] = buildDrumGraph({ ...renderState, gate: 0 });
  await offline.render(leftReleaseNode, rightReleaseNode);
  processRange(gateSamples, Math.max(0, totalSamples - gateSamples));

  for (let index = 0; index < barCount; index += 1) {
    if (!Number.isFinite(leftMin[index])) leftMin[index] = 0;
    if (!Number.isFinite(leftMax[index])) leftMax[index] = 0;
    if (!Number.isFinite(rightMin[index])) rightMin[index] = 0;
    if (!Number.isFinite(rightMax[index])) rightMax[index] = 0;
  }

  return {
    peaks: Array.from(peaks),
    durationSec,
    stereoWaveform: { leftMin, leftMax, rightMin, rightMax }
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
