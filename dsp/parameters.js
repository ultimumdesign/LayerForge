/**
 * Single Source of Truth for DAW Automation Parameters & Default Patch State.
 * Used by both the React UI and the native JUCE AudioProcessor parameter tree.
 */

export const LAYER_COUNT = 3;
export const MIN_TRIM_RANGE = 0.01;

export const PARAMETER_SCHEMA = [
  // Per-layer parameters
  ...Array.from({ length: LAYER_COUNT }, (_, i) => [
    { id: `l${i}_pitch`, name: `Layer ${i + 1} Pitch`, min: -24, max: 24, default: 0, unit: 'st' },
    { id: `l${i}_delayMs`, name: `Layer ${i + 1} Playback Start Delay`, min: 0, max: 1000, default: 0, unit: 'ms' },
    { id: `l${i}_attack`, name: `Layer ${i + 1} Attack`, min: -1, max: 1, default: 0, unit: '' },
    { id: `l${i}_sustain`, name: `Layer ${i + 1} Sustain`, min: -1, max: 1, default: 0, unit: '' },
    { id: `l${i}_hp`, name: `Layer ${i + 1} High-Pass`, min: 20, max: 2000, default: 25, unit: 'Hz' },
    { id: `l${i}_lp`, name: `Layer ${i + 1} Low-Pass`, min: 800, max: 20000, default: 20000, unit: 'Hz' },
    { id: `l${i}_clipDrive`, name: `Layer ${i + 1} Clip Drive`, min: 0, max: 24, default: 0, unit: 'dB' },
    { id: `l${i}_clipHardness`, name: `Layer ${i + 1} Clip Shape`, min: 0, max: 1, default: 0.25, unit: '' },
    { id: `l${i}_gain`, name: `Layer ${i + 1} Mix`, min: 0, max: 1.5, default: 0.85, unit: '' }
  ]).flat(),

  // Noise Engine parameters
  { id: 'noise_cutoff', name: 'Noise Freq', min: 150, max: 16000, default: 4800, unit: 'Hz' },
  { id: 'noise_q', name: 'Noise Resonance', min: 0.5, max: 10, default: 1.4, unit: '' },
  { id: 'noise_decay', name: 'Noise Decay', min: 0.005, max: 0.6, default: 0.075, unit: 's' },
  { id: 'noise_clipDrive', name: 'Noise Clip Drive', min: 0, max: 24, default: 3.0, unit: 'dB' },
  { id: 'noise_gain', name: 'Noise Mix', min: 0, max: 1.0, default: 0.22, unit: '' },

  // Master Bus parameters
  { id: 'master_drive', name: 'Master Clip Drive', min: 0, max: 24, default: 2.0, unit: 'dB' },
  { id: 'master_hardness', name: 'Master Clip Shape', min: 0, max: 1, default: 0.45, unit: '' },
  { id: 'master_ceiling', name: 'Master Ceiling', min: 0.1, max: 1.0, default: 0.95, unit: '' }
];

export function createDefaultLayer(label) {
  return {
    name: label,
    loaded: false,
    sampleKey: null,
    sourceName: null,
    sourceLocation: null,
    sampleRate: 44100,
    sampleCount: 0,
    trimStart: 0,
    trimEnd: 1,
    envelopePoints: [
      { time: 0, value: 1 },
      { time: 1, value: 1 }
    ],
    mute: false,
    solo: false,
    pitch: 0,
    delayMs: 0,
    attack: 0,
    sustain: 0,
    hp: 25,
    lp: 20000,
    clipDrive: 0,
    clipHardness: 0.25,
    gain: 0.85
  };
}

