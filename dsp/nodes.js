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

  const highPassed = hpFreq <= 20 ? sig : el.svf({ mode: 'highpass' }, hp, 0.707, sig);
  return lpFreq >= 20000 ? highPassed : el.svf({ mode: 'lowpass' }, lp, 0.707, highPassed);
}

export function saturator(key, sig, driveDb, mixAmount) {
  const drive = Math.pow(10, driveDb / 20);
  const wet = el.div(el.tanh(el.mul(el.sm(el.const({ key: `${key}:drive`, value: drive })), sig)), Math.tanh(drive));
  const mix = el.sm(el.const({ key: `${key}:mix`, value: mixAmount }));
  return el.add(el.mul(el.sub(1, mix), sig), el.mul(mix, wet));
}

export function glueCompressor(left, right, { glueThreshold, glueRatio, glueAttack, glueRelease, glueKnee = 6, glueMix = 1 }, includeMeter = false) {
  const peak = el.max(el.abs(left), el.abs(right));
  const attack = el.sm(el.const({ key: 'glue:attack', value: glueAttack }));
  const release = el.sm(el.const({ key: 'glue:release', value: glueRelease }));
  const threshold = el.sm(el.const({ key: 'glue:threshold', value: glueThreshold }));
  const slope = el.sm(el.const({ key: 'glue:slope', value: -(1 - 1 / glueRatio) }));
  const envelope = el.env(el.tau2pole(attack), el.tau2pole(release), peak);
  const over = el.sub(el.gain2db(el.max(envelope, 1e-8)), threshold);
  const knee = Math.max(0.01, glueKnee);
  const inKnee = el.min(knee, el.max(0, el.add(over, knee / 2)));
  const compressedOver = el.add(el.div(el.mul(inKnee, inKnee), 2 * knee), el.max(0, el.sub(over, knee / 2)));
  const reduction = el.mul(-1, el.mul(compressedOver, slope));
  const gain = el.db2gain(el.mul(-1, reduction));
  const mix = el.sm(el.const({ key: 'glue:mix', value: glueMix }));
  const dryAmount = el.sub(1, mix);
  const blend = (dry) => el.add(el.mul(dryAmount, dry), el.mul(mix, el.mul(dry, gain)));
  return includeMeter ? [blend(left), blend(right), reduction] : [blend(left), blend(right)];
}
