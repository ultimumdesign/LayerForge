import React, { useMemo } from 'react';
import { DEFAULT_ENVELOPE_POINTS, isDefaultEnvelope } from '@dsp/parameters.js';
import { WaveformViewer } from './WaveformViewer.jsx';

export function NoiseWaveform({ noise, waveform, durationSec, previewStatus, playbackId, accent, onChange, editorResolution, onEditorResolutionChange }) {
  const noiseDuration = noise.decay + 0.016;
  const timeline = useMemo(() => new Float32Array(Math.max(1, Math.round(noiseDuration * 44100))), [noiseDuration]);
  const sourcePreview = waveform ? {
    waveform,
    durationSec,
    sourceStart: 0,
    sourceEnd: 1,
    delaySec: 0,
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
    playheadDurationSec: noiseDuration,
    playheadStartFraction: 0,
    playheadEndFraction: 1,
    note: 'Shape the noise with the gain envelope and IN/OUT window. Noise changes on each hit.'
  };

  return (
    <>
      <WaveformViewer {...viewer} fitTrimmed detail={editorResolution} onDetailChange={onEditorResolutionChange} />
      <div className="strip-actions">
        <div className="strip-utility-actions" role="group" aria-label="Noise synth editing and controls">
          <button type="button" className="action-btn action-btn-utility"
            aria-label="Reset noise gain envelope" disabled={isDefaultEnvelope(noise.envelopePoints)}
            onClick={() => onChange({ envelopePoints: DEFAULT_ENVELOPE_POINTS.map((point) => ({ ...point })) })}>RESET ENV</button>
        </div>
        <div className="strip-toggles" role="group" aria-label="Noise synth mute and solo">
          <button type="button" className={`mini-btn ${noise.mute ? 'active-mute' : ''}`}
            aria-label="Mute noise synth" aria-pressed={noise.mute}
            onClick={() => onChange({ mute: !noise.mute })}>M</button>
          <button type="button" className={`mini-btn ${noise.solo ? 'active-solo' : ''}`}
            aria-label="Solo noise synth" aria-pressed={noise.solo}
            onClick={() => onChange({ solo: !noise.solo })}>S</button>
        </div>
      </div>
    </>
  );
}
