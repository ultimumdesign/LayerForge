import { getSamplePhaseShift, getSampleTrimRange, MIN_TRIM_RANGE } from '../../dsp/parameters.js';
import { getEnvelopeValueAt } from '../../dsp/envelope.js';

export { getEnvelopeValueAt } from '../../dsp/envelope.js';

export const DEFAULT_WAVEFORM_BIN_COUNT = 512;
const WAVEFORM_CENTER_Y = 58;
const WAVEFORM_AMPLITUDE_HEIGHT = 47;
const ENVELOPE_BOTTOM_Y = 101;
const ENVELOPE_HEIGHT = 90;
const layerWaveformCache = new WeakMap();

export function getDefaultSampleTrim(samples, sampleRate, rightSamples = samples) {
  if (!samples?.length) return { trimStart: 0, trimEnd: 1 };
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index]), Math.abs(rightSamples[index]));
  }
  if (peak === 0) return { trimStart: 0, trimEnd: 1 };

  const threshold = peak * 0.001;
  let first = 0;
  let end = samples.length;
  while (first < end && Math.abs(samples[first]) <= threshold && Math.abs(rightSamples[first]) <= threshold) first += 1;
  while (end > first && Math.abs(samples[end - 1]) <= threshold && Math.abs(rightSamples[end - 1]) <= threshold) end -= 1;

  let startSample = Math.max(0, first - Math.ceil(sampleRate * 0.005));
  let endSample = Math.min(samples.length, end + Math.ceil(sampleRate * 0.02));
  const minimumLength = Math.ceil(samples.length * MIN_TRIM_RANGE);
  endSample = Math.min(samples.length, Math.max(endSample, startSample + minimumLength));
  startSample = Math.max(0, Math.min(startSample, endSample - minimumLength));
  return { trimStart: startSample / samples.length, trimEnd: endSample / samples.length };
}

export function getEnvelopeDisplayY(value) {
  return ENVELOPE_BOTTOM_Y - value * ENVELOPE_HEIGHT;
}

export function getEnvelopeDisplayValue(y) {
  return Math.max(0, Math.min(1, (ENVELOPE_BOTTOM_Y - y) / ENVELOPE_HEIGHT));
}

export function getWaveformFitGain(waveform) {
  const count = Math.min(waveform.min.length, waveform.max.length);
  let peak = 0;
  for (let index = 0; index < count; index += 1) {
    const minimum = waveform.min[index];
    const maximum = waveform.max[index];
    if (Number.isFinite(minimum)) peak = Math.max(peak, Math.abs(minimum));
    if (Number.isFinite(maximum)) peak = Math.max(peak, Math.abs(maximum));
  }
  return peak > 0 ? Math.max(1, Math.min(20, 1 / peak)) : 1;
}

export function getWaveformPaths(waveform, startFraction = 0, endFraction = 1, gain = 1) {
  const count = Math.min(waveform.min.length, waveform.max.length);
  if (!count) return { area: '' };
  const start = Math.max(0, Math.min(1, startFraction));
  const end = Math.max(start, Math.min(1, endFraction));
  const x = (fraction) => (5 + (start + fraction * (end - start)) * 490).toFixed(1);
  const y = (value) => (WAVEFORM_CENTER_Y -
    Math.max(-1, Math.min(1, value * gain)) * WAVEFORM_AMPLITUDE_HEIGHT).toFixed(1);
  const upper = [];
  const lower = [];

  for (let index = 0; index < count; index += 1) {
    const maximum = Number.isFinite(waveform.max[index]) ? waveform.max[index] : 0;
    const minimum = Number.isFinite(waveform.min[index]) ? waveform.min[index] : 0;
    const position = x((index + 0.5) / count);
    if (index === 0) {
      upper.push(`M${x(0)},${y(maximum)}`);
      lower.push(`${x(0)},${y(minimum)}`);
    }
    upper.push(`L${position},${y(maximum)}`);
    lower.push(`${position},${y(minimum)}`);
    if (index === count - 1) {
      upper.push(`L${x(1)},${y(maximum)}`);
      lower.push(`${x(1)},${y(minimum)}`);
    }
  }

  return { area: `${upper.join(' ')} ${lower.reverse().map((point) => `L${point}`).join(' ')} Z` };
}

