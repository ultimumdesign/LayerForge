import { el } from '@elemaudio/core';
import { transientShaper, hybridClipper, channelFilter } from './nodes.js';

/**
 * Builds the complete 3-Channel Drum Layerer + Noise Engine + Master Bus DSP Graph.
 * Pure functional graph: runs identically in Web Audio, Offline WAV Export, and Native VST3.
 */
export function buildDrumGraph(state) {
  const gate = el.const({ key: 'midi:gate', value: state.gate });
  const velGain = el.sm(el.const({ key: 'midi:vel', value: state.velocity ?? 1.0 }));

  const anySolo =
    state.layers.some((l) => l.solo) || Boolean(state.noise.solo);

  // 1. Sample Layers
  const layerNodes = state.layers.map((layer, idx) => {
    const isAudible = layer.loaded && !layer.mute && (!anySolo || layer.solo);
    if (!isAudible) {
      return el.const({ value: 0 });
    }

    const pitchRate = el.sm(
      el.const({ key: `l${idx}:rate`, value: Math.pow(2, layer.pitch / 12) })
    );
    const sourceRate = el.const({ value: layer.sampleRate || 44100 });
    const rate = el.div(el.mul(pitchRate, sourceRate), el.sr());

    const sampleCount = Math.max(1, layer.sampleCount || 1);
    const trimEnd = Math.max(0.01, Math.min(1, layer.trimEnd ?? 1));
    const playableSampleCount = Math.max(1, Math.round(sampleCount * trimEnd));
    const rawSample = el.sample(
      {
        key: `l${idx}:smp`,
        path: layer.sampleKey,
        mode: 'trigger',
        stopOffset: sampleCount - playableSampleCount
      },
      gate,
      rate
    );

    const playheadRate = el.div(
      el.mul(rate, el.sr()),
      el.const({ value: playableSampleCount })
    );
    const playhead = el.syncphasor(playheadRate, gate);
    const samplePosition = el.mul(playhead, el.const({ value: playableSampleCount }));
    const envelopeSequence = layer.envelopePoints.map((point) => ({
      time: point.time * playableSampleCount,
      value: point.value
    }));
    const envelope = el.sparseq2(
      {
        key: `l${idx}:envelope`,
        seq: envelopeSequence,
        interpolate: 1
      },
      samplePosition
    );
    const enveloped = el.mul(rawSample, envelope);
    const delaySamples = el.ms2samps(
      el.sm(el.const({ key: `l${idx}:delay`, value: layer.delayMs }))
    );
    const delayed = el.delay(
      { key: `l${idx}:delayLine`, size: 384000 },
      delaySamples,
      0,
      enveloped
    );
    const filtered = channelFilter(`l${idx}`, delayed, layer.hp, layer.lp);
    const shaped = transientShaper(`l${idx}`, filtered, layer.attack, layer.sustain);
    const clipped = hybridClipper(`l${idx}`, shaped, layer.clipDrive, layer.clipHardness);
    const mix = el.sm(el.const({ key: `l${idx}:mix`, value: layer.gain }));

    return el.mul(mix, clipped);
  });

  // 2. Dedicated Noise Engine
  let noiseNode = el.const({ value: 0 });
  const noiseAudible =
    !state.noise.mute && (!anySolo || state.noise.solo) && state.noise.gain > 0.0005;

  if (noiseAudible) {
    const rawNoise = el.noise({ key: 'noise:src' });
    const nFreq = el.sm(el.const({ key: 'noise:freq', value: state.noise.cutoff }));
    const nRes = el.sm(el.const({ key: 'noise:res', value: state.noise.q }));
    const bpNoise = el.svf({ mode: 'bandpass' }, nFreq, nRes, rawNoise);

    const env = el.adsr(0.001, state.noise.decay, 0.0, 0.015, gate);
    const enveloped = el.mul(bpNoise, env);
    const clippedNoise = hybridClipper('noise', enveloped, state.noise.clipDrive, 0.45);
    const nGain = el.sm(el.const({ key: 'noise:gain', value: state.noise.gain }));

    noiseNode = el.mul(nGain, clippedNoise);
  }

  // 3. Master Bus Summing, Velocity Scaling, Clipper & Ceiling
  const summed = el.mul(velGain, el.add(...layerNodes, noiseNode));
  const masterClipped = hybridClipper('master', summed, state.master.drive, state.master.hardness);
  const ceiling = el.sm(el.const({ key: 'master:ceil', value: state.master.ceiling }));
  const finalOut = el.mul(ceiling, masterClipped);

  return [finalOut, finalOut];
}
