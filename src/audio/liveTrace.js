const MAX_TRACE_SECONDS = 4;
const MAX_TRACE_BINS = 512;
const MAX_COMPARISON_BINS = 4096;

export class LiveTrace {
  constructor(getDuration, binCount = MAX_TRACE_BINS, captureTransient = false, triggerPulses = false) {
    this.getDuration = getDuration;
    this.binCount = Math.max(1, Math.min(MAX_COMPARISON_BINS, Math.floor(binCount)));
    this.captureTransient = captureTransient;
    this.triggerPulses = triggerPulses;
    this.lastGate = null;
    this.lastClock = null;
    this.sampleRate = null;
    this.capture = null;
  }

  consume(data, sampleRate) {
    const [minimum, maximum, gate, clock] = data || [];
    if (
      !Number.isFinite(sampleRate) || sampleRate <= 0 ||
      !minimum?.length || maximum?.length !== minimum.length ||
      gate?.length !== minimum.length || clock?.length !== minimum.length
    ) {
      throw new Error('Invalid live trace data from the audio engine.');
    }

    let interrupted = false;
    if (this.sampleRate && this.sampleRate !== sampleRate) {
      this.lastClock = null;
      this.lastGate = null;
      this.capture = null;
      interrupted = true;
    }
    this.sampleRate = sampleRate;
    let changed = false;
    for (let index = 0; index < minimum.length; index += 1) {
      const min = minimum[index];
      const max = maximum[index];
      const gateValue = gate[index];
      const frame = clock[index];
      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(gateValue) || !Number.isSafeInteger(frame)) {
        throw new Error('Live trace contains invalid audio data.');
      }
      if (this.lastClock !== null && frame !== this.lastClock + 1) {
        this.lastGate = null;
        if (this.capture && this.capture.count < this.capture.totalSamples) {
          this.capture = null;
          interrupted = true;
          changed = false;
        }
      }

      this.lastClock = frame;
      const high = gateValue > 0;
      if (high && (this.triggerPulses || this.lastGate === false)) {
        const duration = this.getDuration();
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error('Live trace requires a valid preview duration.');
        }
        const totalSamples = Math.max(1, Math.ceil(Math.min(duration, MAX_TRACE_SECONDS) * sampleRate));
        this.capture = {
          totalSamples,
          binCount: Math.min(this.binCount, totalSamples),
          min: [],
          max: [],
          transient: this.captureTransient ? [] : null,
          transientMax: this.captureTransient ? [] : null,
          count: 0,
          limited: duration > MAX_TRACE_SECONDS
        };
        changed = true;
      }
      this.lastGate = high;

      const capture = this.capture;
      if (capture && capture.count < capture.totalSamples) {
        const bin = Math.floor(capture.count * capture.binCount / capture.totalSamples);
        if (capture.min[bin] === undefined) {
          capture.min[bin] = Math.min(min, max);
          capture.max[bin] = Math.max(min, max);
        } else {
          capture.min[bin] = Math.min(capture.min[bin], min, max);
          capture.max[bin] = Math.max(capture.max[bin], min, max);
        }
        capture.count += 1;
        if (capture.transient && capture.count <= sampleRate * 0.1) {
          capture.transient.push(min);
          capture.transientMax.push(max);
        }
        changed = true;
      }
    }
    if (!changed) return interrupted ? { status: 'GAP' } : null;
    const capture = this.capture;
    return {
      status: capture.count < capture.totalSamples ? 'CAPTURING' : 'LAST HIT',
      min: capture.min.slice(),
      max: capture.max.slice(),
      ...(capture.transient ? { transient: capture.transient.slice(), transientMax: capture.transientMax.slice() } : {}),
      capturedSec: capture.count / sampleRate,
      durationSec: capture.totalSamples / sampleRate,
      binCount: capture.binCount,
      limited: capture.limited
    };
  }
}

export class LiveComparisonTrace {
  constructor(getDuration, triggerPulses = false) {
    this.collectors = Array.from({ length: 6 }, () => new LiveTrace(getDuration, MAX_COMPARISON_BINS, true, triggerPulses));
  }

  consume(data, sampleRate) {
    if (!Array.isArray(data) || data.length !== 14) {
      throw new Error('Invalid live comparison data from the audio engine.');
    }
    const [left, right, gate, clock, ...lanes] = data;
    const inputs = [[left, right], ...Array.from({ length: 5 }, (_, index) =>
      [lanes[index * 2], lanes[index * 2 + 1]]
    )];
    const results = this.collectors.map((collector, index) =>
      collector.consume([...inputs[index], gate, clock], sampleRate)
    );
    const [final, ...remaining] = results;
    if (!final || final.status === 'GAP') return final;
    if (remaining.some((result) => !result || result.status !== final.status)) {
      throw new Error('Live comparison channels are out of sync.');
    }
    const preMaster = remaining.pop();
    const noise = remaining.pop();
    return {
      ...final,
      comparison: { final, layers: remaining, noise, preMaster, sampleRate }
    };
  }
}

export function reduceWaveformResolution(waveform, resolution) {
  const binCount = waveform.binCount ?? waveform.min.length;
  const targetCount = Math.min(binCount, resolution);
  if (targetCount === binCount) return waveform;
  const min = [];
  const max = [];
  for (let index = 0; index < waveform.min.length; index += 1) {
    const bin = Math.floor(index * targetCount / binCount);
    min[bin] = min[bin] === undefined ? waveform.min[index] : Math.min(min[bin], waveform.min[index]);
    max[bin] = max[bin] === undefined ? waveform.max[index] : Math.max(max[bin], waveform.max[index]);
  }
  return { ...waveform, min, max, binCount: targetCount };
}

export function reduceComparisonResolution(trace, resolution) {
  if (!trace?.comparison) return trace;
  const reduce = (waveform) => reduceWaveformResolution(waveform, resolution);
  const { comparison } = trace;
  const final = reduce(comparison.final);
  return {
    ...trace,
    min: final.min,
    max: final.max,
    comparison: {
      ...comparison,
      final,
      preMaster: reduce(comparison.preMaster),
      layers: comparison.layers.map(reduce),
      noise: reduce(comparison.noise)
    }
  };
}