export function mapOutputWaveformToSource(waveform, duration, mapping, viewRange, binCount = DEFAULT_WAVEFORM_BIN_COUNT) {
  const count = waveform.binCount ?? waveform.min.length;
  const min = Array(binCount).fill(0);
  const max = Array(binCount).fill(0);
  if (!count || duration <= 0 || mapping.playbackDurationSec <= 0) return { min, max };

  const sourceSpan = mapping.sourceEnd - mapping.sourceStart;
  const viewSpan = viewRange.end - viewRange.start;
  for (let bin = 0; bin < binCount; bin += 1) {
    const sourceStart = Math.max(mapping.sourceStart, viewRange.start + bin / binCount * viewSpan);
    const sourceEnd = Math.min(mapping.sourceEnd, viewRange.start + (bin + 1) / binCount * viewSpan);
    if (sourceEnd <= sourceStart) continue;
    const timeStart = mapping.delaySec + (sourceStart - mapping.sourceStart) / sourceSpan * mapping.playbackDurationSec;
    const timeEnd = mapping.delaySec + (sourceEnd - mapping.sourceStart) / sourceSpan * mapping.playbackDurationSec;
    const first = Math.max(0, Math.floor(timeStart / duration * count));
    const last = Math.min(waveform.min.length, waveform.max.length, Math.ceil(timeEnd / duration * count));
    if (last <= first) continue;
    let low = Infinity;
    let high = -Infinity;
    for (let index = first; index < last; index += 1) {
      low = Math.min(low, waveform.min[index]);
      high = Math.max(high, waveform.max[index]);
    }
    min[bin] = low;
    max[bin] = high;
  }
  return { min, max };
}

export function getSampleAreaPath(samples, sampleCount, scale, otherSamples = samples) {
  const count = Math.min(samples.length, otherSamples.length, sampleCount);
  if (!count) return '';
  const min = [];
  const max = [];
  for (let index = 0; index < count; index += 1) {
    const first = Number.isFinite(samples[index]) ? samples[index] : 0;
    const second = Number.isFinite(otherSamples[index]) ? otherSamples[index] : 0;
    min.push(Math.min(0, first, second));
    max.push(Math.max(0, first, second));
  }
  return getWaveformPaths({ min, max }, 0, count / sampleCount, 1 / scale).area;
}

export function getTrimmedPreviewRange(trimStart, trimEnd) {
  const span = trimEnd - trimStart;
  const margin = span * 0.1;
  return {
    start: Math.max(0, trimStart - margin),
    end: Math.min(1, trimEnd + margin)
  };
}

export function getZoomedPreviewRange(range, zoom, pan = 0.5) {
  const rangeSpan = range.end - range.start;
  const span = rangeSpan / Math.max(1, zoom);
  const start = range.start + (rangeSpan - span) * Math.max(0, Math.min(1, pan));
  return { start, end: start + span };
}

export function getWaveformPeaks(samples, barCount = DEFAULT_WAVEFORM_BIN_COUNT) {
  if (!samples?.length) return [];

  const count = Math.min(barCount, samples.length);
  const peaks = [];
  for (let bar = 0; bar < count; bar += 1) {
    const start = Math.floor((bar * samples.length) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * samples.length) / count));
    let peak = 0;
    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(samples[index]));
    }
    peaks.push(peak);
  }
  return peaks;
}

export function getLayerPreviewWaveform(samples, binCount = DEFAULT_WAVEFORM_BIN_COUNT) {
  if (!samples?.length) return { min: [], max: [] };

  const count = Math.min(Math.max(1, Math.floor(binCount)), samples.length);
  const minimums = [];
  const maximums = [];

  for (let bin = 0; bin < count; bin += 1) {
    const start = Math.floor((bin * samples.length) / count);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * samples.length) / count));
    const step = Math.max(1, Math.ceil((end - start) / 512));
    let minimum = Infinity;
    let maximum = -Infinity;

    for (let index = start; index < end; index += step) {
      const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
      minimum = Math.min(minimum, sample);
      maximum = Math.max(maximum, sample);
    }

    const lastSample = Number.isFinite(samples[end - 1]) ? samples[end - 1] : 0;
    minimums.push(Math.min(minimum, lastSample));
    maximums.push(Math.max(maximum, lastSample));
  }

  return { min: minimums, max: maximums };
}

