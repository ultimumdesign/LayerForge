/**
 * Single Source of Truth for DAW Automation Parameters & Default Patch State.
 * Used by both the React UI and the native JUCE AudioProcessor parameter tree.
 */

export const LAYER_COUNT = 3;

export const PARAMETER_SCHEMA = [
  // Per-layer parameters
  ...Array.from({ length: LAYER_COUNT }, (_, i) => [
    { id: `l${i}_pitch`, name: `Layer ${i + 1} Pitch`, min: -24, max: 24, default: 0, unit: 'st' },
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
    mute: false,
    solo: false,
    pitch: 0,
    attack: 0,
    sustain: 0,
    hp: 25,
    lp: 20000,
    clipDrive: 0,
    clipHardness: 0.25,
    gain: 0.85
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
