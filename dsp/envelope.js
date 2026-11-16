export function getEnvelopeSegmentValue(left, right, amount) {
  const curve = left.curve ?? 0;
  const exponent = Math.pow(2, Math.abs(curve) * 4);
  const factor = curve > 0
    ? 1 - Math.pow(1 - amount, exponent)
    : curve < 0
      ? Math.pow(amount, exponent)
      : amount;
  return left.value + factor * (right.value - left.value);
}

export function getEnvelopeValueAt(time, points) {
  if (!points?.length) return 1;
  const position = Math.max(0, Math.min(1, time));
  if (position <= points[0].time) return points[0].value;
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (position > right.time) continue;
    const left = points[index - 1];
    return getEnvelopeSegmentValue(left, right, (position - left.time) / (right.time - left.time));
  }
  return points.at(-1).value;
}

export function getEnvelopeSequence(points) {
  if (!points.length) return [];
  const sequence = [{ time: points[0].time, value: points[0].value }];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    const steps = left.curve && left.value !== right.value ? 32 : 1;
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      sequence.push({
        time: left.time + (right.time - left.time) * amount,
        value: getEnvelopeSegmentValue(left, right, amount)
      });
    }
  }
  return sequence;
}
