import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { RotaryKnob } from './RotaryKnob.jsx';
import { DspInfoScreen, HelpEnabledContext } from './HelpTip.jsx';
import { AuditionCloseButton, HitButton } from './HitButton.jsx';
import { PlayDelayControl, WaveformViewer } from './WaveformViewer.jsx';
import { getLayerPreviewWaveform, getPhaseOffset, applyEnvelopeToWaveform, mergeStereoWaveform } from '../audio/waveform.js';
import { createDefaultLayer, DEFAULT_ENVELOPE_POINTS, getSamplePhaseShift, getSampleTrimRange, isDefaultEnvelope } from '../../dsp/parameters.js';
import { getUiTheme } from '../uiThemes.js';

const defaultLayer = createDefaultLayer('');

export function ChannelStrip({
  index,
  layer,
  sampleBuffers,
  sampleRates,
  processedWaveform,
  processedDuration,
  processedStatus,
  editorResolution,
  onEditorResolutionChange,
  channelColors = getUiTheme().channelColors,
  playbackId,
  triggered,
  onHit,
  onFileDrop,
  onNativeSampleBrowse,
  onRevealSample,
  onChange,
  onResetKnobs,
  onSwapSamples,
  allLayers = []
}) {
  const helpEnabled = useContext(HelpEnabledContext);
  const fileInputRef = useRef(null);
  const accent = channelColors[index] || getUiTheme().accent;
  const samples = layer.sampleKey ? sampleBuffers[layer.sampleKey] : null;
  const rightSamples = layer.sampleRightKey ? sampleBuffers[layer.sampleRightKey] : null;
  const sampleRate = sampleRates[layer.sampleKey] || layer.sampleRate || 44100;
  const [waveformEditorOpen, setWaveformEditorOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [hasMinimized, setHasMinimized] = useState(false);
  const [moreControls, setMoreControls] = useState(false);
  const extraKeys = ['hp', 'lp', 'clipHardness', 'phaseOffset'];
  const changedExtraKeys = extraKeys.filter((key) => layer[key] !== defaultLayer[key]);
  const hasVisibleExtraControls = moreControls || changedExtraKeys.length > 0;
  const baseWaveform = useMemo(
    () => {
      const left = getLayerPreviewWaveform(samples);
      if (!rightSamples) return left;
      const right = getLayerPreviewWaveform(rightSamples);
      return mergeStereoWaveform({ leftMin: left.min, leftMax: left.max, rightMin: right.min, rightMax: right.max });
    },
    [samples, rightSamples]
  );
  const waveformEnvelope = useMemo(
    () => applyEnvelopeToWaveform(baseWaveform, layer.envelopePoints),
    [baseWaveform, layer.envelopePoints]
  );
  const trimRange = getSampleTrimRange(samples?.length || 1, layer.trimStart, layer.trimEnd);
  const phase = getSamplePhaseShift(trimRange.sampleCount, layer.phaseOffset);
  const playbackDurationSec = samples?.length
    ? (trimRange.sampleCount - phase.advanceSamples) / (sampleRate * Math.pow(2, layer.pitch / 12))
    : 0;
  const playbackDelaySec = Math.max(0, layer.delayMs) / 1000 +
    phase.delaySamples / (sampleRate * Math.pow(2, layer.pitch / 12));
  const extraKnobs = [
    {
      key: 'hp',
      knob: <RotaryKnob key="hp"
        label="HPF"
        value={layer.hp}
        min={20}
        max={2000}
        defaultValue={20}
        unit="Hz"
        decimals={0}
        description="High-pass cutoff; the filter is bypassed at 20 Hz."
        onChange={(v) => onChange(index, { hp: v })}
      />
    },
    {
      key: 'lp',
      knob: <RotaryKnob key="lp"
        label="LPF"
        value={layer.lp}
        min={800}
        max={20000}
        defaultValue={20000}
        unit="Hz"
        decimals={0}
        description="Low-pass cutoff; the filter is bypassed at 20 kHz."
        onChange={(v) => onChange(index, { lp: v })}
      />
    },
    {
      key: 'clipHardness',
      knob: <RotaryKnob key="clipHardness"
        label="SHAPE"
        value={layer.clipHardness}
        min={0}
        max={1}
        defaultValue={0.25}
        decimals={2}
        accent="var(--theme-accent-secondary)"
        description="Blends the channel clipper from soft saturation to hard clipping."
        onChange={(v) => onChange(index, { clipHardness: v })}
      />
    },
    {
      key: 'phaseOffset',
      knob: <RotaryKnob key="phaseOffset"
        label="PHASE"
        value={layer.phaseOffset}
        min={-0.05}
        max={0.05}
        defaultValue={0}
        decimals={4}
        description="Advances or delays the sample for alignment; it does not invert polarity."
        onChange={(v) => onChange(index, { phaseOffset: v })}
      />
    }
  ];
  const changedExtraKnobs = extraKnobs.filter(({ key }) => changedExtraKeys.includes(key));
  const additionalExtraKnobs = moreControls
    ? extraKnobs.filter(({ key }) => !changedExtraKeys.includes(key))
    : [];
  const hasUnmodifiedAdditionalKnobs = additionalExtraKnobs.length > 0;
  const sourcePreview = layer.loaded && samples?.length ? {
    waveform: processedWaveform,
    durationSec: processedDuration,
    sourceStart: (trimRange.startOffset + phase.advanceSamples) / samples.length,
    sourceEnd: trimRange.endSample / samples.length,
    delaySec: playbackDelaySec,
    playbackDurationSec
  } : undefined;

  const handleAutoAlignPhase = () => {
    if (!samples?.length) return;

    // Find another loaded layer to align against
    const referenceLayer = allLayers.find((l, i) =>
      i !== index && l.loaded && l.sampleKey && sampleBuffers[l.sampleKey]?.length
    );

    if (!referenceLayer || !sampleBuffers[referenceLayer.sampleKey]) {
      alert('Load another sample on a different channel to align against.');
      return;
    }

    const referenceSamples = sampleBuffers[referenceLayer.sampleKey];
    const phaseOffset = Math.max(-0.05, Math.min(0.05, getPhaseOffset(samples, referenceSamples)));

    onChange(index, { phaseOffset });
  };

  useEffect(() => {
    if (!waveformEditorOpen) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setWaveformEditorOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [waveformEditorOpen]);

  const handleDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) onFileDrop(index, file);
  };
  const browseSample = () => {
    if (onNativeSampleBrowse) onNativeSampleBrowse(index);
    else fileInputRef.current?.click();
  };
  const sourcePath = layer.sourceLocation;

  return (
    <section className={`strip strip-channel ${layer.loaded ? '' : 'is-empty'} ${layer.mute ? 'is-muted' : ''} ${minimized ? 'is-minimized' : ''} ${hasMinimized ? 'has-minimized' : ''}`} style={{ '--channel-accent': accent }}
      data-dsp-scope={`CHANNEL ${index + 1}`}>
      <div className="channel-heading">
        <button
          type="button"
          className="channel-minimize"
          onClick={() => {
            setHasMinimized(true);
            setMinimized((value) => !value);
          }}
          aria-label={`${minimized ? 'Restore' : 'Minimize'} channel ${index + 1}`}
          aria-expanded={!minimized}
          data-dsp-label="CHANNEL VIEW" data-dsp-help="Collapses or restores the channel controls without changing the sound."
          title={helpEnabled ? `CHANNEL VIEW: Click to ${minimized ? 'restore' : 'minimize'}.` : undefined}
        >
          {minimized ? '+' : '−'}
        </button>
        <div className="strip-header">
          <span className="strip-tag">CH 0{index + 1}</span>
          <div className="strip-toggles">
            <button
              className={`mini-btn ${layer.mute ? 'active-mute' : ''}`}
              onClick={() => onChange(index, { mute: !layer.mute })}
              aria-label={`Mute channel ${index + 1}`}
              aria-pressed={layer.mute}
              data-dsp-label="MUTE" data-dsp-help="Silences this channel without changing its settings."
            >
              M
            </button>
            <button
              className={`mini-btn ${layer.solo ? 'active-solo' : ''}`}
              onClick={() => onChange(index, { solo: !layer.solo })}
              aria-label={`Solo channel ${index + 1}`}
              aria-pressed={layer.solo}
              data-dsp-label="SOLO" data-dsp-help="Auditions soloed channels and noise while excluding other sources."
            >
              S
            </button>
          </div>
        </div>
        <span
          className="channel-load-indicator"
          role="img"
          aria-label={`Channel ${index + 1} ${layer.loaded ? 'sample loaded' : 'empty'}`}
        />
        {minimized && layer.loaded && <span className="channel-minimized-name">{layer.sourceName || layer.name}</span>}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/wav,audio/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onFileDrop(index, file);
          }}
        />
      </div>

      <WaveformViewer
        title={`CH 0${index + 1}`}
        sampleName={layer.loaded ? layer.sourceName || layer.name : 'NO SAMPLE'}
        onSampleDrop={handleDrop}
        onLoadSample={!layer.loaded ? browseSample : undefined}
        onReplaceSample={layer.loaded ? browseSample : undefined}
        onRevealSample={onRevealSample ? () => onRevealSample(sourcePath) : undefined}
        sampleActions={allLayers.flatMap((other, otherIndex) => otherIndex === index ? [] : [{
          label: `${other.loaded ? 'SWAP SAMPLE WITH' : 'MOVE SAMPLE TO'} CHANNEL ${otherIndex + 1}`,
          onSelect: () => onSwapSamples(otherIndex)
        }])}
        clipGain={layer.inputDb}
        onClipGainChange={(inputDb) => onChange(index, { inputDb })}
        samples={samples}
        rightSamples={rightSamples}
        waveformEnvelope={waveformEnvelope}
        sourcePreview={sourcePreview}
        previewStatus={layer.loaded ? processedStatus : undefined}
        sampleRate={sampleRate}
        fitTrimmed
        durationOverride={playbackDurationSec}
        accent={accent}
        envelopePoints={layer.envelopePoints}
        onEnvelopeChange={(envelopePoints) => onChange(index, { envelopePoints })}
        trimStart={layer.trimStart}
        trimEnd={layer.trimEnd}
        onTrimChange={layer.loaded
          ? (trimRange) => onChange(index, trimRange)
          : undefined}
        playbackId={playbackId}
        playheadDurationSec={playbackDurationSec}
        playheadDelaySec={playbackDelaySec}
        showEnvelopeReset={false}
        note="Processed channel output mapped to the source timeline. Drag IN/OUT to trim and envelope points to shape gain. Drag a segment handle to bend it."
      />

      {waveformEditorOpen && (
        <div
          className="waveform-editor-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setWaveformEditorOpen(false);
          }}
        >
          <section
            className="waveform-editor-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`waveform-editor-title-${index}`}
          >
            <header className="waveform-editor-dialog-header">
              <strong id={`waveform-editor-title-${index}`}>CH 0{index + 1} WAVEFORM EDITOR</strong>
              <div className="module-settings-actions">
                <HitButton triggered={triggered} onHit={onHit} autoFocus />
                <AuditionCloseButton label="Close waveform editor (Enter or Escape)"
                  onClose={() => setWaveformEditorOpen(false)} onHit={onHit} />
              </div>
            </header>
            <WaveformViewer
              title={`CH 0${index + 1}`}
              sampleName={layer.sourceName || layer.name}
              clipGain={layer.inputDb}
              onClipGainChange={(inputDb) => onChange(index, { inputDb })}
              onSampleDrop={handleDrop}
              samples={samples}
              rightSamples={rightSamples}
              waveformEnvelope={waveformEnvelope}
              sourcePreview={sourcePreview}
              detail={editorResolution}
              onDetailChange={onEditorResolutionChange}
              fitTrimmed
              previewStatus={processedStatus}
              sampleRate={sampleRate}
              durationOverride={playbackDurationSec}
              accent={accent}
              envelopePoints={layer.envelopePoints}
              onEnvelopeChange={(envelopePoints) => onChange(index, { envelopePoints })}
              trimStart={layer.trimStart}
              trimEnd={layer.trimEnd}
              onTrimChange={(trimRange) => onChange(index, trimRange)}
              playbackId={playbackId}
              playheadDurationSec={playbackDurationSec}
              playheadDelaySec={playbackDelaySec}
              note="Drag IN/OUT to trim the full sample. Hold Ctrl while dragging trim edges to snap to silence boundaries. Drag envelope points to shape gain and segment handles to bend them."
            />
            <div className="strip-actions waveform-editor-actions">
              <PlayDelayControl title={`CH 0${index + 1}`} value={layer.delayMs}
                onChange={(delayMs) => onChange(index, { delayMs })} />
            </div>
            <DspInfoScreen />
          </section>
        </div>
      )}

      <div className="strip-actions">
        <div className="strip-utility-actions" role="group" aria-label={`Channel ${index + 1} editing and controls`}>
          {layer.loaded && (
            <button
              type="button"
              className="action-btn action-btn-utility"
              onClick={handleAutoAlignPhase}
              aria-label={`Auto-align phase for channel ${index + 1}`}
              data-dsp-label="AUTO ALIGN" data-dsp-help="Estimates a timing offset against another loaded sample to align the layers."
              title={helpEnabled ? 'AUTO ALIGN: Click to align this sample.' : undefined}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="5" />
                <path d="M3 13 13 3" />
              </svg>
            </button>
          )}
          {layer.loaded && (
            <button
              type="button"
              className="action-btn action-btn-utility"
              aria-label={`Open CH 0${index + 1} waveform editor`}
              data-dsp-label="WAVEFORM EDITOR" data-dsp-help="Opens the full source timeline for trim and envelope editing."
              title={helpEnabled ? 'WAVEFORM EDITOR: Click to open.' : undefined}
              onClick={() => setWaveformEditorOpen(true)}
            >
              EDIT
            </button>
          )}
          <button
            type="button"
            className="action-btn action-btn-utility"
            aria-label={`CH 0${index + 1} reset gain envelope to default`}
            data-dsp-label="RESET ENVELOPE" data-dsp-help="Resets the gain envelope to a flat full-level shape."
            title={helpEnabled ? 'RESET ENVELOPE: Click to reset.' : undefined}
            disabled={isDefaultEnvelope(layer.envelopePoints)}
            onClick={() => onChange(index, { envelopePoints: DEFAULT_ENVELOPE_POINTS.map((point) => ({ ...point })) })}
          >
            RESET ENV
          </button>
          <button
            type="button"
            className="action-btn action-btn-utility"
            aria-label={`${moreControls ? 'Show only active' : 'Show all'} additional controls for channel ${index + 1}`}
            aria-expanded={moreControls}
            data-dsp-label="ADDITIONAL CONTROLS" data-dsp-help="Shows extra controls inline; changed controls stay with the main controls when collapsed."
            aria-controls={hasVisibleExtraControls ? `channel-knobs-${index}` : undefined}
            title={helpEnabled ? `ADDITIONAL CONTROLS: Click to ${moreControls ? 'hide default controls' : 'show all'}.` : undefined}
            onClick={() => setMoreControls((value) => !value)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d={moreControls ? 'M3 10 8 5l5 5' : 'M3 6l5 5 5-5'} />
            </svg>
          </button>
          <button
            type="button"
            className="action-btn action-btn-utility"
            aria-label={`Reset knobs for channel ${index + 1}`}
            data-dsp-label="RESET KNOBS" data-dsp-help="Restores channel knob defaults without changing the sample, trim or envelope."
            title={helpEnabled ? 'RESET KNOBS: Click to reset channel knobs.' : undefined}
            onClick={() => onResetKnobs(index)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 6a5.5 5.5 0 1 1 0 4M3 2v4h4" />
            </svg>
          </button>
        </div>
        <PlayDelayControl title={`CH 0${index + 1}`} value={layer.delayMs}
          onChange={(delayMs) => onChange(index, { delayMs })} />
      </div>

      <div className="knob-grid channel-knob-grid" id={`channel-knobs-${index}`}>
        <RotaryKnob
          label="PITCH"
          value={layer.pitch}
          min={-24}
          max={24}
          defaultValue={0}
          unit="st"
          decimals={1}
          description="Changes sample playback rate and pitch in semitones."
          onChange={(v) => onChange(index, { pitch: v })}
        />
        <RotaryKnob
          label="ATTACK"
          value={layer.attack}
          min={-1}
          max={1}
          defaultValue={0}
          decimals={2}
          description="Boosts or reduces the sample's detected transient."
          onChange={(v) => onChange(index, { attack: v })}
        />
        <RotaryKnob
          label="SUSTAIN"
          value={layer.sustain}
          min={-1}
          max={1}
          defaultValue={0}
          decimals={2}
          description="Boosts or reduces the sample's slower envelope."
          onChange={(v) => onChange(index, { sustain: v })}
        />
        <RotaryKnob
          label="CLIP DRV"
          value={layer.clipDrive}
          min={0}
          max={24}
          defaultValue={0}
          unit="dB"
          decimals={1}
          description="Drives the channel clipper; at zero the channel clipper is bypassed."
          accent="var(--theme-accent-secondary)"
          onChange={(v) => onChange(index, { clipDrive: v })}
        />
        <RotaryKnob
          label="WIDTH"
          value={layer.width}
          min={0}
          max={2}
          defaultValue={1}
          decimals={2}
          description="Stereo width: 0 is mono, 1 preserves the original, and values above 1 widen the sides."
          onChange={(v) => onChange(index, { width: v })}
        />
        <RotaryKnob
          label="MIX"
          value={layer.gain}
          min={0}
          max={1.5}
          defaultValue={1}
          decimals={2}
          accent="var(--theme-accent)"
          description="Sets the channel level sent to the signal chain."
          onChange={(v) => onChange(index, { gain: v })}
        />
        {changedExtraKnobs.map(({ knob }) => knob)}
        {hasUnmodifiedAdditionalKnobs && (
          <div className="channel-extra-controls-label" role="separator">
            ADDITIONAL CONTROLS
          </div>
        )}
        {additionalExtraKnobs.map(({ knob }) => knob)}
      </div>
    </section>
  );
}
