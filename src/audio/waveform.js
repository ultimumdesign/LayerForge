import { getSampleTrimRange } from '../../dsp/parameters.js';

export function getWaveformPeaks(samples, barCount = 128) {
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

export function getEnvelopeValueAt(time, points) {
  if (!Array.isArray(points) || points.length === 0) return 1;
  const position = Math.max(0, Math.min(1, time));
  if (position <= points[0].time) return points[0].value;

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (position > right.time) continue;
    const left = points[index - 1];
    const amount = (position - left.time) / (right.time - left.time);
    return left.value + amount * (right.value - left.value);
  }

  return points.at(-1).value;
}

export function getLayerPreviewPeaks(samples, layer, sampleRate = 44100, barCount = 128) {
  if (!samples?.length) return [];

  const count = Math.min(barCount, samples.length);
  const trimRange = getSampleTrimRange(samples.length, layer.trimStart, layer.trimEnd);
  const filteredPeaks = [];

  for (let bar = 0; bar < count; bar += 1) {
    const start = Math.floor((bar * samples.length) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * samples.length) / count));
    const trimmedStart = Math.max(start, trimRange.startOffset);
    const trimmedEnd = Math.min(end, trimRange.endSample);
    if (trimmedStart >= trimmedEnd) {
      filteredPeaks.push(0);
      continue;
    }

    const span = trimmedEnd - trimmedStart;
    const step = Math.max(1, Math.ceil(span / 256));
    let peak = 0;
    let crossings = 0;
    let previous = samples[trimmedStart];
    for (let index = trimmedStart; index < trimmedEnd; index += step) {
      const sample = samples[index];
      peak = Math.max(peak, Math.abs(sample));
      if ((sample < 0 && previous >= 0) || (sample >= 0 && previous < 0)) crossings += 1;
      previous = sample;
    }

    const binDuration = span / sampleRate;
    const frequency = binDuration > 0 ? crossings / (2 * binDuration) : 0;
    const highPass = Math.max(20, layer.hp || 20);
    const lowPass = Math.max(highPass, layer.lp || 20000);
    const highPassGain = frequency === 0
      ? 0
      : (frequency * frequency) / (frequency * frequency + highPass * highPass);
    const lowPassRatio = frequency / lowPass;
    const lowPassGain = 1 / Math.sqrt(1 + lowPassRatio ** 4);

    filteredPeaks.push(peak * highPassGain * lowPassGain);
  }

  const drive = 10 ** ((layer.clipDrive || 0) / 20);
  const hardness = Math.max(0, Math.min(1, layer.clipHardness ?? 0.25));
  return filteredPeaks.map((peak, index) => {
    const previous = filteredPeaks[Math.max(0, index - 1)];
    const next = filteredPeaks[Math.min(filteredPeaks.length - 1, index + 1)];
    const slow = (previous + peak * 2 + next) / 4;
    const transient = Math.max(0, peak - slow);
    const dynamics = Math.max(
      0,
      1 + (layer.attack || 0) * 3 * transient + (layer.sustain || 0) * 1.5 * slow
    );
    const barCenterSample = Math.floor(((index + 0.5) * samples.length) / count);
    const progress =
      (barCenterSample - trimRange.startOffset) / Math.max(1, trimRange.sampleCount - 1);
    const envelope = getEnvelopeValueAt(progress, layer.envelopePoints);
    const driven = Math.max(0, peak * dynamics * envelope * layer.gain) * drive;
    const soft = Math.tanh(driven);
    const hard = Math.min(1, driven);
    return (1 - hardness) * soft + hardness * hard;
  });
}

export function getLayerPlaybackInfo(state, sampleBuffers, sampleRates) {
  const hasSolo = state.layers.some((layer) => layer.solo) || state.noise.solo;
  return state.layers
    .map((layer, index) => {
      const samples = layer.sampleKey ? sampleBuffers[layer.sampleKey] : null;
      const sampleRate = sampleRates[layer.sampleKey] || layer.sampleRate || 44100;
      const playbackRate = Math.pow(2, layer.pitch / 12);
      const trimRange = getSampleTrimRange(samples?.length || 1, layer.trimStart, layer.trimEnd);
      const durationSec = trimRange.sampleCount / (sampleRate * playbackRate);
      const delaySec = Math.max(0, layer.delayMs) / 1000;
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

export function getLayerSumPeaks(state, sampleBuffers, sampleRates, barCount = 176) {
  const hasSolo = state.layers.some((layer) => layer.solo) || state.noise.solo;
  const layers = state.layers
    .map((layer) => ({
      layer,
      samples: layer.sampleKey ? sampleBuffers[layer.sampleKey] : null,
      sampleRate: sampleRates[layer.sampleKey] || layer.sampleRate || 44100,
      playbackRate: Math.pow(2, layer.pitch / 12),
      trimRange: getSampleTrimRange(
        (layer.sampleKey && sampleBuffers[layer.sampleKey]?.length) || 1,
        layer.trimStart,
        layer.trimEnd
      )
    }))
    .filter(
      ({ layer, samples }) =>
        layer.loaded && samples?.length && !layer.mute && (!hasSolo || layer.solo)
    );

  if (layers.length === 0) return { peaks: [], durationSec: 0 };

  const durationSec = Math.max(
    ...layers.map(
      ({ layer, sampleRate, playbackRate, trimRange }) =>
        trimRange.sampleCount / (sampleRate * playbackRate) +
        Math.max(0, layer.delayMs) / 1000
    )
  );
  const noiseAudible =
    state.noise.gain > 0 && !state.noise.mute && (!hasSolo || state.noise.solo);
  const noiseDuration = noiseAudible ? Math.max(0.005, state.noise.decay) : 0;
  const fullDuration = Math.max(durationSec, noiseDuration);
  const sampleCount = Math.ceil(fullDuration * 44100);
  const count = Math.min(barCount, sampleCount);
  const peaks = [];

  for (let bar = 0; bar < count; bar += 1) {
    const start = Math.floor((bar * sampleCount) / count);
    const end = Math.max(start + 1, Math.floor(((bar + 1) * sampleCount) / count));
    const step = Math.max(1, Math.floor((end - start) / 32));
    let peak = 0;

    for (let outputIndex = start; outputIndex < end; outputIndex += step) {
      const timeSec = outputIndex / 44100;
      let sum = 0;
      for (const { layer, samples, sampleRate, playbackRate, trimRange } of layers) {
        const sourceTime = timeSec - Math.max(0, layer.delayMs) / 1000;
        if (sourceTime < 0) continue;

        const sourceIndex =
          trimRange.startOffset + Math.floor(sourceTime * sampleRate * playbackRate);
        if (sourceIndex >= trimRange.endSample) continue;

        sum +=
          samples[sourceIndex] *
          layer.gain *
          getEnvelopeValueAt(
            (sourceIndex - trimRange.startOffset) / Math.max(1, trimRange.sampleCount - 1),
            layer.envelopePoints
          );
      }
      peak = Math.max(peak, Math.abs(sum));
    }
    peaks.push(peak);
  }

  const normalization = Math.max(1, ...peaks);
  return {
    peaks: peaks.map((peak) => peak / normalization),
    durationSec: fullDuration
  };
}
