// Tracks the highest value of each meter during the most recent hit. A hit
// ends once a reading stays below its threshold for `gapMs`; the next reading
// at or above the threshold then starts a new peak. The held value stays until
// that happens, so it can be read after the hit has decayed.
export function createHitPeakTracker(thresholds, gapMs = 300) {
  const peaks = thresholds.map(() => 0);
  const lastSignal = thresholds.map(() => -Infinity);
  return {
    update(values, now) {
      thresholds.forEach((threshold, index) => {
        const value = values[index];
        if (!(value >= threshold)) return;
        peaks[index] = now - lastSignal[index] > gapMs ? value : Math.max(peaks[index], value);
        lastSignal[index] = now;
      });
      return [...peaks];
    },
    reset() {
      peaks.fill(0);
      lastSignal.fill(-Infinity);
    }
  };
}

export function peakToDb(peak) {
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function formatPeakDb(peak) {
  const decibels = peakToDb(peak);
  return `${peak === 0 ? '-∞' : decibels < -60 ? '<-60' : decibels.toFixed(1)} dBFS`;
}
