import React, { useMemo } from 'react';
import { RotaryKnob } from './RotaryKnob.jsx';
import { WaveformViewer } from './WaveformViewer.jsx';
import { getLayerPreviewPeaks } from '../audio/waveform.js';

export function ChannelStrip({
  index,
  layer,
  sampleBuffers,
  sampleRates,
  playbackId,
  onFileDrop,
  onChange
}) {
  const samples = layer.sampleKey ? sampleBuffers[layer.sampleKey] : null;
  const sampleRate = sampleRates[layer.sampleKey] || layer.sampleRate || 44100;
  const previewPeaks = useMemo(
    () => getLayerPreviewPeaks(samples, layer, sampleRate),
    [samples, sampleRate, layer]
  );
  const playbackDurationSec = samples?.length
    ? (samples.length * (layer.trimEnd ?? 1)) /
      (sampleRate * Math.pow(2, layer.pitch / 12))
    : 0;

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onFileDrop(index, file);
  };

  return (
    <section className={`strip ${layer.mute ? 'is-muted' : ''}`}>
      <div className="strip-header">
        <span className="strip-tag">CH 0{index + 1}</span>
        <div className="strip-toggles">
          <button
            className={`mini-btn ${layer.mute ? 'active-mute' : ''}`}
            onClick={() => onChange(index, { mute: !layer.mute })}
          >
            M
          </button>
          <button
            className={`mini-btn ${layer.solo ? 'active-solo' : ''}`}
            onClick={() => onChange(index, { solo: !layer.solo })}
          >
            S
          </button>
        </div>
      </div>

      <label
        className={`dropzone ${layer.loaded ? 'has-sample' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="sample-name">{layer.name}</div>
        <div className="sample-sub">
          {layer.loaded ? 'LOADED • DROP TO SWAP' : 'DROP WAV OR CLICK'}
        </div>
        <input
          type="file"
          accept="audio/wav,audio/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileDrop(index, f);
          }}
        />
      </label>

      <WaveformViewer
        title={`CH 0${index + 1}`}
        samples={samples}
        sampleRate={sampleRate}
        peaksOverride={previewPeaks}
        durationOverride={playbackDurationSec}
        accent={['#f59e0b', '#22d3ee', '#c084fc'][index]}
        envelopePoints={layer.envelopePoints}
        onEnvelopeChange={(envelopePoints) => onChange(index, { envelopePoints })}
        trimEnd={layer.trimEnd}
        onTrimChange={layer.loaded
          ? (trimEnd) => onChange(index, { trimEnd })
          : undefined}
        playbackId={playbackId}
        playheadDurationSec={playbackDurationSec}
        playheadDelaySec={Math.max(0, layer.delayMs) / 1000}
        note="Approximate processed view · drag end marker to trim playback"
      />

      <div className="knob-grid">
        <RotaryKnob
          label="PITCH"
          value={layer.pitch}
          min={-24}
          max={24}
          defaultValue={0}
          unit="st"
          decimals={1}
          onChange={(v) => onChange(index, { pitch: v })}
        />
        <RotaryKnob
          label="PLAY DLY"
          value={layer.delayMs}
          min={0}
          max={1000}
          defaultValue={0}
          unit="ms"
          decimals={0}
          accent="#22d3ee"
          description="Playback start delay only; no feedback or repeats."
          onChange={(v) => onChange(index, { delayMs: v })}
        />
        <RotaryKnob
          label="ATTACK"
          value={layer.attack}
          min={-1}
          max={1}
          defaultValue={0}
          decimals={2}
          onChange={(v) => onChange(index, { attack: v })}
        />
        <RotaryKnob
          label="SUSTAIN"
          value={layer.sustain}
          min={-1}
          max={1}
          defaultValue={0}
          decimals={2}
          onChange={(v) => onChange(index, { sustain: v })}
        />
        <RotaryKnob
          label="HPF"
          value={layer.hp}
          min={20}
          max={2000}
          defaultValue={25}
          unit="Hz"
          decimals={0}
          onChange={(v) => onChange(index, { hp: v })}
        />
        <RotaryKnob
          label="LPF"
          value={layer.lp}
          min={800}
          max={20000}
          defaultValue={20000}
          unit="Hz"
          decimals={0}
          onChange={(v) => onChange(index, { lp: v })}
        />
        <RotaryKnob
          label="CLIP DRV"
          value={layer.clipDrive}
          min={0}
          max={24}
          defaultValue={0}
          unit="dB"
          decimals={1}
          accent="#fb7185"
          onChange={(v) => onChange(index, { clipDrive: v })}
        />
        <RotaryKnob
          label="SHAPE"
          value={layer.clipHardness}
          min={0}
          max={1}
          defaultValue={0.25}
          decimals={2}
          accent="#fb7185"
          onChange={(v) => onChange(index, { clipHardness: v })}
        />
        <RotaryKnob
          label="MIX"
          value={layer.gain}
          min={0}
          max={1.5}
          defaultValue={0.85}
          decimals={2}
          accent="#34d399"
          onChange={(v) => onChange(index, { gain: v })}
        />
      </div>
    </section>
  );
}