function boundedNumber(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function getSampleTrimRange(sampleCount, trimStart = 0, trimEnd = 1) {
  const count = Math.max(1, Math.floor(sampleCount || 1));
  const startOffset = Math.min(count - 1, Math.round(count * boundedNumber(trimStart, 0, 0, 1)));
  const endSample = Math.max(
    startOffset + 1,
    Math.min(count, Math.round(count * boundedNumber(trimEnd, 1, 0, 1)))
  );
  return {
    startOffset,
    endSample,
    stopOffset: count - endSample,
    sampleCount: endSample - startOffset
  };
}

function sanitizeTrimRange(trimStart, trimEnd) {
  let start = boundedNumber(trimStart, 0, 0, 1 - MIN_TRIM_RANGE);
  let end = boundedNumber(trimEnd, 1, 0, 1);
  if (end - start < MIN_TRIM_RANGE) {
    if (start + MIN_TRIM_RANGE <= 1) {
      end = start + MIN_TRIM_RANGE;
    } else {
      start = 1 - MIN_TRIM_RANGE;
      end = 1;
    }
  }
  return { trimStart: start, trimEnd: end };
}

function sanitizeEnvelopePoints(points) {
  if (!Array.isArray(points)) return null;

  const validPoints = points
    .filter(
      (point) =>
        point &&
        typeof point === 'object' &&
        Number.isFinite(point.time) &&
        Number.isFinite(point.value)
    )
    .map((point) => ({
      time: Math.max(0, Math.min(1, point.time)),
      value: Math.max(0, Math.min(1, point.value))
    }))
    .sort((a, b) => a.time - b.time);

  if (validPoints.length < 2) return null;
  const start = validPoints.find((point) => point.time === 0)?.value ?? 1;
  const end = validPoints.find((point) => point.time === 1)?.value ?? 1;
  const interior = [];
  for (const point of validPoints) {
    if (point.time <= 0 || point.time >= 1) continue;
    if (
      interior.length < 10 &&
      point.time - (interior.at(-1)?.time ?? 0) >= 0.005 &&
      1 - point.time >= 0.005
    ) {
      interior.push(point);
    }
  }
  return [{ time: 0, value: start }, ...interior, { time: 1, value: end }];
}

function migrateLegacyEnvelope(layer, sampleCount, sampleRate) {
  const durationSec = sampleCount > 0 ? sampleCount / sampleRate : 1;
  const attack = boundedNumber(layer.envelopeAttack, 0.005, 0.001, 1);
  const decay = boundedNumber(layer.envelopeDecay, 0.35, 0.005, 3);
  const sustain = boundedNumber(layer.envelopeSustain, 0.85, 0, 1);
  const release = boundedNumber(layer.envelopeRelease, 0.12, 0.005, 3);
  const releaseStart = Math.max(0, 1 - release / durationSec);
  const attackEnd = Math.min(attack / durationSec, releaseStart);
  const decayEnd = Math.min((attack + decay) / durationSec, releaseStart);
  return sanitizeEnvelopePoints([
    { time: 0, value: 0 },
    { time: attackEnd, value: 1 },
    { time: decayEnd, value: sustain },
    { time: releaseStart, value: sustain },
    { time: 1, value: 0 }
  ]);
}

export function serializePatchState(state) {
  return {
    layers: state.layers.map((layer) => ({
      name: layer.name,
      loaded: layer.loaded,
      sampleKey: layer.sampleKey,
      sourceName: layer.sourceName,
      sourceLocation: layer.sourceLocation,
      sampleRate: layer.sampleRate,
      sampleCount: layer.sampleCount,
      trimStart: layer.trimStart,
      trimEnd: layer.trimEnd,
      envelopePoints: layer.envelopePoints,
      mute: layer.mute,
      solo: layer.solo,
      pitch: layer.pitch,
      delayMs: layer.delayMs,
      attack: layer.attack,
      sustain: layer.sustain,
      hp: layer.hp,
      lp: layer.lp,
      clipDrive: layer.clipDrive,
      clipHardness: layer.clipHardness,
      gain: layer.gain
    })),
    noise: { ...state.noise },
    master: { ...state.master }
  };
}

export function restorePatchState(saved, sampleBuffers = {}) {
  const defaults = createDefaultState();
  if (!saved || typeof saved !== 'object') return defaults;

  const savedLayers = Array.isArray(saved.layers) ? saved.layers : [];
  const layers = defaults.layers.map((defaultLayer, index) => {
    const savedLayer = savedLayers[index];
    if (!savedLayer || typeof savedLayer !== 'object') return defaultLayer;

    const sampleKey =
      typeof savedLayer.sampleKey === 'string' && sampleBuffers[savedLayer.sampleKey]
        ? savedLayer.sampleKey
        : null;
    const sampleRate = boundedNumber(savedLayer.sampleRate, 44100, 1, 768000);
    const sampleCount = sampleKey
      ? sampleBuffers[sampleKey].length
      : boundedNumber(savedLayer.sampleCount, 0, 0, 0x7fffffff);
    const envelopePoints =
      sanitizeEnvelopePoints(savedLayer.envelopePoints) ||
      migrateLegacyEnvelope(savedLayer, sampleCount, sampleRate);
    const trimRange = sanitizeTrimRange(savedLayer.trimStart, savedLayer.trimEnd);
    return {
      ...defaultLayer,
      name: typeof savedLayer.name === 'string' ? savedLayer.name : defaultLayer.name,
      loaded: Boolean(sampleKey),
      sampleKey,
      sourceName: typeof savedLayer.sourceName === 'string' ? savedLayer.sourceName : null,
      sourceLocation:
        typeof savedLayer.sourceLocation === 'string' ? savedLayer.sourceLocation : null,
      sampleRate,
      sampleCount,
      ...trimRange,
      envelopePoints,
      mute: typeof savedLayer.mute === 'boolean' ? savedLayer.mute : defaultLayer.mute,
      solo: typeof savedLayer.solo === 'boolean' ? savedLayer.solo : defaultLayer.solo,
      pitch: boundedNumber(savedLayer.pitch, defaultLayer.pitch, -24, 24),
      delayMs: boundedNumber(savedLayer.delayMs, defaultLayer.delayMs, 0, 1000),
      attack: boundedNumber(savedLayer.attack, defaultLayer.attack, -1, 1),
      sustain: boundedNumber(savedLayer.sustain, defaultLayer.sustain, -1, 1),
      hp: boundedNumber(savedLayer.hp, defaultLayer.hp, 20, 2000),
      lp: boundedNumber(savedLayer.lp, defaultLayer.lp, 800, 20000),
      clipDrive: boundedNumber(savedLayer.clipDrive, defaultLayer.clipDrive, 0, 24),
      clipHardness: boundedNumber(savedLayer.clipHardness, defaultLayer.clipHardness, 0, 1),
      gain: boundedNumber(savedLayer.gain, defaultLayer.gain, 0, 1.5)
    };
  });

  const savedNoise = saved.noise && typeof saved.noise === 'object' ? saved.noise : {};
  const savedMaster = saved.master && typeof saved.master === 'object' ? saved.master : {};
  return {
    gate: 0,
    velocity: 1,
    layers,
    noise: {
      mute: typeof savedNoise.mute === 'boolean' ? savedNoise.mute : defaults.noise.mute,
      solo: typeof savedNoise.solo === 'boolean' ? savedNoise.solo : defaults.noise.solo,
      cutoff: boundedNumber(savedNoise.cutoff, defaults.noise.cutoff, 150, 16000),
      q: boundedNumber(savedNoise.q, defaults.noise.q, 0.5, 10),
      decay: boundedNumber(savedNoise.decay, defaults.noise.decay, 0.005, 0.6),
      clipDrive: boundedNumber(savedNoise.clipDrive, defaults.noise.clipDrive, 0, 24),
      gain: boundedNumber(savedNoise.gain, defaults.noise.gain, 0, 1)
    },
    master: {
      drive: boundedNumber(savedMaster.drive, defaults.master.drive, 0, 24),
      hardness: boundedNumber(savedMaster.hardness, defaults.master.hardness, 0, 1),
      ceiling: boundedNumber(savedMaster.ceiling, defaults.master.ceiling, 0.1, 1)
    }
  };
}

export function createDefaultState() {
  return {
    gate: 0,
    velocity: 1.0,
    layers: [
      createDefaultLayer('CH 01 // PUNCH'),
      createDefaultLayer('CH 02 // BODY'),
      createDefaultLayer('CH 03 // TOP')
    ],
    noise: {
      mute: false,
      solo: false,
      cutoff: 4800,
      q: 1.4,
      decay: 0.075,
      clipDrive: 3.0,
      gain: 0.22
    },
    master: {
      drive: 2.0,
      hardness: 0.45,
      ceiling: 0.95
    }
  };
}
