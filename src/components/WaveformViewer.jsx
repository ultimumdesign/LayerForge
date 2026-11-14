import React, { useId, useMemo, useRef, useState } from 'react';
import { getWaveformPeaks } from '../audio/waveform.js';
import { MIN_TRIM_RANGE } from '../../dsp/parameters.js';
import { Waveform3DCanvas } from './Waveform3DCanvas.jsx';

const MAX_ENVELOPE_POINTS = 12;
const MIN_POINT_SPACING = 0.005;
const ENVELOPE_LEFT = 5;
const ENVELOPE_WIDTH = 490;

function envelopeX(time) {
  return ENVELOPE_LEFT + time * ENVELOPE_WIDTH;
}

function envelopeTimeX(time, trimStart, trimEnd) {
  return envelopeX(trimStart + time * (trimEnd - trimStart));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function WaveformViewer({
  samples,
  sampleRate = 44100,
  peaksOverride,
  durationOverride,
  title,
  accent = '#f59e0b',
  envelopePoints,
  onEnvelopeChange,
  trimStart = 0,
  trimEnd = 1,
  onTrimChange,
  stereoWaveform,
  previewStatus,
  playheads = [],
  playbackId = 0,
  playbackStartedAt = 0,
  playheadDurationSec,
  playheadDelaySec = 0,
  note,
  compact = false,
  onExpand
}) {
  const svgRef = useRef(null);
  const dragTarget = useRef(null);
  const [displayMode, setDisplayMode] = useState('3d');
  const instanceId = useId().replace(/[^a-z0-9_-]/gi, '');
  const safeTrimEnd = clamp(trimEnd, MIN_TRIM_RANGE, 1);
  const safeTrimStart = clamp(trimStart, 0, safeTrimEnd - MIN_TRIM_RANGE);
  const trimSpan = safeTrimEnd - safeTrimStart;
  const peaks = useMemo(
    () => peaksOverride || getWaveformPeaks(samples),
    [peaksOverride, samples]
  );
  const duration =
    durationOverride ??
    (samples?.length ? (samples.length * trimSpan) / sampleRate : 0);
  const gradientId = `wave-fill-${title.replace(/[^a-z0-9]/gi, '')}-${instanceId}`;
  const envelopePath = useMemo(() => {
    if (!envelopePoints?.length) return '';
    return envelopePoints
      .map((point, index) => {
        const x = envelopeTimeX(point.time, safeTrimStart, safeTrimEnd);
        const y = 98 - point.value * 76;
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [envelopePoints, safeTrimStart, safeTrimEnd]);
  const envelopeAreaPath = envelopePath
    ? `M${envelopeX(safeTrimStart)},98 ${envelopePath.replace(/^M/, 'L')} L${envelopeX(safeTrimEnd)},98 Z`
    : '';
  const trimStartX = envelopeX(safeTrimStart);
  const trimEndX = envelopeX(safeTrimEnd);
  const show3D = compact && displayMode === '3d';

  const getViewPosition = (event) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

    const x = ((event.clientX - bounds.left) / bounds.width) * 500;
    const y = ((event.clientY - bounds.top) / bounds.height) * 112;
    return {
      samplePosition: clamp((x - ENVELOPE_LEFT) / ENVELOPE_WIDTH, 0, 1),
      value: clamp((98 - y) / 76, 0, 1)
    };
  };

  const getEnvelopePosition = (event) => {
    const position = getViewPosition(event);
    if (!position) return null;
    return {
      ...position,
      time: clamp((position.samplePosition - safeTrimStart) / trimSpan, 0, 1)
    };
  };

  const beginPointDrag = (event, index) => {
    if (!onEnvelopeChange) return;
    event.preventDefault();
    event.stopPropagation();
    dragTarget.current = { type: 'point', index };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const beginTrimDrag = (event, edge) => {
    if (!onTrimChange) return;
    event.preventDefault();
    event.stopPropagation();
    dragTarget.current = { type: 'trim', edge };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const movePoint = (event) => {
    const target = dragTarget.current;
    if (!target) return;
    const position = getViewPosition(event);
    if (!position) return;
    if (target.type === 'trim') {
      const samplePosition = position.samplePosition;
      onTrimChange?.(
        target.edge === 'start'
          ? {
              trimStart: clamp(samplePosition, 0, safeTrimEnd - MIN_TRIM_RANGE),
              trimEnd: safeTrimEnd
            }
          : {
              trimStart: safeTrimStart,
              trimEnd: clamp(samplePosition, safeTrimStart + MIN_TRIM_RANGE, 1)
            }
      );
      return;
    }

    if (!onEnvelopeChange) return;
    const index = target.index;
    const envelopePosition = {
      ...position,
      time: clamp((position.samplePosition - safeTrimStart) / trimSpan, 0, 1)
    };

    const previous = envelopePoints[index - 1];
    const next = envelopePoints[index + 1];
    const time = index === 0
      ? 0
      : index === envelopePoints.length - 1
        ? 1
        : clamp(
          envelopePosition.time,
            previous.time + MIN_POINT_SPACING,
            next.time - MIN_POINT_SPACING
          );
    onEnvelopeChange(
      envelopePoints.map((point, pointIndex) =>
        pointIndex === index
        ? { time, value: envelopePosition.value }
          : point
      )
    );
  };

  const endPointDrag = (event) => {
    if (dragTarget.current === null) return;
    dragTarget.current = null;
    if (svgRef.current?.hasPointerCapture(event.pointerId))
      svgRef.current.releasePointerCapture(event.pointerId);
  };

  const addEnvelopePoint = (event) => {
    if (!onEnvelopeChange || envelopePoints.length >= MAX_ENVELOPE_POINTS) return;
    if (event.target.closest?.('[data-envelope-point], [data-waveform-control]')) return;

    const position = getEnvelopePosition(event);
    if (
      !position ||
      position.samplePosition < safeTrimStart ||
      position.samplePosition > safeTrimEnd
    ) return;
    const nextIndex = envelopePoints.findIndex((point) => point.time > position.time);
    if (nextIndex < 0) return;

    const previous = envelopePoints[nextIndex - 1];
    const next = envelopePoints[nextIndex];
    if (
      position.time - previous.time < MIN_POINT_SPACING ||
      next.time - position.time < MIN_POINT_SPACING
    ) {
      return;
    }

    const updatedPoints = [...envelopePoints];
    updatedPoints.splice(nextIndex, 0, position);
    onEnvelopeChange(updatedPoints);
  };

  const removeEnvelopePoint = (event, index) => {
    event.preventDefault();
    event.stopPropagation();
    if (!onEnvelopeChange || index === 0 || index === envelopePoints.length - 1) return;
    onEnvelopeChange(envelopePoints.filter((_, pointIndex) => pointIndex !== index));
  };

  const adjustEnvelopePoint = (event, index) => {
    const amount = event.shiftKey ? 0.01 : 0.05;
    let timeDelta = 0;
    let valueDelta = 0;
    if (event.key === 'ArrowUp') valueDelta = amount;
    else if (event.key === 'ArrowDown') valueDelta = -amount;
    else if (event.key === 'ArrowLeft') timeDelta = -amount;
    else if (event.key === 'ArrowRight') timeDelta = amount;
    else return;

    event.preventDefault();
    const point = envelopePoints[index];
    const time = index === 0
      ? 0
      : index === envelopePoints.length - 1
        ? 1
        : clamp(
            point.time + timeDelta,
            envelopePoints[index - 1].time + MIN_POINT_SPACING,
            envelopePoints[index + 1].time - MIN_POINT_SPACING
          );
    onEnvelopeChange(
      envelopePoints.map((current, pointIndex) =>
        pointIndex === index
          ? { time, value: clamp(point.value + valueDelta, 0, 1) }
          : current
      )
    );
  };

  const adjustTrim = (event, edge) => {
    if (!onTrimChange || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.01;
    const startEdge = edge === 'start';
    const current = startEdge ? safeTrimStart : safeTrimEnd;
    const min = startEdge ? 0 : safeTrimStart + MIN_TRIM_RANGE;
    const max = startEdge ? safeTrimEnd - MIN_TRIM_RANGE : 1;
    const next = event.key === 'Home'
      ? min
      : event.key === 'End'
        ? max
        : clamp(current + (event.key === 'ArrowRight' ? step : -step), min, max);
    onTrimChange(
      startEdge
        ? { trimStart: next, trimEnd: safeTrimEnd }
        : { trimStart: safeTrimStart, trimEnd: next }
    );
  };

  const channelPlayheads = playheads.length
    ? playheads
    : playbackId && duration
      ? [
          {
          id: playbackId,
          color: accent,
          startFraction: safeTrimStart,
          endFraction: safeTrimEnd,
            delaySec: playheadDelaySec,
            durationSec: playheadDurationSec || duration
          }
        ]
      : [];

  return (
    <section
      className={`waveform-panel${compact ? ' waveform-panel-compact' : ''}`}
      style={{ '--wave-accent': accent }}
    >
      <div className="waveform-heading">
        <div>
          <span className="waveform-eyebrow">
            {compact ? 'MASTER STEREO FIELD' : 'LIVE CHANNEL ESTIMATE'}
          </span>
          <strong>{title}</strong>
        </div>
        <div className="waveform-heading-controls">
          {previewStatus && <span className="waveform-status">{previewStatus}</span>}
          <span className="waveform-duration">{duration ? `${duration.toFixed(2)}s` : 'NO SAMPLE'}</span>
          {onExpand && (
            <button
              type="button"
              className="waveform-expand-button"
              onClick={onExpand}
              aria-label={`Open ${title} waveform editor`}
            >
              EDIT WAVE
            </button>
          )}
          {compact && (
            <div className="waveform-mode-toggle" role="group" aria-label="Layer sum visualization">
              <button
                type="button"
                className={displayMode === '3d' ? 'is-selected' : ''}
                onClick={() => setDisplayMode('3d')}
                aria-pressed={displayMode === '3d'}
              >
                3D FIELD
              </button>
              <button
                type="button"
                className={displayMode === '2d' ? 'is-selected' : ''}
                onClick={() => setDisplayMode('2d')}
                aria-pressed={displayMode === '2d'}
              >
                2D WAVE
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={`waveform-display${show3D ? ' waveform-display-3d' : ''}`}>
        {show3D ? (
          <Waveform3DCanvas
            peaks={peaks}
            stereoWaveform={stereoWaveform}
            durationSec={duration}
            playbackId={playbackId}
            playbackStartedAt={playbackStartedAt}
            accent={accent}
          />
        ) : (
          <>
            <svg
              ref={svgRef}
              className={`waveform-svg${onEnvelopeChange ? ' waveform-svg-editable' : ''}`}
              viewBox="0 0 500 112"
              preserveAspectRatio="none"
              role={onEnvelopeChange ? 'group' : 'img'}
              aria-label={onEnvelopeChange ? `${title} sample gain envelope editor` : `${title} waveform`}
              onPointerMove={movePoint}
              onPointerUp={endPointDrag}
              onPointerCancel={endPointDrag}
              onDoubleClick={addEnvelopePoint}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--wave-accent)" stopOpacity="0.88" />
                  <stop offset="100%" stopColor="var(--wave-accent)" stopOpacity="0.12" />
                </linearGradient>
              </defs>
              {[22, 46, 70, 94].map((y) => (
                <line key={y} x1="0" x2="500" y1={y} y2={y} className="waveform-gridline" />
              ))}
              <line x1="0" x2="500" y1="58" y2="58" className="waveform-centerline" />
              {peaks.map((peak, index) => {
                const barWidth = 500 / peaks.length;
                const height = Math.max(1.5, Math.min(82, peak * 82));
                return (
                  <rect
                    key={index}
                    x={index * barWidth + barWidth * 0.2}
                    y={58 - height / 2}
                    width={Math.max(1, barWidth * 0.58)}
                    height={height}
                    rx="1"
                    className="waveform-bar"
                    style={{ fill: `url(#${gradientId})` }}
                  />
                );
              })}
              {onTrimChange && (
                <rect
                  x="0"
                  y="0"
                  width={trimStartX}
                  height="112"
                  className="waveform-trimmed-region"
                />
              )}
              {onTrimChange && (
                <rect
                  x={trimEndX}
                  y="0"
                  width={Math.max(0, 500 - trimEndX)}
                  height="112"
                  className="waveform-trimmed-region"
                />
              )}
              {envelopeAreaPath && <path d={envelopeAreaPath} className="waveform-envelope-fill" />}
              {envelopePath && <path d={envelopePath} className="waveform-envelope" />}
              {peaks.length === 0 && (
                <path d="M0 58 H500" className="waveform-placeholder" />
              )}
              {envelopePoints?.map((point, index) => (
                <circle
                  key={index}
                  data-envelope-point
                  className={`waveform-envelope-point${index === 0 || index === envelopePoints.length - 1 ? ' is-endpoint' : ''}`}
                  cx={envelopeTimeX(point.time, safeTrimStart, safeTrimEnd)}
                  cy={98 - point.value * 76}
                  r={index === 0 || index === envelopePoints.length - 1 ? 4 : 4.5}
                  role="slider"
                  tabIndex={onEnvelopeChange ? 0 : -1}
                  aria-label={`${title} envelope point ${index + 1}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(point.value * 100)}
                  aria-valuetext={`${Math.round(point.time * 100)} percent through playable sample, ${Math.round(point.value * 100)} percent gain`}
                  onPointerDown={(event) => beginPointDrag(event, index)}
                  onContextMenu={(event) => removeEnvelopePoint(event, index)}
                  onKeyDown={(event) => adjustEnvelopePoint(event, index)}
                />
              ))}
              {onTrimChange && [
                {
                  edge: 'start',
                  x: trimStartX,
                  value: safeTrimStart,
                  min: 0,
                  max: safeTrimEnd - MIN_TRIM_RANGE
                },
                {
                  edge: 'end',
                  x: trimEndX,
                  value: safeTrimEnd,
                  min: safeTrimStart + MIN_TRIM_RANGE,
                  max: 1
                }
              ].map(({ edge, x, value, min, max }) => (
                <g
                  key={edge}
                  data-waveform-control
                  className={`waveform-trim-handle waveform-trim-handle-${edge}`}
                  role="slider"
                  tabIndex={0}
                  aria-label={`${title} sample ${edge} trim`}
                  aria-valuemin={Math.round(min * 100)}
                  aria-valuemax={Math.round(max * 100)}
                  aria-valuenow={Math.round(value * 100)}
                  aria-valuetext={`${Math.round(value * 100)} percent of sample`}
                  onPointerDown={(event) => beginTrimDrag(event, edge)}
                  onKeyDown={(event) => adjustTrim(event, edge)}
                >
                  <rect
                    className="waveform-trim-hit-area"
                    x={x - 10}
                    y="0"
                    width="20"
                    height="112"
                  />
                  <line x1={x} x2={x} y1="5" y2="106" />
                  <rect className="waveform-trim-marker" x={x - 7} y="3" width="14" height="20" rx="4" />
                  <text
                    className="waveform-trim-label"
                    x={edge === 'start' ? x + 11 : x - 11}
                    y="16"
                    textAnchor={edge === 'start' ? 'start' : 'end'}
                  >
                    {edge === 'start' ? 'IN' : 'OUT'}
                  </text>
                </g>
              ))}
            </svg>
            <div className="waveform-time-labels">
              <span>0:00</span>
              <span>{duration ? `${duration.toFixed(2)} SEC` : 'DROP SAMPLE TO VIEW'}</span>
            </div>
            {channelPlayheads.map((playhead, index) => {
              const startFraction = compact
                ? (duration > 0 ? playhead.delaySec / duration : 0)
                : safeTrimStart;
              const endFraction = compact
                ? (duration > 0 ? playhead.endTimeSec / duration : 1)
                : safeTrimEnd;
              return (
                playbackId > 0 && (
                  <div
                    key={`${playhead.id}-${index}`}
                    className="waveform-playhead"
                    style={{
                      '--playhead-from': `${clamp(startFraction, 0, 1) * 100}%`,
                      '--playhead-to': `${clamp(endFraction, 0, 1) * 100}%`,
                      '--playhead-color': playhead.color || accent,
                      animationDuration: `${Math.max(0.01, playhead.durationSec)}s`,
                      animationDelay: `${Math.max(0, playhead.delaySec || 0)}s`
                    }}
                  />
                )
              );
            })}
          </>
        )}
      </div>

      {(onEnvelopeChange || onTrimChange) && (
        <p className="waveform-note">
          {note ||
            `${onTrimChange ? 'Drag start/end handles to trim playback · ' : ''}${onEnvelopeChange ? 'Drag points for gain · double-click to add · right-click to remove' : ''}`}
        </p>
      )}
      {!onEnvelopeChange && note && <p className="waveform-note">{note}</p>}
    </section>
  );
}
