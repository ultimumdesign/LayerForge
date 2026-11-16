import React, { useEffect, useMemo, useState } from 'react';
import { reduceComparisonResolution } from '../audio/liveTrace.js';
import { getSampleAreaPath, getWaveformPaths } from '../audio/waveform.js';
import { WaveformViewer } from './WaveformViewer.jsx';

const SUM_HELP =
  'The waveform previews the output after channel and master processing. TRACE captures the last played output and processed channels. Expand to compare them.';

export function SumComparison({ comparison, durationSec, capturedSec, layers, noise, theme, windowMs, live }) {
  const lanes = useMemo(() => {
    const hasSolo = layers.some((layer) => layer.solo) || (noise.enabled && noise.solo);
    return [
      { label: 'FINAL OUTPUT', detail: 'AFTER MASTER', color: theme.accent, waveform: comparison.final },
      { label: 'PRE-MASTER', detail: 'BEFORE MASTER CLIP', color: theme.accentSecondary, waveform: comparison.preMaster },
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
        detail: noise.enabled && !noise.mute && noise.gain > 0.0005 && (!hasSolo || noise.solo) ? 'PRE-MASTER' : 'SILENCED',
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

  const sampleCount = windowMs ? Math.round(comparison.sampleRate * windowMs / 1000) : 0;
  const viewDuration = windowMs ? sampleCount / comparison.sampleRate : durationSec;

  return (
    <div className="sum-comparison">
      <div className="sum-comparison-info">
        <span>{live ? 'LIVE TRACE · ' : 'DSP PREVIEW · '}{windowMs ? `SAMPLE-LEVEL · FIRST ${windowMs} MS` : 'FULL HIT · PEAK ENVELOPES'}</span>
        <span>SHARED SCALE ±{scale.toFixed(1)}</span>
      </div>
      <div className="sum-comparison-lanes">
        {lanes.map(({ label, detail, color, waveform }) => (
          <div className="sum-comparison-lane" key={label} style={{ '--lane-color': color }}>
            <div className="sum-comparison-label">
              <strong>{label}</strong>
              <span title={detail}>{detail}</span>
            </div>
            <svg
              viewBox="0 0 500 112"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${label} waveform`}
            >
              {[5, 127.5, 250, 372.5, 495].map((x) => (
                <line key={x} x1={x} y1="0" x2={x} y2="112" className="sum-comparison-grid" />
              ))}
              <line x1="5" y1="58" x2="495" y2="58" className="sum-comparison-center" />
              <path
                d={windowMs
                  ? getSampleAreaPath(waveform.transient, sampleCount, scale, waveform.transientMax)
                  : getWaveformPaths(waveform, 0, live ? Math.min(1, capturedSec / durationSec) : 1, 1 / scale).area}
                className="sum-comparison-fill"
              />
            </svg>
          </div>
        ))}
      </div>
      <div className="sum-comparison-axis" aria-label="Comparison output time in milliseconds">
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => (
          <span key={fraction}>{fraction === 0 ? 'OUT ' : ''}{(viewDuration * 1000 * fraction).toFixed(windowMs ? 2 : 1)} MS</span>
        ))}
      </div>
      <p className="sum-comparison-note">
        Channels and noise include their processing and mix, before the master clipper.
        The final output includes master processing and output trim. These lanes share one scale; they are not individually normalized.
      </p>
    </div>
  );
}

export function LayerSumViewer({
  sum,
  previewStatus,
  playheads,
  playbackId,
  theme,
  layers,
  noise,
  resolution,
  onResolutionChange,
  traceEnabled,
  trace,
  onTraceEnabledChange,
  patchKey
}) {
  const [expanded, setExpanded] = useState(false);
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
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [expanded]);

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
        onExpand={() => setExpanded(true)}
      />
      {expanded && (
        <div
          className="waveform-sum-expanded-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExpanded(false);
          }}
        >
          <section
            className="waveform-sum-expanded-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="waveform-sum-expanded-title"
          >
            <header className="waveform-sum-expanded-header">
              <div>
                <span>OUTPUT SCOPE</span>
                <strong id="waveform-sum-expanded-title">EXPANDED WAVEFORM</strong>
              </div>
              <div className="waveform-sum-expanded-controls">
                <button
                  type="button"
                  className="waveform-trace-button"
                  style={{ '--trace-accent': theme.accentTertiary }}
                  aria-pressed={traceEnabled}
                  onClick={() => {
                    onTraceEnabledChange(!traceEnabled);
                  }}
                >
                  {traceEnabled ? `TRACE ${trace?.patchKey === patchKey ? trace.status : 'ARMED'}` : 'TRACE OFF'}
                </button>
                <label className="theme-picker" htmlFor="sum-window">
                  <span>VIEW</span>
                  <select
                    id="sum-window"
                    value={windowMs}
                    onChange={(event) => setWindowMs(Number(event.target.value))}
                    aria-label="Comparison time window"
                  >
                    <option value={0}>FULL HIT</option>
                    <option value={100}>FIRST 100 MS</option>
                    <option value={20}>FIRST 20 MS</option>
                    <option value={5}>FIRST 5 MS</option>
                  </select>
                </label>
                <label className="theme-picker" htmlFor="sum-resolution">
                  <span>DETAIL</span>
                  <select
                    id="sum-resolution"
                    value={resolution}
                    onChange={(event) => onResolutionChange(Number(event.target.value))}
                    aria-label="Sum waveform detail"
                    disabled={windowMs !== 0}
                    title={windowMs ? 'Sample-level views show individual samples; detail applies to the full-hit view.' : undefined}
                  >
                    <option value={512}>STANDARD · 512</option>
                    <option value={2048}>HIGH · 2048</option>
                    <option value={4096}>FINE · 4096</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="waveform-editor-close"
                  onClick={() => setExpanded(false)}
                >
                  CLOSE
                </button>
              </div>
            </header>
            {traceEnabled && trace?.patchKey === patchKey && trace.comparison ? (
              <SumComparison
                comparison={displayTrace.comparison}
                durationSec={trace.durationSec}
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
          </section>
        </div>
      )}
    </>
  );
}