export function getMemoizedLayerPreviewWaveform(
  samples,
  trimStart = 0,
  trimEnd = 1,
  binCount = DEFAULT_WAVEFORM_BIN_COUNT
) {
  if (!samples?.length) return { min: [], max: [] };

  const trimRange = getSampleTrimRange(samples.length, trimStart, trimEnd);
  const cacheKey = `${trimRange.startOffset}:${trimRange.endSample}:${binCount}`;
  let sampleCache = layerWaveformCache.get(samples);
  if (!sampleCache) {
    sampleCache = new Map();
    layerWaveformCache.set(samples, sampleCache);
  }

  const cachedWaveform = sampleCache.get(cacheKey);
  if (cachedWaveform) return cachedWaveform;

  const trimmedSamples = typeof samples.subarray === 'function'
    ? samples.subarray(trimRange.startOffset, trimRange.endSample)
    : samples.slice(trimRange.startOffset, trimRange.endSample);
  const waveform = getLayerPreviewWaveform(trimmedSamples, binCount);
  sampleCache.set(cacheKey, waveform);
  if (sampleCache.size > 6) {
    sampleCache.delete(sampleCache.keys().next().value);
  }
  return waveform;
}

export function applyEnvelopeToWaveform(waveform, envelopePoints) {
  if (!envelopePoints?.length || !waveform?.min?.length) {
    return waveform;
  }

  const binCount = waveform.max.length;
  const min = [];
  const max = [];

  for (let bin = 0; bin < binCount; bin += 1) {
    const position = (bin + 0.5) / binCount;
    const envelopeValue = getEnvelopeValueAt(position, envelopePoints);

    min.push(waveform.min[bin] * envelopeValue);
    max.push(waveform.max[bin] * envelopeValue);
  }

  return { min, max };
}

export function mergeStereoWaveform(stereoWaveform) {
  const { leftMin = [], leftMax = [], rightMin = [], rightMax = [] } = stereoWaveform || {};
  const count = Math.min(leftMin.length, leftMax.length, rightMin.length, rightMax.length);
  const minimums = [];
  const maximums = [];

  for (let index = 0; index < count; index += 1) {
    const minLeft = Number.isFinite(leftMin[index]) ? leftMin[index] : 0;
    const minRight = Number.isFinite(rightMin[index]) ? rightMin[index] : 0;
    const maxLeft = Number.isFinite(leftMax[index]) ? leftMax[index] : 0;
    const maxRight = Number.isFinite(rightMax[index]) ? rightMax[index] : 0;
    minimums.push(Math.min(minLeft, minRight));
    maximums.push(Math.max(maxLeft, maxRight));
  }

  return { min: minimums, max: maximums };
}

export function getLayerPlaybackInfo(state, sampleBuffers, sampleRates) {
  const hasSolo = state.layers.some((layer) => layer.solo) || (state.noise.enabled && state.noise.solo);
  return state.layers
    .map((layer, index) => {
      const samples = layer.sampleKey ? sampleBuffers[layer.sampleKey] : null;
      const sampleRate = sampleRates[layer.sampleKey] || layer.sampleRate || 44100;
      const playbackRate = Math.pow(2, layer.pitch / 12);
      const trimRange = getSampleTrimRange(samples?.length || 1, layer.trimStart, layer.trimEnd);
      const phase = getSamplePhaseShift(trimRange.sampleCount, layer.phaseOffset);
      const durationSec = (trimRange.sampleCount - phase.advanceSamples) / (sampleRate * playbackRate);
      const delaySec = Math.max(0, layer.delayMs) / 1000 + phase.delaySamples / (sampleRate * playbackRate);
      return {
        index,
        color: ['#f59e0b', '#22d3ee', '#c084fc'][index],
        durationSec,
        delaySec,
        endTimeSec: delaySec + durationSec
      };
    })
    .filter(({ index }) => {
      const layer = state.layers[index];
      const samples = layer.sampleKey ? sampleBuffers[layer.sampleKey] : null;
      return (
        layer.loaded &&
        samples?.length &&
        !layer.mute &&
        (!hasSolo || layer.solo)
      );
    });
}

