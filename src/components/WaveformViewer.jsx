import React, { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  getEnvelopeDisplayValue,
  getEnvelopeDisplayY,
  getLayerPreviewWaveform,
  getMemoizedLayerPreviewWaveform,
  getTrimmedPreviewRange,
  getZoomedPreviewRange,
  getWaveformFitGain,
  getWaveformPaths,
  getWaveformPeaks,
  mapOutputWaveformToSource,
  mergeStereoWaveform,
  detectSilenceEnd,
  detectSilenceStart
} from '../audio/waveform.js';
import {
  DEFAULT_ENVELOPE_POINTS,
  isDefaultEnvelope,
  MIN_TRIM_RANGE
} from '../../dsp/parameters.js';
import { getEnvelopeSegmentValue, getEnvelopeSequence } from '../../dsp/envelope.js';
import { HelpEnabledContext, HelpTip } from './HelpTip.jsx';

const MAX_ENVELOPE_POINTS = 12;
const MIN_POINT_SPACING = 0.005;
const ENVELOPE_LEFT = 5;
const ENVELOPE_WIDTH = 490;
const SUM_ZOOM_LEVELS = [1, 1.5, 2];

function envelopeX(time) {
  return ENVELOPE_LEFT + time * ENVELOPE_WIDTH;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function SampleNameText({ name }) {
  const viewportRef = useRef(null);
  const textRef = useRef(null);
  const [overflow, setOverflow] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    const measure = () => setOverflow(Math.max(0, text.scrollWidth - viewport.clientWidth));
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(text);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [name]);

  return (
    <span className="sample-name-viewport" ref={viewportRef}>
      <span
        ref={textRef}
        className={`sample-name-text${overflow > 1 ? ' is-scrolling' : ''}`}
        style={overflow > 1 ? {
          '--sample-scroll-distance': `${overflow}px`,
          '--sample-scroll-duration': `${Math.max(6, overflow / 25 + 3)}s`
        } : undefined}
      >{name}</span>
    </span>
  );
}

