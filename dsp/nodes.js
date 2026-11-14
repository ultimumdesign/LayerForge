import { el } from '@elemaudio/core';

/**
 * Differential Envelope Transient Shaper
 * Compares a 2ms fast envelope against a 25ms slow envelope to isolate attack vs. sustain.
 */
export function transientShaper(key, sig, attackAmt, sustainAmt) {
  const rectified = el.abs(sig);
  const fastEnv = el.env(el.tau2pole(0.002), el.tau2pole(0.025), rectified);
  const slowEnv = el.env(el.tau2pole(0.025), el.tau2pole(0.180), rectified);

  const transientDiff = el.max(0, el.sub(fastEnv, slowEnv));
  const atkGain = el.mul(el.sm(el.const({ key: `${key}:atk`, value: attackAmt * 4.5 })), transientDiff);
  const susGain = el.mul(el.sm(el.const({ key: `${key}:sus`, value: sustainAmt * 2.2 })), slowEnv);

  const envScale = el.max(0, el.add(1, el.add(atkGain, susGain)));
  return el.mul(sig, envScale);
}

/**
 * Variable Soft-to-Hard Clipper
 * hardness: 0.0 = smooth analog tanh saturation, 1.0 = digital brickwall hard clip
 */
export function hybridClipper(key, sig, driveDb, hardness) {
  const linearDrive = Math.pow(10, driveDb / 20);
  const drive = el.sm(el.const({ key: `${key}:drv`, value: linearDrive }));
  const hard = el.sm(el.const({ key: `${key}:hrd`, value: hardness }));

  const driven = el.mul(drive, sig);
  const softClipped = el.tanh(driven);
  const hardClipped = el.max(-1, el.min(1, driven));

  return el.add(
    el.mul(el.sub(1, hard), softClipped),
    el.mul(hard, hardClipped)
  );
}

/**
 * Serial High-Pass + Low-Pass State Variable Filter
 */
export function channelFilter(key, sig, hpFreq, lpFreq) {
  const hp = el.sm(el.const({ key: `${key}:hp`, value: hpFreq }));
  const lp = el.sm(el.const({ key: `${key}:lp`, value: lpFreq }));

  const highPassed = el.svf({ mode: 'highpass' }, hp, 0.707, sig);
  return el.svf({ mode: 'lowpass' }, lp, 0.707, highPassed);
}