export function getLayerSumPeaks(
  state,
  sampleBuffers,
  sampleRates,
  barCount = DEFAULT_WAVEFORM_BIN_COUNT
) {
  const hasSolo = state.layers.some((layer) => layer.solo) || (state.noise.enabled && state.noise.solo);
  const layers = state.layers
    .map((layer) => {
      const trimRange = getSampleTrimRange(
        (layer.sampleKey && sampleBuffers[layer.sampleKey]?.length) || 1,
        layer.trimStart,
        layer.trimEnd
      );
      return {
        layer,
        samples: layer.sampleKey ? sampleBuffers[layer.sampleKey] : null,
        sampleRate: sampleRates[layer.sampleKey] || layer.sampleRate || 44100,
        playbackRate: Math.pow(2, layer.pitch / 12),
        trimRange,
        phase: getSamplePhaseShift(trimRange.sampleCount, layer.phaseOffset),
        inputGain: Math.pow(10, (layer.inputDb ?? 0) / 20)
      };
    })
    .filter(
      ({ layer, samples }) =>
        layer.loaded && samples?.length && !layer.mute && (!hasSolo || layer.solo)
    );

  if (layers.length === 0) return { peaks: [], durationSec: 0, min: [], max: [] };

  const durationSec = Math.max(
    ...layers.map(
      ({ layer, sampleRate, playbackRate, trimRange, phase }) =>
        (trimRange.sampleCount + phase.delaySamples - phase.advanceSamples) /
          (sampleRate * playbackRate) +
        Math.max(0, layer.delayMs) / 1000
    )
  );
  const noiseAudible =
    state.noise.enabled && state.noise.gain > 0 && !state.noise.mute && (!hasSolo || state.noise.solo);
  const noiseDuration = noiseAudible ? state.noise.decay + 0.016 : 0;
  const fullDuration = Math.max(durationSec, noiseDuration);
  const sampleCount = Math.ceil(fullDuration * 44100);
  const count = Math.min(barCount, sampleCount);
  const peaks = [];
  const minimums = [];
  const maximums = [];

  for (let bar = 0; bar < count; bar += 1) {
    const start = Math.floor((bar * sampleCount) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * sampleCount) / count));
    const step = Math.max(1, Math.floor((end - start) / 32));
    let peak = 0;
    let minimum = Infinity;
    let maximum = -Infinity;

    for (let outputIndex = start; outputIndex < end; outputIndex += step) {
      const timeSec = outputIndex / 44100;
      let sum = 0;
      for (const { layer, samples, sampleRate, playbackRate, trimRange, phase, inputGain } of layers) {
        const sourceTime = timeSec - Math.max(0, layer.delayMs) / 1000 -
          phase.delaySamples / (sampleRate * playbackRate);
        if (sourceTime < 0) continue;

        const elapsedSamples = Math.floor(sourceTime * sampleRate * playbackRate);
        const sourceIndex =
          trimRange.startOffset + phase.advanceSamples + elapsedSamples;
        if (sourceIndex >= trimRange.endSample) continue;

        sum +=
          samples[sourceIndex] *
          inputGain *
          layer.gain *
          getEnvelopeValueAt(
            elapsedSamples / Math.max(1, trimRange.sampleCount - 1),
            layer.envelopePoints
          );
      }
      peak = Math.max(peak, Math.abs(sum));
      minimum = Math.min(minimum, sum);
      maximum = Math.max(maximum, sum);
    }
    peaks.push(peak);
    minimums.push(minimum === Infinity ? 0 : minimum);
    maximums.push(maximum === -Infinity ? 0 : maximum);
  }

  const normalization = Math.max(1, ...peaks);
  return {
    peaks: peaks.map((peak) => peak / normalization),
    min: minimums.map((val) => val / normalization),
    max: maximums.map((val) => val / normalization),
    durationSec: fullDuration
  };
}