export function WaveformViewer({
  samples,
  rightSamples,
  waveformEnvelope,
  sourcePreview,
  sampleRate = 44100,
  peaksOverride,
  durationOverride,
  title,
  eyebrow = 'SAMPLE WAVEFORM',
  sampleName,
  onSampleDrop,
  onLoadSample,
  onReplaceSample,
  onRevealSample,
  sampleActions = [],
  clipGain,
  onClipGainChange,
  accent = '#f59e0b',
  envelopePoints,
  onEnvelopeChange,
  trimStart = 0,
  trimEnd = 1,
  onTrimChange,
  snapSilence = true,
  stereoWaveform,
  previewStatus,
  playheads = [],
  playbackId = 0,
  playheadDurationSec,
  playheadDelaySec = 0,
  playheadStartFraction,
  playheadEndFraction,
  note,
  compact = false,
  outputTime = false,
  expanded = false,
  fitTrimmed = false,
  fitAmplitude = false,
  onFitAmplitudeChange,
  traceEnabled = false,
  onTraceEnabledChange,
  liveTrace,
  traceAccent = '#57d6c3',
  zoom: controlledZoom,
  onZoomChange,
  detail = 512,
  onDetailChange,
  showEnvelopeReset = true,
  onExpand
}) {
  const helpEnabled = useContext(HelpEnabledContext);
  const svgRef = useRef(null);
  const displayRef = useRef(null);
  const sampleMenuRef = useRef(null);
  const [sampleMenuOpen, setSampleMenuOpen] = useState(false);
  const sourceClipId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const dragTarget = useRef(null);
  const [localZoom, setLocalZoom] = useState(1);
  const [pan, setPan] = useState(compact ? 0 : 0.5);
  const [fitSelection, setFitSelection] = useState(true);
  const [trimDragView, setTrimDragView] = useState(null);
  useEffect(() => {
    if (!fitTrimmed || dragTarget.current?.type === 'trim') return;
    setFitSelection(true);
    setLocalZoom(1);
    setPan(0.5);
  }, [fitTrimmed, trimStart, trimEnd]);
  useEffect(() => {
    if (!sampleMenuOpen) return undefined;
    const dismiss = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'pointerdown' && sampleMenuRef.current?.contains(event.target)) return;
      setSampleMenuOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [sampleMenuOpen]);
  const zoom = controlledZoom ?? localZoom;
  const setZoom = onZoomChange || setLocalZoom;
  const zoomIndex = Math.max(0, SUM_ZOOM_LEVELS.indexOf(zoom));
  useEffect(() => {
    const display = displayRef.current;
    if (!display || zoom <= 1) return undefined;
    const scroll = (event) => {
      const delta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!delta) return;
      const next = clamp(pan + delta / (display.clientWidth * (zoom - 1)), 0, 1);
      if (next === pan) return;
      event.preventDefault();
      setPan(next);
    };
    display.addEventListener('wheel', scroll, { passive: false });
    return () => display.removeEventListener('wheel', scroll);
  }, [pan, zoom]);
  const outputDisplay = compact || outputTime;
  const safeTrimEnd = clamp(trimEnd, MIN_TRIM_RANGE, 1);
  const safeTrimStart = clamp(trimStart, 0, safeTrimEnd - MIN_TRIM_RANGE);
  const trimSpan = safeTrimEnd - safeTrimStart;
  const fittedRange = fitTrimmed && fitSelection && samples?.length
    ? getTrimmedPreviewRange(safeTrimStart, safeTrimEnd)
    : { start: 0, end: 1 };
  const viewRange = trimDragView || (!outputDisplay ? getZoomedPreviewRange(fittedRange, zoom, pan) : fittedRange);
  const viewSpan = viewRange.end - viewRange.start;
  const viewX = (samplePosition) => envelopeX((samplePosition - viewRange.start) / viewSpan);
  const trimStartX = clamp(viewX(safeTrimStart), ENVELOPE_LEFT, ENVELOPE_LEFT + ENVELOPE_WIDTH);
  const trimEndX = clamp(viewX(safeTrimEnd), ENVELOPE_LEFT, ENVELOPE_LEFT + ENVELOPE_WIDTH);
  const peaks = useMemo(
    () => peaksOverride || getWaveformPeaks(samples),
    [peaksOverride, samples]
  );
  const waveformData = useMemo(() => {
    if (sourcePreview?.waveform) {
      return mapOutputWaveformToSource(sourcePreview.waveform, sourcePreview.durationSec, sourcePreview, viewRange, detail);
    }
    if (fitTrimmed && samples?.length && (viewRange.start > 0 || viewRange.end < 1 || detail > 512)) {
      const left = getMemoizedLayerPreviewWaveform(samples, viewRange.start, viewRange.end, detail);
      if (!rightSamples) return left;
      const right = getMemoizedLayerPreviewWaveform(rightSamples, viewRange.start, viewRange.end, detail);
      return mergeStereoWaveform({ leftMin: left.min, leftMax: left.max, rightMin: right.min, rightMax: right.max });
    }
    if (waveformEnvelope) return waveformEnvelope;
    if (stereoWaveform) return mergeStereoWaveform(stereoWaveform);
    if (samples?.length) return getLayerPreviewWaveform(samples);
    return {
      min: peaks.map((peak) => -peak),
      max: peaks
    };
  }, [detail, fitTrimmed, peaks, rightSamples, samples, sourcePreview, stereoWaveform, viewRange, waveformEnvelope]);
  const sourceContextPath = useMemo(() => {
    if (!sourcePreview?.waveform || !samples?.length) return '';
    let source = getMemoizedLayerPreviewWaveform(samples, viewRange.start, viewRange.end, detail);
    if (rightSamples) {
      const right = getMemoizedLayerPreviewWaveform(rightSamples, viewRange.start, viewRange.end, detail);
      source = mergeStereoWaveform({ leftMin: source.min, leftMax: source.max, rightMin: right.min, rightMax: right.max });
    }
    return getWaveformPaths(source).area;
  }, [detail, samples, rightSamples, sourcePreview, viewRange.start, viewRange.end]);
  const duration =
    durationOverride ??
    (samples?.length ? (samples.length * trimSpan) / sampleRate : 0);
  const axisRange = outputDisplay && duration > 0
    ? { start: duration * 1000 * pan * (zoom - 1) / zoom, end: duration * 1000 * (pan * (zoom - 1) + 1) / zoom }
    : !compact && samples?.length && sampleRate > 0
      ? {
          start: viewRange.start * samples.length / sampleRate * 1000,
          end: viewRange.end * samples.length / sampleRate * 1000
        }
      : null;
  const axisPrecision = axisRange
    ? axisRange.end - axisRange.start < 0.01 ? 4 : axisRange.end - axisRange.start < 1 ? 2 : 1
    : 0;
  const showTrace = Boolean(traceEnabled && liveTrace?.min?.length && liveTrace.capturedSec > 0 && duration > 0);
  const displayGain = useMemo(() => {
    if (!compact || !fitAmplitude) return 1;
    return getWaveformFitGain(showTrace ? liveTrace : waveformData);
  }, [compact, fitAmplitude, waveformData, liveTrace, showTrace]);
  const waveformPaths = useMemo(
    () => getWaveformPaths(waveformData, 0, 1, displayGain),
    [waveformData, displayGain]
  );
  const tracePath = useMemo(() => {
    if (!showTrace) return '';
    return getWaveformPaths(
      liveTrace, 0, Math.min(1, liveTrace.capturedSec / duration), displayGain
    ).area;
  }, [liveTrace, duration, displayGain, showTrace]);
  const envelopePath = useMemo(() => {
    if (!envelopePoints?.length) return '';
    return getEnvelopeSequence(envelopePoints).map((point, index) => {
      const x = envelopeX(
        (safeTrimStart + point.time * trimSpan - viewRange.start) / viewSpan
      );
      const y = getEnvelopeDisplayY(point.value);
      return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }, [envelopePoints, safeTrimStart, trimSpan, viewRange.start, viewSpan]);
  const defaultEnvelope = isDefaultEnvelope(envelopePoints);
  const helpText = note || [
    onTrimChange && 'Drag the IN and OUT handles to trim playback.',
    onEnvelopeChange && 'Drag envelope points to shape gain; double-click to add a point. Drag a segment handle to bend it.'
  ].filter(Boolean).join(' ');

  const getViewPosition = (event) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;

    const x = ((event.clientX - bounds.left) / bounds.width) * 500;
    const y = ((event.clientY - bounds.top) / bounds.height) * 112;
    return {
      samplePosition: clamp(
        viewRange.start + ((x - ENVELOPE_LEFT) / ENVELOPE_WIDTH) * viewSpan,
        0,
        1
      ),
      value: getEnvelopeDisplayValue(y)
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

  const beginCurveDrag = (event, index) => {
    if (!onEnvelopeChange) return;
    event.preventDefault();
    event.stopPropagation();
    dragTarget.current = {
      type: 'curve',
      index,
      startY: event.clientY,
      curve: envelopePoints[index].curve ?? 0,
      direction: Math.sign(envelopePoints[index + 1].value - envelopePoints[index].value)
    };
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const updateCurve = (index, curve) => {
    onEnvelopeChange(envelopePoints.map((point, pointIndex) =>
      pointIndex === index ? { ...point, curve: clamp(curve, -0.5, 0.5) } : point
    ));
  };

  const beginTrimDrag = (event, edge) => {
    if (!onTrimChange) return;
    event.preventDefault();
    event.stopPropagation();
    dragTarget.current = {
      type: 'trim',
      edge,
      startX: event.clientX,
      startValue: edge === 'start' ? safeTrimStart : safeTrimEnd
    };
    setTrimDragView(viewRange);
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const movePoint = (event) => {
    const target = dragTarget.current;
    if (!target) return;
    if (target.type === 'curve') {
      const height = svgRef.current?.getBoundingClientRect().height || 1;
      updateCurve(target.index, target.curve - (event.clientY - target.startY) * target.direction / (height * 0.75));
      return;
    }
    const position = getViewPosition(event);
    if (!position) return;
    if (target.type === 'trim') {
      const width = svgRef.current?.getBoundingClientRect().width || 1;
      let samplePosition = target.startValue +
        (event.clientX - target.startX) / width * (500 / ENVELOPE_WIDTH) * viewSpan;
      
      // Apply snap-to-silence for end trim (when using Ctrl/Cmd)
      if (snapSilence && target.edge === 'end' && samples?.length && event.ctrlKey) {
        const silenceEnd = detectSilenceEnd(samples, 0.01, rightSamples || samples);
        // Snap within a 5% window of the silence boundary
        if (Math.abs(samplePosition - silenceEnd) < 0.05) {
          samplePosition = silenceEnd;
        }
      }
      
      // Apply snap-to-silence for start trim (when using Ctrl/Cmd)
      if (snapSilence && target.edge === 'start' && samples?.length && event.ctrlKey) {
        const silenceStart = detectSilenceStart(samples, 0.01, rightSamples || samples);
        // Snap within a 5% window of the sound start boundary
        if (Math.abs(samplePosition - silenceStart) < 0.05) {
          samplePosition = silenceStart;
        }
      }
      
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
        ? { ...point, time, value: envelopePosition.value }
          : point
      )
    );
  };

  const endPointDrag = (event) => {
    if (dragTarget.current === null) return;
    if (dragTarget.current.type === 'trim') {
      setFitSelection(true);
      setZoom(1);
      setPan(0.5);
    }
    dragTarget.current = null;
    setTrimDragView(null);
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
    updatedPoints.splice(nextIndex, 0, { ...position, curve: 0 });
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
    let curveDelta = 0;
    
    if (event.key === 'ArrowUp') valueDelta = amount;
    else if (event.key === 'ArrowDown') valueDelta = -amount;
    else if (event.key === 'Home') valueDelta = -1;
    else if (event.key === 'End') valueDelta = 1;
    else if (event.key === 'ArrowLeft') timeDelta = -amount;
    else if (event.key === 'ArrowRight') timeDelta = amount;
    else if (event.ctrlKey && event.key === '[') curveDelta = -0.05;
    else if (event.ctrlKey && event.key === ']') curveDelta = 0.05;
    else return;

    event.preventDefault();
    if (curveDelta && index === envelopePoints.length - 1) return;
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
    const curve = clamp((point.curve ?? 0) + curveDelta, -0.5, 0.5);
    onEnvelopeChange(
      envelopePoints.map((current, pointIndex) =>
        pointIndex === index
          ? { time, value: clamp(point.value + valueDelta, 0, 1), curve }
          : current
      )
    );
  };

  const adjustCurve = (event, index) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    const point = envelopePoints[index];
    if (event.key === 'Home') {
      updateCurve(index, 0);
      return;
    }
    const direction = Math.sign(envelopePoints[index + 1].value - point.value);
    const change = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 0.05 : -0.05;
    updateCurve(index, (point.curve ?? 0) + change * direction);
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
    setFitSelection(true);
    setZoom(1);
    setPan(0.5);
    onTrimChange(
      startEdge
        ? { trimStart: next, trimEnd: safeTrimEnd }
        : { trimStart: safeTrimStart, trimEnd: next }
    );
  };

  const channelPlayheads = playheads.length
    ? playheads
    : !outputTime && playbackId && duration
      ? [
          {
            id: playbackId,
            color: accent,
            startFraction: playheadStartFraction ?? safeTrimStart,
            endFraction: playheadEndFraction ?? safeTrimEnd,
            delaySec: playheadDelaySec,
            durationSec: playheadDurationSec || duration
          }
        ]
      : [];

  const zoomControls = (compact || (fitTrimmed && samples?.length)) && (
    <div className="waveform-zoom-controls" role="group" aria-label={compact ? 'Waveform zoom' : `${title} waveform zoom`}>
      <span>ZOOM</span>
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => setZoom(SUM_ZOOM_LEVELS[Math.max(0, zoomIndex - 1)])}
        disabled={zoomIndex === 0}
      >
        −
      </button>
      <output aria-live="polite">{zoom.toFixed(1)}x</output>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => setZoom(SUM_ZOOM_LEVELS[Math.min(SUM_ZOOM_LEVELS.length - 1, zoomIndex + 1)])}
        disabled={zoomIndex === SUM_ZOOM_LEVELS.length - 1}
      >
        +
      </button>
      {!compact && (
        <button
          type="button"
          className="waveform-view-toggle"
          aria-label={`${fitSelection ? 'Show full sample' : 'Fit selection'} for ${title}`}
          onClick={() => {
            setFitSelection((value) => !value);
            setZoom(1);
            setPan(0.5);
          }}
        >
          {fitSelection ? 'FULL' : 'FIT'}
        </button>
      )}
    </div>
  );

  const expandButton = onExpand && (
    <button
      type="button"
      className="waveform-expand-button"
      onClick={onExpand}
      aria-label={`${compact ? 'Expand' : 'Open'} ${title} waveform${compact ? ' view' : ' editor'}`}
    >
      {compact ? 'EXPAND' : 'EDIT WAVE'}
    </button>
  );

  return (
    <section
      className={`waveform-panel${compact ? ' waveform-panel-compact' : ''}${expanded ? ' waveform-panel-expanded' : ''}`}
      style={{ '--wave-accent': accent }}
      onDragOver={onSampleDrop ? (event) => event.preventDefault() : undefined}
      onDrop={onSampleDrop}
    >
      <div className={`waveform-heading${!compact ? ' waveform-heading-source' : ''}`}>
        <div className={`waveform-heading-title${sampleMenuOpen ? ' sample-menu-is-open' : ''}`}>
          <HelpTip text={helpText}>
            <div className="waveform-heading-label">
              {!compact && !sampleName && <span className="waveform-eyebrow">{eyebrow}</span>}
              {!sampleName && <strong>{title}</strong>}
              {sampleName && (onReplaceSample ? (
                <div className="sample-menu" ref={sampleMenuRef}>
                  <button
                    type="button"
                    className="waveform-sample-name sample-menu-trigger"
                    title={sampleName}
                    aria-label={`${title} sample options: ${sampleName}`}
                    aria-haspopup="menu"
                    aria-expanded={sampleMenuOpen}
                    onClick={() => setSampleMenuOpen((open) => !open)}
                  ><SampleNameText name={sampleName} /><span className="sample-menu-arrow" aria-hidden="true">▾</span></button>
                  {sampleMenuOpen && (
                    <div className="sample-menu-panel" role="menu">
                      <button type="button" role="menuitem" onClick={() => {
                        setSampleMenuOpen(false);
                        onReplaceSample();
                      }}>LOAD NEW SAMPLE</button>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={!onRevealSample}
                        title={!onRevealSample ? 'Original file location is unavailable' : undefined}
                        onClick={() => {
                          setSampleMenuOpen(false);
                          onRevealSample();
                        }}
                      >SHOW IN FINDER / FILE MANAGER</button>
                      {sampleActions.map(({ label, onSelect }) => (
                        <button key={label} type="button" role="menuitem" onClick={() => {
                          setSampleMenuOpen(false);
                          onSelect();
                        }}>{label}</button>
                      ))}
                    </div>
                  )}
                </div>
              ) : <span className="waveform-sample-name" title={sampleName}><SampleNameText name={sampleName} /></span>)}
            </div>
          </HelpTip>
        </div>
        <div className="waveform-heading-controls">
          {onClipGainChange && (
            <div className="waveform-clip-gain" onDoubleClick={() => onClipGainChange(0)}>
              <HelpTip text="Sample gain before channel processing. Drag the slider; double-click to reset to 0 dB.">
                <span>CLIP GAIN</span>
              </HelpTip>
              <input
                type="range"
                min="-60"
                max="12"
                step="0.1"
                value={clipGain}
                aria-label={`${title} clip gain`}
                aria-valuetext={`${Number(clipGain).toFixed(1)} dB`}
                onChange={(event) => onClipGainChange(Number(event.target.value))}
              />
              <input
                className="waveform-clip-gain-value"
                type="number"
                min="-60"
                max="12"
                step="0.1"
                key={clipGain}
                defaultValue={Number(clipGain).toFixed(1)}
                aria-label={`${title} clip gain exact value in dB`}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => event.target.setCustomValidity('')}
                onBlur={(event) => {
                  const value = event.target.valueAsNumber;
                  if (!Number.isFinite(value)) {
                    event.target.setCustomValidity('Enter a number in dB.');
                    event.target.reportValidity();
                    return;
                  }
                  event.target.setCustomValidity('');
                  const bounded = Math.max(-60, Math.min(12, value));
                  event.target.value = bounded.toFixed(1);
                  onClipGainChange(bounded);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    event.currentTarget.setCustomValidity('');
                    event.currentTarget.value = Number(clipGain).toFixed(1);
                    event.currentTarget.blur();
                  }
                }}
              />
              <span>dB</span>
            </div>
          )}
          {compact && expandButton}
          {compact && zoomControls}
        </div>
      </div>

      {!compact && ((onEnvelopeChange && showEnvelopeReset) || onExpand || onDetailChange || zoomControls) && (
        <div className="waveform-toolbar">
          {(onExpand || (onEnvelopeChange && showEnvelopeReset) || onDetailChange) && <div className="waveform-tool-actions" role="group" aria-label={`${title} waveform editing`}>
          {expandButton}
          {onEnvelopeChange && showEnvelopeReset && (
            <button
              type="button"
              className="waveform-reset-button"
              aria-label={`${title} reset gain envelope to default`}
              onClick={() =>
                onEnvelopeChange(DEFAULT_ENVELOPE_POINTS.map((point) => ({ ...point })))
              }
              disabled={defaultEnvelope}
            >
              RESET ENV
            </button>
          )}
          {onDetailChange && (
            <label className="waveform-detail-control">
              <span>DETAIL</span>
              <select value={detail} onChange={(event) => onDetailChange(Number(event.target.value))} aria-label={`${title} waveform detail`}>
                <option value={512}>STANDARD · 512</option>
                <option value={2048}>HIGH · 2048</option>
                <option value={4096}>FINE · 4096</option>
              </select>
            </label>
          )}
          </div>}
          {zoomControls}
        </div>
      )}

      <div className="waveform-display" ref={displayRef}>
        {onLoadSample && (
          <button
            type="button"
            className="waveform-load-overlay"
            aria-label={`Load sample for ${title}`}
            onClick={onLoadSample}
          >
            DROP OR CLICK TO LOAD
          </button>
        )}
        <div className="waveform-plot">
        {previewStatus && !(compact && showTrace) && previewStatus !== 'DSP RENDER' && (
          <span className="waveform-status">{showTrace ? 'LIVE OUTPUT' : previewStatus}</span>
        )}
        <svg
              ref={svgRef}
              className={`waveform-svg${onEnvelopeChange ? ' waveform-svg-editable' : ''}${compact ? ' waveform-svg-sum' : ''}`}
              style={compact && zoom > 1 ? { transform: `scaleX(${zoom}) translateX(${-pan * (zoom - 1) / zoom * 100}%)` } : undefined}
              viewBox="0 0 500 112"
              preserveAspectRatio="none"
              role={onEnvelopeChange ? 'group' : 'img'}
              aria-label={onEnvelopeChange
                ? `${title} sample waveform and gain envelope editor`
                : outputDisplay
                  ? `${title} ${showTrace ? 'live output' : previewStatus === 'DSP RENDER' ? 'processed output' : 'pending output'} waveform`
                  : `${title} sample amplitude waveform`}
              onPointerMove={movePoint}
              onPointerUp={endPointDrag}
              onPointerCancel={endPointDrag}
              onDoubleClick={addEnvelopePoint}
            >
              {[22, 46, 70, 94].map((y) => (
                <line key={y} x1="0" x2="500" y1={y} y2={y} className="waveform-gridline" />
              ))}
              <line x1="0" x2="500" y1="58" y2="58" className="waveform-centerline" />
              {sourceContextPath && (
                <>
                  <defs>
                    <clipPath id={sourceClipId}>
                      <rect x="0" y="0" width={clamp(trimStartX, 0, 500)} height="112" />
                      <rect x={clamp(trimEndX, 0, 500)} y="0" width={500 - clamp(trimEndX, 0, 500)} height="112" />
                    </clipPath>
                  </defs>
                  <path
                    d={sourceContextPath}
                    className="waveform-source-context"
                    clipPath={`url(#${sourceClipId})`}
                  />
                </>
              )}
              {!showTrace && waveformPaths.area && (
                <path
                  d={waveformPaths.area}
                  className={`waveform-amplitude-fill${compact ? ' waveform-output-fill' : ''}`}
                  style={{ fill: 'var(--wave-accent)' }}
                />
              )}
              {tracePath && (
                <path
                  d={tracePath}
                  className="waveform-live-trace"
                  style={{ '--trace-accent': traceAccent }}
                />
              )}
              {envelopePath && <path d={envelopePath} className="waveform-envelope" />}
              {!showTrace && waveformData.min.length === 0 && (
                <path d="M0 58 H500" className="waveform-placeholder" />
              )}
              {onEnvelopeChange && envelopePoints?.slice(0, -1).map((point, index) => {
                const next = envelopePoints[index + 1];
                if (Math.abs(next.value - point.value) < 0.001) return null;
                const time = (point.time + next.time) / 2;
                const x = viewX(safeTrimStart + time * trimSpan);
                const y = getEnvelopeDisplayY(getEnvelopeSegmentValue(point, next, 0.5));
                const curve = point.curve ?? 0;
                return (
                  <g key={`curve-${index}`} data-waveform-control onPointerDown={(event) => beginCurveDrag(event, index)}>
                    <circle className="waveform-envelope-point-hit-area" cx={x} cy={y} r="9" />
                    <circle
                      className="waveform-curve-handle"
                      cx={x}
                      cy={y}
                      r="3.5"
                      role="slider"
                      tabIndex={0}
                      aria-label={`${title} curve for segment ${index + 1}`}
                      aria-valuemin={-50}
                      aria-valuemax={50}
                      aria-valuenow={Math.round(curve * 100)}
                      aria-valuetext={`Curve ${Math.round(curve * 100)} percent`}
                      onKeyDown={(event) => adjustCurve(event, index)}
                    >
                      {helpEnabled && <title>Drag up or down to bend this segment</title>}
                    </circle>
                  </g>
                );
              })}
              {envelopePoints?.map((point, index) => {
                const isEndpoint = index === 0 || index === envelopePoints.length - 1;
                const x = viewX(safeTrimStart + point.time * trimSpan);
                const y = getEnvelopeDisplayY(point.value);
                const curve = point.curve ?? 0;
                const hasCurve = Math.abs(curve) > 0.001;
                return (
                  <g key={index} data-envelope-point>
                    <circle
                      className="waveform-envelope-point-hit-area"
                      cx={x}
                      cy={y}
                      r={isEndpoint ? 10 : 9}
                      onPointerDown={(event) => beginPointDrag(event, index)}
                      onContextMenu={(event) => removeEnvelopePoint(event, index)}
                    />
                    {hasCurve && (
                      <circle
                        className="waveform-envelope-curve-indicator"
                        cx={x}
                        cy={y}
                        r={isEndpoint ? 6 : 6.5}
                        style={{
                          fill: 'none',
                          strokeWidth: 0.8,
                          stroke: curve > 0 ? '#10b981' : '#f59e0b',
                          opacity: 0.6
                        }}
                      />
                    )}
                    <circle
                      className={`waveform-envelope-point${isEndpoint ? ' is-endpoint' : ''}`}
                      cx={x}
                      cy={y}
                      r={isEndpoint ? 4 : 4.5}
                      role="slider"
                      tabIndex={onEnvelopeChange ? 0 : -1}
                      aria-label={`${title} envelope point ${index + 1}${hasCurve ? ` with ${curve > 0 ? 'ease-out' : 'ease-in'} curve` : ''}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(point.value * 100)}
                      aria-valuetext={`${Math.round(point.time * 100)} percent through playable sample, ${Math.round(point.value * 100)} percent gain${hasCurve ? `, ${curve > 0 ? 'ease-out' : 'ease-in'} curve` : ''}`}
                      onPointerDown={(event) => beginPointDrag(event, index)}
                      onContextMenu={(event) => removeEnvelopePoint(event, index)}
                      onKeyDown={(event) => adjustEnvelopePoint(event, index)}
                    />
                  </g>
                );
              })}
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
                    height="10"
                  />
                  <line x1={x} x2={x} y1="9" y2="106" />
                  <rect className="waveform-trim-marker" x={x - 3.5} y="2" width="7" height="8" rx="2" />
                </g>
              ))}
        </svg>
        {channelPlayheads.map((playhead, index) => {
          const startFraction = outputDisplay
            ? (duration > 0 ? playhead.delaySec / duration : 0)
            : ((playhead.startFraction ?? safeTrimStart) - viewRange.start) / viewSpan;
          const endFraction = outputDisplay
            ? (duration > 0 ? playhead.endTimeSec / duration : 1)
            : ((playhead.endFraction ?? safeTrimEnd) - viewRange.start) / viewSpan;
          const playheadPosition = (fraction) =>
            (envelopeX(fraction) / 500 * (compact ? zoom : 1) - (compact ? pan * (zoom - 1) : 0)) * 100;
          return (
            playbackId > 0 && (
              <div
                key={`${playhead.id}-${index}`}
                className="waveform-playhead"
                style={{
                  '--playhead-from': `${playheadPosition(startFraction)}%`,
                  '--playhead-to': `${playheadPosition(endFraction)}%`,
                  '--playhead-color': playhead.color || accent,
                  animationDuration: `${Math.max(0.01, playhead.durationSec)}s`,
                  animationDelay: `${Math.max(0, playhead.delaySec || 0)}s`
                }}
              />
            )
          );
        })}
        </div>
        {(compact || (fitTrimmed && samples?.length)) && (
          <div className="waveform-pan-slot">
            {zoom > 1 && (
              <input
                type="range"
                className="waveform-pan"
                min="0"
                max="1"
                step="0.001"
                value={pan}
                aria-label={`${title} waveform horizontal scroll`}
                title="Scroll the zoomed waveform"
                onChange={(event) => setPan(Number(event.target.value))}
              />
            )}
          </div>
        )}
        {axisRange && (
          <div
            className="waveform-time-axis"
            aria-label={`${title} ${outputDisplay ? 'output' : 'source'} time in milliseconds`}
            style={compact ? { paddingLeft: `${zoom}%`, paddingRight: zoom === 1 ? '1%' : 0 } : undefined}
          >
            {[axisRange.start, (axisRange.start + axisRange.end) / 2, axisRange.end].map((time, index) => (
              <span key={index}>{index === 0 ? `${outputDisplay ? 'OUT' : 'SRC'} ` : ''}{time.toFixed(axisPrecision)} ms</span>
            ))}
          </div>
        )}
        {onTrimChange ? (
          <div className="waveform-time-labels waveform-time-labels-trim">
            <span>IN {Math.round(safeTrimStart * 100)}%</span>
            <span>OUT {Math.round(safeTrimEnd * 100)}%</span>
          </div>
        ) : !outputDisplay && !axisRange && !onLoadSample ? (
          <div className="waveform-time-labels">{onSampleDrop ? 'DROP SAMPLE HERE' : 'DROP SAMPLE TO VIEW'}</div>
        ) : null}
        {compact && (
          <div className="waveform-sum-legend" aria-label="Sum waveform layers">
            {!showTrace && <span>
              <i className="waveform-sum-legend-output" />
              {previewStatus === 'DSP RENDER' ? 'DSP SUM' : previewStatus}
            </span>}
            {onTraceEnabledChange && (
              <button
                type="button"
                className="waveform-trace-button"
                style={{ '--trace-accent': traceAccent }}
                aria-pressed={traceEnabled}
                onClick={() => onTraceEnabledChange(!traceEnabled)}
                title={helpEnabled ? 'Show the last played output instead of the preview; captured for up to four seconds.' : undefined}
              >
                {traceEnabled
                  ? `TRACE ${liveTrace?.status === 'GAP' ? 'GAP - RETRIGGER' : liveTrace?.status === 'ERROR' ? 'ERROR' : liveTrace?.status || 'ARMED'}${liveTrace?.limited ? ' (4S)' : ''}`
                  : 'TRACE OFF'}
              </button>
            )}
            {onFitAmplitudeChange && (
              <button
                type="button"
                className="waveform-fit-button"
                aria-pressed={fitAmplitude}
                aria-label={`Sum waveform display fit ${fitAmplitude ? 'on' : 'off'}`}
                title={helpEnabled ? `Display-only vertical fit, limited to 20x. Click for ${fitAmplitude ? 'actual scale' : 'fit'}.` : undefined}
                onClick={() => onFitAmplitudeChange(!fitAmplitude)}
              >
                {fitAmplitude ? `FIT x${displayGain.toFixed(1)}` : 'ACTUAL 1:1'}
              </button>
            )}
          </div>
        )}
      </div>

    </section>
  );
}
