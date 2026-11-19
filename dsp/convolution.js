export const CONVOLVE_PROFILES = Object.freeze(['room', 'plate', 'chamber']);
export const IMPULSE_SAMPLE_RATE = 44100;

const PROFILE_SETTINGS = {
  room: { duration: 0.18, decay: 24, seed: 1957 },
  plate: { duration: 0.45, decay: 12, seed: 2719 },
  chamber: { duration: 0.3, decay: 16, seed: 4337 }
};

export function getBuiltinImpulseDuration(profile) {
  return PROFILE_SETTINGS[profile].duration;
}

export function builtinImpulseKey(profile, side) {
  return `lf_ir_${IMPULSE_SAMPLE_RATE}_${profile}_${side}`;
}

export function createBuiltinImpulses() {
  const resources = {};
  for (const [profile, settings] of Object.entries(PROFILE_SETTINGS)) {
    for (const [side, offset] of [['left', 0], ['right', 1]]) {
      const length = Math.round(settings.duration * IMPULSE_SAMPLE_RATE);
      const samples = new Float32Array(length);
      let seed = settings.seed + offset;
      let total = 0;
      for (let index = 0; index < length; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = seed / 0x80000000 - 1;
        const amplitude = Math.exp(-settings.decay * index / IMPULSE_SAMPLE_RATE);
        samples[index] = noise * amplitude;
        total += samples[index] * samples[index];
      }
      const gain = 0.65 / Math.sqrt(total);
      for (let index = 0; index < length; index += 1) samples[index] *= gain;
      samples[0] += 0.25;
      resources[builtinImpulseKey(profile, side)] = samples;
    }
  }
  return resources;
}

export function resampleImpulse(samples, sourceRate, targetRate) {
  if (!samples.length || !Number.isFinite(sourceRate) || sourceRate <= 0 ||
      !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new Error('Impulse and sample rates must be valid and non-empty.');
  }
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const cutoff = Math.min(1, targetRate / sourceRate);
  const result = new Float32Array(Math.max(1, Math.ceil(samples.length / ratio)));
  const radius = 16;
  for (let index = 0; index < result.length; index += 1) {
    const position = index * ratio;
    let sum = 0;
    let weightSum = 0;
    for (let tap = Math.floor(position) - radius + 1; tap <= Math.floor(position) + radius; tap += 1) {
      const distance = position - tap;
      const x = Math.PI * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(x) / x;
      const weight = cutoff * sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      if (tap >= 0 && tap < samples.length) sum += samples[tap] * weight;
      weightSum += weight;
    }
    result[index] = weightSum ? (sum / weightSum) * ratio : 0;
  }
  return result;
}