export function detectSilenceEnd(samples, silenceThreshold = 0.01, otherSamples = samples) {
  if (!samples?.length) return 1;

  // Work backwards from the end to find where sustained silence begins
  const rmsWindow = Math.max(1, Math.floor(samples.length * 0.02)); // 2% of duration for better resolution
  let silenceStart = samples.length;

  for (let i = samples.length - rmsWindow; i >= 0; i -= Math.max(1, Math.floor(rmsWindow / 2))) {
    let rms = 0;
    let count = 0;
    for (let j = i; j < Math.min(i + rmsWindow, samples.length); j += 1) {
      rms += Math.max(samples[j] * samples[j], otherSamples[j] * otherSamples[j]);
      count += 1;
    }
    rms = Math.sqrt(rms / Math.max(1, count));

    if (rms < silenceThreshold) {
      silenceStart = i;
    } else {
      break; // Found sound, stop going backwards
    }
  }

  // Convert to normalized 0-1 range
  return Math.max(0, Math.min(1, silenceStart / samples.length));
}

export function detectSilenceStart(samples, silenceThreshold = 0.01, otherSamples = samples) {
  if (!samples?.length) return 0;

  // Work forwards from the start to find where sound begins
  const rmsWindow = Math.max(1, Math.floor(samples.length * 0.02)); // 2% of duration for better resolution
  let soundStart = 0;

  for (let i = 0; i < samples.length; i += Math.max(1, Math.floor(rmsWindow / 2))) {
    let rms = 0;
    let count = 0;
    for (let j = i; j < Math.min(i + rmsWindow, samples.length); j += 1) {
      rms += Math.max(samples[j] * samples[j], otherSamples[j] * otherSamples[j]);
      count += 1;
    }
    rms = Math.sqrt(rms / Math.max(1, count));

    if (rms >= silenceThreshold) {
      soundStart = i;
      break; // Found sound, stop
    }
  }

  // Convert to normalized 0-1 range
  return Math.max(0, Math.min(1, soundStart / samples.length));
}

export function getPhaseOffset(samples1, samples2, maxSearchWindow = 2048) {
  if (!samples1?.length || !samples2?.length) return 0;

  // Find the phase offset that maximizes correlation between the two signals
  // This helps align samples that were recorded separately to prevent phase cancellation
  const searchWindow = Math.min(maxSearchWindow, Math.floor(Math.max(samples1.length, samples2.length) * 0.05));
  let bestOffset = 0;
  let bestCorrelation = -Infinity;

  for (let offset = -searchWindow; offset <= searchWindow; offset += 1) {
    let correlation = 0;
    let count = 0;

    for (let i = 0; i < Math.min(samples1.length, samples2.length - Math.abs(offset)); i += 1) {
      const idx1 = i;
      const idx2 = i + offset;

      if (idx2 >= 0 && idx2 < samples2.length) {
        correlation += samples1[idx1] * samples2[idx2];
        count += 1;
      }
    }

    if (count > 0) {
      correlation /= count;
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = offset;
      }
    }
  }

  // Return offset as a fraction of the sample length
  return bestOffset / samples1.length;
}

export function alignSamplePhase(samples, referenceOffset = 0) {
  if (!samples?.length) return samples;

  // Apply phase offset by delaying/advancing the sample
  const offset = Math.round(referenceOffset * samples.length);
  if (offset === 0) return samples;

  if (offset > 0) {
    // Delay: prepend silence
    const padded = new Float32Array(samples.length);
    for (let i = offset; i < samples.length; i += 1) {
      padded[i] = samples[i - offset];
    }
    return padded;
  } else {
    // Advance: skip beginning samples
    const absOffset = Math.abs(offset);
    const shifted = new Float32Array(samples.length);
    for (let i = 0; i < samples.length - absOffset; i += 1) {
      shifted[i] = samples[i + absOffset];
    }
    return shifted;
  }
}
