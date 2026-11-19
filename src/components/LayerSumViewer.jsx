import React, { useEffect, useId, useMemo, useState } from 'react';
import { reduceComparisonResolution } from '../audio/liveTrace.js';
import { getComparisonCursorRange, getSampleAreaPath, getWaveformPaths } from '../audio/waveform.js';
import { WaveformViewer } from './WaveformViewer.jsx';
import { DspInfoScreen } from './HelpTip.jsx';
import { SignalFlowDiagram } from './SignalFlowDiagram.jsx';

const SUM_HELP =
  'The waveform previews the output after channel and master processing. TRACE captures the last played output and processed channels. Expand to compare them.';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const formatAmplitude = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;

export function SumComparison({ comparison, durationSec, sourceDurationSec, capturedSec, layers, noise, theme, windowMs, live }) {
  const [cursor, setCursor] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const cursorHelpId = useId();
  const lanes = useMemo(() => {
    const hasSolo = layers.some((layer) => layer.solo) || (noise.enabled && noise.solo);
    return [
      { label: 'FINAL OUTPUT', detail: 'AFTER BUS EFFECTS + OUTPUT', color: theme.accent, waveform: comparison.final },
      { label: 'PRE-MASTER', detail: 'SOURCES BEFORE BUS EFFECTS', color: theme.accentSecondary, waveform: comparison.preMaster },
      ...comparison.layers.map((waveform, index) => {
        const layer = layers[index];
        const active = layer.loaded && !layer.mute && (!hasSolo || layer.solo);
        return {
          label: `CH 0${index + 1}`,
          detail: !layer.loaded ? 'EMPTY' : active ? layer.name : 'SILENCED',
          color: theme.channelColors[index] || theme.accent,
          waveform
        };
      }),
      {
        label: 'NOISE',
        detail: noise.enabled && !noise.mute && noise.gain > 0.0005 && (!hasSolo || noise.solo) ? 'BEFORE BUS EFFECTS' : 'SILENCED',
        color: theme.accentTertiary,
        waveform: comparison.noise
      }
    ];
  }, [comparison, layers, noise, theme]);

  const scale = useMemo(() => {
    let peak = 1;
    for (const { waveform } of lanes) {
      for (let index = 0; index < waveform.min.length; index += 1) {
        peak = Math.max(peak, Math.abs(waveform.min[index]), Math.abs(waveform.max[index]));
      }
    }
    return Math.ceil(peak * 10) / 10;
  }, [lanes]);

  const sampleCount = windowMs > 0 ? Math.round(comparison.sampleRate * windowMs / 1000) : 0;
  const viewDuration = windowMs > 0 ? sampleCount / comparison.sampleRate
    : windowMs === -1 ? durationSec : sourceDurationSec || durationSec;
  const paths = useMemo(() => lanes.map(({ waveform }) => windowMs > 0
    ? getSampleAreaPath(waveform.transient, sampleCount, scale, waveform.transientMax)
    : getWaveformPaths(waveform, 0, live ? Math.min(1, capturedSec / durationSec) : 1, 1 / scale).area
  ), [lanes, windowMs, sampleCount, scale, live, capturedSec, durationSec]);
  const rangeAtCursor = (waveform, position) => getComparisonCursorRange(
    waveform, position * viewDuration, durationSec, live ? capturedSec : durationSec, comparison.sampleRate, sampleCount
  );
  const describeRange = (range) => range ? `${formatAmplitude(range.min)} / ${formatAmplitude(range.max)}` : 'NO DATA';
  const movePointer = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * 500;
    const y = (event.clientY - bounds.top) / bounds.height * 112;
    setCursor({ time: clamp((x - 5) / 490, 0, 1), amplitude: clamp((58 - y) / 47, -1, 1) });
  };
  const moveKeyboard = (event, lane) => {
    if (event.key === 'Escape' && cursor) {
      event.preventDefault();
      event.stopPropagation();
      setCursor(null);
      setAnnouncement('Cursor cleared.');
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const previous = cursor || { time: 0, amplitude: 0 };
    const binCount = comparison.final.binCount ?? comparison.final.min.length;
    const timeStep = sampleCount ? 1 / sampleCount : binCount ? durationSec / (binCount * viewDuration) : 0.01;
    const multiplier = event.shiftKey ? 10 : 1;
    const timeIndex = previous.time / timeStep;
    const currentIndex = Math.floor(timeIndex + Number.EPSILON * Math.max(1, timeIndex) * 4);
    const timeDirection = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const position = {
      time: event.key === 'Home' ? 0 : event.key === 'End' ? 1 :
        timeDirection ? clamp((currentIndex + timeDirection * multiplier) * timeStep, 0, 1) : previous.time,
      amplitude: clamp(previous.amplitude +
        (event.key === 'ArrowUp' ? 0.01 * multiplier : event.key === 'ArrowDown' ? -0.01 * multiplier : 0), -1, 1)
    };
    setCursor(position);
    setAnnouncement(`${lane.label}, ${(position.time * viewDuration * 1000).toFixed(3)} milliseconds, reference ${formatAmplitude(position.amplitude * scale)}, ${sampleCount ? 'stereo samples' : 'bin range'} ${describeRange(rangeAtCursor(lane.waveform, position.time))}.`);
  };

  return (
    <div className="sum-comparison">
      <div className="sum-comparison-info">
        <span>{live ? 'LIVE TRACE · ' : 'DSP PREVIEW · '}{windowMs > 0 ? `SAMPLE-LEVEL · FIRST ${windowMs} MS` : `${windowMs === -1 ? (live ? 'FULL CAPTURE' : 'FULL RENDER') : 'SOURCES'} · PEAK ENVELOPES`}</span>
        <span>SHARED SCALE ±{scale.toFixed(1)}</span>
      </div>
      <div className="sum-cursor-readout">
        <strong>CURSOR</strong>
        <span>{cursor ? `${(cursor.time * viewDuration * 1000).toFixed(3)} MS` : 'MOVE OVER A WAVEFORM'}</span>
        <span>{cursor ? `REF ${formatAmplitude(cursor.amplitude * scale)}` : 'SHARED TIME / LEVEL'}</span>
        <button type="button" disabled={!cursor} onClick={() => { setCursor(null); setAnnouncement('Cursor cleared.'); }}
          aria-label="Clear comparison cursor">CLEAR</button>
      </div>
      <span id={cursorHelpId} className="visually-hidden">
        Move over or drag on a waveform to compare lanes. Use left and right arrows to move by one sample or peak bin,
        up and down for the reference level, Shift for larger steps, Home and End for the time limits, and Escape to clear the cursor.
      </span>
      <span className="visually-hidden" aria-live="polite">{announcement}</span>
      <div className="sum-comparison-lanes">
        {lanes.map((lane, laneIndex) => {
          const { label, detail, color } = lane;
          const range = cursor ? rangeAtCursor(lane.waveform, cursor.time) : null;
          return (
            <div className={`sum-comparison-lane${laneIndex < 2 ? ' is-bus-lane' : ''}`} key={label} style={{ '--lane-color': color }}>
              <div className="sum-comparison-label">
                <strong>{label}</strong>
                <span title={cursor ? `${sampleCount ? 'Stereo sample' : 'Peak bin'} minimum / maximum` : detail}>
                  {cursor ? `${sampleCount ? 'SAMPLE' : 'BIN'} ${describeRange(range)}` : detail}
                </span>
              </div>
              <div className="sum-comparison-plot" role="group" tabIndex={0}
                aria-label={`${label} waveform cursor`} aria-describedby={cursorHelpId}
                data-dsp-label="COMPARISON CURSOR"
                data-dsp-help="Compares the same output time across all lanes. The horizontal line is a shared reference level; readouts show stereo sample or peak-bin bounds."
                onPointerMove={movePointer}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  event.currentTarget.focus({ preventScroll: true });
                  movePointer(event);
                }}
                onKeyDown={(event) => moveKeyboard(event, lane)}>
                <svg
                  viewBox="0 0 500 112"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`${label} waveform`}
                >
                  {[5, 127.5, 250, 372.5, 495].map((x) => (
                    <line key={x} x1={x} y1="0" x2={x} y2="112" className="sum-comparison-grid" />
                  ))}
                  {[2, 30, 86, 110].map((y) => (
                    <line key={y} x1="5" y1={y} x2="495" y2={y} className="sum-comparison-grid" />
                  ))}
                  <line x1="5" y1="58" x2="495" y2="58" className="sum-comparison-center" />
                  {windowMs > 0 ? (
                    <path d={paths[laneIndex]} className="sum-comparison-fill" />
                  ) : (
                    <svg x="5" y="0" width="490" height="112" overflow="hidden"
                      viewBox={`5 0 ${490 * viewDuration / durationSec} 112`} preserveAspectRatio="none">
                      <path d={paths[laneIndex]} className="sum-comparison-fill" />
                    </svg>
                  )}
                  {cursor && <g className="sum-comparison-cursor" aria-hidden="true">
                    <line x1={5 + cursor.time * 490} x2={5 + cursor.time * 490} y1="0" y2="112" />
                    <line x1="5" x2="495" y1={58 - cursor.amplitude * 47} y2={58 - cursor.amplitude * 47} />
                  </g>}
                </svg>
              </div>
              <div className="sum-comparison-axis" aria-label={`${label} output time in milliseconds`}>
                {[0, 0.5, 1].map((fraction) => (
                  <span key={fraction}>{fraction === 0 ? 'OUT ' : ''}{(viewDuration * 1000 * fraction).toFixed(windowMs > 0 ? 2 : 1)} MS</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="sum-comparison-note">
        Compare the sources before bus effects with the final output after all effects and output gain.
        All displays share the same output-time window and amplitude scale.
        {windowMs === 0 && sourceDurationSec > 0 && durationSec > sourceDurationSec &&
          ` Choose ${live ? 'FULL CAPTURE' : 'FULL RENDER'} to see the remaining output, including effect tails.`}
        {live && windowMs === 0 && sourceDurationSec > durationSec &&
          ' The trace ends before the source window; audio beyond the capture is not shown.'}
      </p>
    </div>
  );
}

export function LayerSumViewer({
  sum,
  sourceDurationSec,
  previewStatus,
  playheads,
  playbackId,
  theme,
  layers,
  noise,
  master,
  resolution,
  onResolutionChange,
  traceEnabled,
  trace,
  onTraceEnabledChange,
  patchKey,
  expanded,
  onExpandedChange
}) {
  const [expandedView, setExpandedView] = useState('waveform');
  const [zoom, setZoom] = useState(1);
  const [windowMs, setWindowMs] = useState(0);
  const [fitAmplitude, setFitAmplitude] = useState(true);
  const displayTrace = useMemo(
    () => reduceComparisonResolution(trace, expanded ? resolution : 512),
    [trace, expanded, resolution]
  );
  const displaySum = useMemo(() => reduceComparisonResolution(sum, resolution), [sum, resolution]);
  useEffect(() => {
    if (!expanded) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onExpandedChange(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [expanded, onExpandedChange]);

  const viewerProps = {
    title: 'OUTPUT SCOPE',
    peaksOverride: displaySum.peaks,
    durationOverride: displaySum.durationSec || (traceEnabled && trace?.patchKey === patchKey ? trace.capturedSec : 0),
    stereoWaveform: displaySum.min && displaySum.max ? {
      leftMin: displaySum.min,
      leftMax: displaySum.max,
      rightMin: displaySum.min,
      rightMax: displaySum.max
    } : displaySum.stereoWaveform,
    previewStatus,
    playheads,
    playbackId,
    zoom,
    onZoomChange: setZoom,
    accent: theme.accentSecondary,
    compact: true,
    fitAmplitude,
    onFitAmplitudeChange: setFitAmplitude,
    traceEnabled,
    onTraceEnabledChange: (enabled) => {
      onTraceEnabledChange(enabled);
    },
    liveTrace: traceEnabled && displayTrace?.patchKey === patchKey ? displayTrace : null,
    traceAccent: theme.accentTertiary,
    note: SUM_HELP
  };

  return (
    <>
      <WaveformViewer
        {...viewerProps}
        onExpand={() => onExpandedChange(true)}
      />
      {expanded && (
        <div
          className="waveform-sum-expanded-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onExpandedChange(false);
          }}
        >
          <section
            className={`waveform-sum-expanded-dialog${expandedView === 'flow' ? ' is-flow-view' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="waveform-sum-expanded-title"
          >
            <header className="waveform-sum-expanded-header">
              <div>
                <span>OUTPUT SCOPE</span>
                <strong id="waveform-sum-expanded-title">EXPANDED OUTPUT SCOPE</strong>
              </div>
              <div className="waveform-sum-expanded-controls">
                <div className="sum-view-switch" role="group" aria-label="Expanded output scope view">
                  <button type="button" aria-pressed={expandedView === 'waveform'}
                    onClick={() => setExpandedView('waveform')}>WAVEFORM</button>
                  <button type="button" aria-pressed={expandedView === 'flow'}
                    onClick={() => setExpandedView('flow')}>SIGNAL FLOW</button>
                </div>
                {expandedView === 'waveform' && <>
                <button
                  type="button"
                  className="waveform-trace-button"
                  style={{ '--trace-accent': theme.accentTertiary }}
                  aria-pressed={traceEnabled}
                  data-dsp-label="LIVE TRACE" data-dsp-help="Captures the most recent played output and processed lanes for comparison."
                  onClick={() => {
                    onTraceEnabledChange(!traceEnabled);
                  }}
                >
                  {traceEnabled ? `TRACE ${trace?.patchKey === patchKey ? trace.status : 'ARMED'}` : 'TRACE OFF'}
                </button>
                <label className="theme-picker" htmlFor="sum-window" data-dsp-label="COMPARISON VIEW"
                  data-dsp-help="Fits the playable sources, the full render or capture including effect tails, or individual samples at the start; it does not change the audio.">
                  <span>VIEW</span>
                  <select
                    id="sum-window"
                    value={windowMs}
                    onChange={(event) => setWindowMs(Number(event.target.value))}
                    aria-label="Comparison time window"
                  >
                    <option value={0}>SOURCES</option>
                    <option value={-1}>{traceEnabled ? 'FULL CAPTURE' : 'FULL RENDER'}</option>
                    <option value={100}>FIRST 100 MS</option>
                    <option value={20}>FIRST 20 MS</option>
                    <option value={5}>FIRST 5 MS</option>
                  </select>
                </label>
                <label className="theme-picker" htmlFor="sum-resolution" data-dsp-label="WAVEFORM DETAIL"
                  data-dsp-help="Changes peak-envelope comparison resolution only; it does not change the audio.">
                  <span>DETAIL</span>
                  <select
                    id="sum-resolution"
                    value={resolution}
                    onChange={(event) => onResolutionChange(Number(event.target.value))}
                    aria-label="Sum waveform detail"
                    disabled={windowMs > 0}
                    title={windowMs > 0 ? 'Sample-level views show individual samples; detail applies to peak-envelope views.' : undefined}
                  >
                    <option value={512}>STANDARD · 512</option>
                    <option value={2048}>HIGH · 2048</option>
                    <option value={4096}>FINE · 4096</option>
                  </select>
                </label>
                </>}
                <button
                  type="button"
                  className="waveform-editor-close"
                  onClick={() => onExpandedChange(false)}
                >
                  CLOSE
                </button>
              </div>
            </header>
            {expandedView === 'flow' ? (
              <SignalFlowDiagram layers={layers} noise={noise} master={master} theme={theme} />
            ) : traceEnabled && trace?.patchKey === patchKey && trace.comparison ? (
              <SumComparison
                comparison={displayTrace.comparison}
                durationSec={trace.durationSec}
                sourceDurationSec={sourceDurationSec}
                capturedSec={trace.capturedSec}
                layers={layers}
                noise={noise}
                theme={theme}
                windowMs={windowMs}
                live
              />
            ) : !traceEnabled && displaySum.comparison && previewStatus === 'DSP RENDER' ? (
              <SumComparison
                comparison={displaySum.comparison}
                durationSec={displaySum.durationSec}
                sourceDurationSec={sourceDurationSec}
                layers={layers}
                noise={noise}
                theme={theme}
                windowMs={windowMs}
              />
            ) : (
              <p className="sum-comparison-pending" role="status">
                {traceEnabled
                  ? `Trace ${trace?.patchKey === patchKey && trace.status === 'GAP' ? 'interrupted; trigger a new hit.' : trace?.patchKey === patchKey && trace.status === 'ERROR' ? 'failed; toggle trace to retry.' : 'armed; play a hit to capture all lanes.'}`
                  : previewStatus === 'RENDER FAILED'
                  ? 'Processed comparison unavailable: preview render failed.'
                  : 'Rendering processed comparison…'}
              </p>
            )}
            <DspInfoScreen />
          </section>
        </div>
      )}
    </>
  );
}
