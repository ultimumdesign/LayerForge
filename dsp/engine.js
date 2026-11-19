import { createNode, el } from '@elemaudio/core';
import { builtinImpulseKey } from './convolution.js';
import { DEFAULT_BUS_ORDER, DEFAULT_ENVELOPE_POINTS, getSamplePhaseShift, getSampleTrimRange } from './parameters.js';
import { getEnvelopeSequence } from './envelope.js';
import { transientShaper, hybridClipper, channelFilter, colorNoise, glueCompressor, saturator } from './nodes.js';

/**
 * Builds the complete 3-Channel Drum Layerer + Noise Engine + Master Bus DSP Graph.
 * Pure functional graph: runs identically in Web Audio, Offline WAV Export, and Native VST3.
 */
function buildDrumNodes(state, nativeMidi = false) {
  const gate = nativeMidi
    ? createNode('layerforge-midi-gate', {}, [])
    : el.const({ key: 'midi:gate', value: state.gate });
  const nativeTrigger = nativeMidi ? createNode('layerforge-midi-trigger', {}, []) : null;
  const triggerCount = nativeMidi ? el.accum(nativeTrigger, 0) : null;
  const velocity = nativeMidi
    ? createNode('layerforge-midi-velocity', {}, [])
    : el.const({ key: 'midi:vel', value: (state.velocity ?? 1.0) - 1 });
  const velGain = el.add(1, nativeMidi ? velocity : el.sm(velocity));

  const anySolo =
    state.layers.some((l) => l.solo) || Boolean(state.noise.enabled && state.noise.solo);

  // 1. Sample Layers
  const layerNodes = state.layers.map((layer, idx) => {
    const isAudible = layer.loaded && !layer.mute && (!anySolo || layer.solo);
    if (!isAudible) {
      return [el.const({ value: 0 }), el.const({ value: 0 })];
    }

    const pitchRate = el.add(1, el.sm(
      el.const({ key: `l${idx}:rate`, value: Math.pow(2, layer.pitch / 12) - 1 })
    ));
    const sourceRate = el.const({ value: layer.sampleRate || 44100 });
    const rate = el.div(el.mul(pitchRate, sourceRate), el.sr());

    const sampleCount = Math.max(1, layer.sampleCount || 1);
    const trimRange = getSampleTrimRange(sampleCount, layer.trimStart, layer.trimEnd);
    const playableSampleCount = trimRange.sampleCount;

    const phase = getSamplePhaseShift(playableSampleCount, layer.phaseOffset);

    const playheadRate = el.div(
      el.mul(rate, el.sr()),
      el.const({ value: playableSampleCount })
    );
    const playhead = el.syncphasor(playheadRate, nativeMidi ? triggerCount : gate);
    const samplePosition = el.mul(playhead, el.const({ value: playableSampleCount }));
    const trigger = nativeMidi ? nativeTrigger : el.max(0, el.sub(gate, el.z(gate)));
    const activeVoice = el.mod(nativeMidi ? triggerCount : el.accum(trigger, 0), 2);
    const voices = [0, 1].map((index) => {
      const selected = el.eq(activeVoice, index);
      const voiceTrigger = el.mul(nativeMidi ? triggerCount : gate, selected);
      const position = el.sub(el.accum(rate, voiceTrigger), rate);
      const armed = el.latch(voiceTrigger, 1);
      const active = el.mul(
        armed, el.geq(position, 0),
        el.le(el.add(position, 1e-7), playableSampleCount - phase.advanceSamples)
      );
      const fade = el.select(selected, 1, el.smooth(el.tau2pole(0.01), selected));
      return {
        position: el.div(
          el.add(trimRange.startOffset + phase.advanceSamples, position),
          Math.max(1, sampleCount - 1)
        ),
        gain: el.mul(active, fade)
      };
    });
    const envelopeSequence = getEnvelopeSequence(layer.envelopePoints).map((point) => ({
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
    const inputGain = el.const({ key: `l${idx}:input`, value: Math.pow(10, (layer.inputDb ?? 0) / 20) });
    const phaseDelaySeconds = phase.delaySamples /
      ((layer.sampleRate || 44100) * Math.pow(2, layer.pitch / 12));
    const delaySamples = el.add(
      el.ms2samps(el.sm(el.const({ key: `l${idx}:delay`, value: layer.delayMs }))),
      el.mul(el.sr(), el.const({ key: `l${idx}:phaseDelay`, value: phaseDelaySeconds }))
    );
    const processChannel = (path, side) => {
      const key = `l${idx}:${side}`;
      const rawSample = el.add(...voices.map((voice, index) =>
        el.mul(voice.gain, el.table({ key: `${key}:smp${index}`, path }, voice.position))
      ));
      const enveloped = el.mul(rawSample, inputGain, envelope);
      const delayed = el.delay({ key: `${key}:delayLine`, size: 384000 }, delaySamples, 0, enveloped);
      const filtered = channelFilter(key, delayed, layer.hp, layer.lp);
      const shaped = transientShaper(key, filtered, layer.attack, layer.sustain);
      return layer.clipDrive <= 0 ? shaped : hybridClipper(key, shaped, layer.clipDrive, layer.clipHardness);
    };
    const left = processChannel(layer.sampleKey, 'left');
    const right = processChannel(layer.sampleRightKey || layer.sampleKey, 'right');
    const mid = el.mul(0.5, el.add(left, right));
    const width = el.add(1, el.sm(el.const({ key: `l${idx}:width`, value: (layer.width ?? 1) - 1 })));
    const side = el.mul(0.5, el.sub(left, right), width);
    const mix = el.add(1, el.sm(el.const({ key: `l${idx}:mix`, value: layer.gain - 1 })));

    return [el.mul(mix, el.add(mid, side)), el.mul(mix, el.sub(mid, side))];
  });

  // 2. Dedicated Noise Engine
  let noiseNode = el.const({ value: 0 });
  const noiseAudible =
    state.noise.enabled && !state.noise.mute && (!anySolo || state.noise.solo) && state.noise.gain > 0.0005;

  if (noiseAudible) {
    const rawNoise = colorNoise(el.noise({ key: 'noise:src' }), state.noise.type);
    const nFreq = el.sm(el.const({ key: 'noise:freq', value: state.noise.cutoff }));
    const nRes = el.sm(el.const({ key: 'noise:res', value: state.noise.q }));
    const bpNoise = el.svf({ mode: 'bandpass' }, nFreq, nRes, rawNoise);

    // Time-based envelope: the trigger only restarts it, so DECAY is not cut short by the 28 ms gate.
    const attack = 0.001;
    const tail = 0.015;
    const decay = state.noise.decay;
    const restart = nativeMidi ? triggerCount : gate;
    const armed = nativeMidi ? el.geq(triggerCount, 1) : el.latch(gate, 1);
    const elapsed = el.div(el.sub(el.accum(1, restart), 1), el.sr());
    const delay = Math.max(0, state.noise.delayMs ?? 0) / 1000;
    const seconds = delay ? el.max(0, el.sub(elapsed, delay)) : elapsed;
    const attackRamp = el.min(1, el.div(seconds, attack));
    const decayCurve = el.exp(el.mul(-6.91 / decay, seconds));
    const tailFade = el.max(0, el.min(1, el.sub(1, el.div(el.sub(seconds, decay), tail))));
    const env = el.mul(armed, delay ? el.geq(elapsed, delay) : 1, attackRamp, decayCurve, tailFade);
    const trimStart = state.noise.trimStart ?? 0;
    const trimEnd = state.noise.trimEnd ?? 1;
    const points = state.noise.envelopePoints || DEFAULT_ENVELOPE_POINTS;
    const defaultEnvelope = points.length === 2 &&
      points[0].time === 0 && points[0].value === 1 &&
      points[1].time === 1 && points[1].value === 1;
    let enveloped = el.mul(bpNoise, env);
    if (trimStart !== 0 || trimEnd !== 1 || !defaultEnvelope) {
      const duration = state.noise.decay + 0.016;
      const position = delay
        ? el.div(seconds, duration)
        : el.syncphasor(el.div(1, duration), nativeMidi ? triggerCount : gate);
      const normalized = el.div(el.sub(position, trimStart), trimEnd - trimStart);
      const sequence = getEnvelopeSequence(points).map((point) => ({ time: point.time, value: point.value }));
      const shape = el.sparseq2({ key: 'noise:envelope', seq: sequence, interpolate: 1 }, normalized);
      const inside = el.mul(el.geq(position, trimStart), el.leq(position, trimEnd));
      enveloped = el.mul(enveloped, shape, inside);
    }
    const clippedNoise = hybridClipper('noise', enveloped, state.noise.clipDrive, 0.45);
    const nGain = el.sm(el.const({ key: 'noise:gain', value: state.noise.gain }));

    noiseNode = el.mul(nGain, clippedNoise);
  }

  // 3. Master Bus Summing, Velocity Scaling, Clipper & Ceiling
  const summed = [0, 1].map((side) =>
    el.mul(velGain, el.add(...layerNodes.map((layer) => layer[side]), noiseNode))
  );
  let bus = layerNodes[0].map((_, side) => el.mul(velGain, el.add(...layerNodes.map((layer) => layer[side]))));
  let saturationInput = el.const({ value: 0 });
  let saturationOutput = el.const({ value: 0 });
  let glueInput = el.const({ value: 0 });
  let glueOutput = el.const({ value: 0 });
  let glueReduction = el.const({ value: 0 });
  let convolveInput = el.const({ value: 0 });
  let convolveOutput = el.const({ value: 0 });
  let ringModInput = el.const({ value: 0 });
  let ringModOutput = el.const({ value: 0 });
  const stereoPeak = (signals) => el.max(el.abs(signals[0]), el.abs(signals[1]));
  const effectGain = (key, db) => el.add(1, el.sm(el.const({ key, value: Math.pow(10, db / 20) - 1 })));
  for (const module of state.master.busOrder || DEFAULT_BUS_ORDER) {
    if (module === 'noise') {
      bus = bus.map((signal) => el.add(signal, el.mul(velGain, noiseNode)));
    } else if (module === 'convolve') {
      convolveInput = stereoPeak(bus);
      if (state.master.convolveEnabled && !state.master.convolveMute) {
        const { convolveProfile: profile } = state.master;
        const paths = [builtinImpulseKey(profile, 'left'), builtinImpulseKey(profile, 'right')];
        const mix = el.sm(el.const({ key: 'master:convolve:mix', value: state.master.convolveMix }));
        const gain = effectGain('master:convolve:output', state.master.convolveGainDb);
        const delay = el.mul(el.sr(), el.sm(el.const({
          key: 'master:convolve:predelay', value: state.master.convolvePredelay / 1000
        })));
        bus = bus.map((signal, side) => {
          const delayed = el.delay({ key: `master:convolve:delay:${side}`, size: 192000 }, delay, 0, signal);
          const wet = el.convolve({ key: `master:convolve:${side}:${paths[side]}`, path: paths[side] }, delayed);
          const filtered = channelFilter(`master:convolve:filter:${side}`, wet,
            state.master.convolveLowCut, state.master.convolveHighCut);
          return el.mul(gain, el.add(el.mul(el.sub(1, mix), signal), el.mul(mix, filtered)));
        });
      }
      convolveOutput = stereoPeak(bus);
    } else if (module === 'ringMod') {
      ringModInput = stereoPeak(bus);
      if (state.master.ringModEnabled && !state.master.ringModMute) {
        const frequency = el.sm(el.const({ key: 'master:ringMod:frequency', value: state.master.ringModFrequency }));
        const trigger = nativeMidi ? triggerCount : el.accum(el.max(0, el.sub(gate, el.z(gate))), 0);
        const phase = el.sm(el.const({ key: 'master:ringMod:phase', value: state.master.ringModPhase / 360 }));
        const bias = el.sm(el.const({ key: 'master:ringMod:bias', value: state.master.ringModBias }));
        const rectify = el.sm(el.const({ key: 'master:ringMod:rectify', value: state.master.ringModRectify }));
        const spread = el.sm(el.const({ key: 'master:ringMod:spread', value: state.master.ringModSpread }));
        const mix = el.sm(el.const({ key: 'master:ringMod:mix', value: state.master.ringModMix }));
        const gain = effectGain('master:ringMod:output', state.master.ringModGainDb);
        bus = bus.map((signal, side) => {
          const rate = el.mul(frequency, el.add(1, el.mul(side === 0 ? -0.05 : 0.05, spread)));
          const carrier = el.sin(el.mul(2 * Math.PI, el.add(el.syncphasor(rate, trigger), phase)));
          const absolute = el.abs(carrier);
          const shaped = el.add(carrier,
            el.mul(el.max(0, rectify), el.sub(absolute, carrier)),
            el.mul(el.max(0, el.mul(-1, rectify)), el.sub(el.mul(-1, absolute), carrier)));
          return el.mul(gain, signal, el.add(el.sub(1, mix), el.mul(mix, el.add(shaped, bias))));
        });
      }
      ringModOutput = stereoPeak(bus);
    } else if (module === 'saturation') {
      saturationInput = stereoPeak(bus);
      if (state.master.saturationEnabled && !state.master.saturationMute) {
        const gain = effectGain('master:saturation:output', state.master.saturationGainDb ?? 0);
        bus = bus.map((signal, side) => el.mul(gain, saturator(`master:saturation:${side}`, signal, state.master.saturationDrive, state.master.saturationMix, state.master.saturationType)));
      }
      saturationOutput = stereoPeak(bus);
    } else if (module === 'glue') {
      glueInput = stereoPeak(bus);
      if (state.master.glueEnabled && !state.master.glueMute) {
        const [left, right, reduction] = glueCompressor(...bus, state.master, true);
        const gain = effectGain('master:glue:output', state.master.glueGainDb ?? 0);
        bus = [el.mul(gain, left), el.mul(gain, right)];
        glueReduction = reduction;
      }
      glueOutput = stereoPeak(bus);
    }
  }
  const masterClipped = bus.map((signal, side) =>
    hybridClipper(`master:${side}`, signal, state.master.drive, state.master.hardness)
  );
  const ceiling = el.sm(el.const({ key: 'master:ceil', value: state.master.ceiling }));
  const outputGain = el.const({ key: 'master:output', value: Math.pow(10, (state.master.outputDb ?? 0) / 20) });
  const finalOut = masterClipped.map((signal) => el.mul(outputGain, ceiling, signal));

  return {
    finalOut,
    summed,
    layers: layerNodes,
    noise: noiseNode,
    velGain,
    effectMeters: [saturationInput, saturationOutput, glueInput, glueOutput, glueReduction, convolveInput, convolveOutput, ringModInput, ringModOutput]
  };
}

export function buildDrumGraph(state, monitorOutput = false, nativeMidi = false) {
  const { finalOut, summed, layers, noise, velGain, effectMeters } = buildDrumNodes(state, nativeMidi);
  return monitorOutput
    ? [
      ...finalOut, nativeMidi ? createNode('layerforge-midi-trigger', {}, []) : el.const({ key: 'midi:gate', value: state.gate }),
      ...layers.flatMap((pair) => pair.map((node) => el.mul(velGain, node))),
      el.mul(velGain, noise), el.mul(velGain, noise), ...summed, ...effectMeters
    ]
    : finalOut;
}

export function buildDrumPreviewGraph(state) {
  const { finalOut, summed, layers, noise, velGain } = buildDrumNodes(state);
  return [
    ...finalOut,
    ...layers.flatMap((pair) => pair.map((node) => el.mul(velGain, node))),
    el.mul(velGain, noise), el.mul(velGain, noise),
    ...summed
  ];
}
