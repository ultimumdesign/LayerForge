import OfflineRenderer from '@elemaudio/offline-renderer';
import { buildDrumGraph } from '@dsp/engine.js';

/**
 * Renders the active layered drum patch offline to a 24-bit / 44.1kHz stereo WAV file.
 */
export async function renderWavBlob(state, vfsBuffers) {
  const sampleRate = 44100;
  const durationSec = 1.5;
  const totalSamples = Math.floor(sampleRate * durationSec);

  const offline = new OfflineRenderer();
  await offline.initialize({
    numInputChannels: 0,
    numOutputChannels: 2,
    sampleRate,
    blockSize: 512,
    virtualFileSystem: vfsBuffers
  });

  const renderState = {
    ...state,
    gate: 1,
    velocity: 1.0
  };

  const [leftNode, rightNode] = buildDrumGraph(renderState);
  await offline.render(leftNode, rightNode);

  const leftOut = new Float32Array(totalSamples);
  const rightOut = new Float32Array(totalSamples);
  offline.process([], [leftOut, rightOut]);

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
