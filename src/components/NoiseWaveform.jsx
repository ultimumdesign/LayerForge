import React, { useMemo } from 'react';
import { WaveformViewer } from './WaveformViewer.jsx';

export function NoiseWaveform({ noise, waveform, durationSec, previewStatus, playbackId, accent, onChange, editorResolution, onEditorResolutionChange }) {
  const noiseDuration = noise.decay + 0.016;
  const delaySec = Math.max(0, noise.delayMs ?? 0) / 1000;
  const timeline = useMemo(() => new Float32Array(Math.max(1, Math.round(noiseDuration * 44100))), [noiseDuration]);
  const sourcePreview = waveform ? {
    waveform,
    durationSec,
    sourceStart: 0,
    sourceEnd: 1,
    delaySec,
    playbackDurationSec: noiseDuration
  } : undefined;

  const viewer = {
    title: 'NOISE',
    eyebrow: 'NOISE WAVEFORM',
    samples: timeline,
    sourcePreview,
    previewStatus,
    sampleRate: 44100,
    durationOverride: noiseDuration,
    accent,
    envelopePoints: noise.envelopePoints,
    onEnvelopeChange: (envelopePoints) => onChange({ envelopePoints }),
    showEnvelopeReset: false,
    trimStart: noise.trimStart,
    trimEnd: noise.trimEnd,
    onTrimChange: onChange,
    snapSilence: false,
    playbackId,
    playheadDelaySec: delaySec,
    playheadDurationSec: noiseDuration,
    playheadStartFraction: 0,
    playheadEndFraction: 1,
    note: 'Shape the noise with the gain envelope and IN/OUT window. Noise changes on each hit.'
  };

  return (
    <>
      <WaveformViewer {...viewer} fitTrimmed detail={editorResolution} onDetailChange={onEditorResolutionChange} />
    </>
  );
}
