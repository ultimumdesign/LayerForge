import React, { useRef, useState } from 'react';
import { HelpTip } from './HelpTip.jsx';

export function RotaryKnob({
  label,
  value,
  min,
  max,
  defaultValue = 0,
  unit = '',
  accent = 'var(--theme-accent)',
  decimals = 2,
  options = null,
  logarithmic = false,
  description = 'Drag vertically to adjust; Shift+drag for fine control.',
  onChange
}) {
  const dragState = useRef(null);
  const editActive = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState(false);

  const normalize = (number) => logarithmic
    ? Math.log(number / min) / Math.log(max / min)
    : (number - min) / (max - min);
  const normalized = Math.max(0, Math.min(1, normalize(value)));
  const angle = -135 + normalized * 270;

  const beginValueEdit = (event) => {
    event.stopPropagation();
    editActive.current = true;
    setDraft(Number(value).toFixed(decimals));
    setEditError(false);
    setEditing(true);
  };

  const commitValueEdit = (keepEditingOnError = false) => {
    if (!editActive.current) return;
    const text = draft.trim();
    const parsed = text ? Number(text) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      setEditError(keepEditingOnError);
      if (!keepEditingOnError) {
        editActive.current = false;
        setEditing(false);
        setDraft(Number(value).toFixed(decimals));
      }
      return;
    }

    editActive.current = false;
    onChange(Math.max(min, Math.min(max, parsed)));
    setEditing(false);
    setEditError(false);
  };

  const handlePointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      startY: e.clientY,
      startVal: value,
      startPosition: normalized
    };
  };

  const handlePointerMove = (e) => {
    if (!dragState.current) return;
    const sensitivity = e.shiftKey ? 450 : 140;
    const deltaY = dragState.current.startY - e.clientY;
    const position = Math.max(0, Math.min(1, dragState.current.startPosition + deltaY / sensitivity));
    const raw = Math.max(min, Math.min(max,
      logarithmic ? min * Math.pow(max / min, position)
        : dragState.current.startVal + (deltaY / sensitivity) * (max - min)));
    const next = options ? Math.round(raw) : raw;
    onChange(next);
  };

  const handlePointerUp = (e) => {
    if (dragState.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragState.current = null;
    }
  };

  const formatDisplay = () => {
    if (options) return options[value];
    if (unit === 'Hz' && value >= 1000) {
      return `${(value / 1000).toFixed(1)}k`;
    }
    return `${Number(value).toFixed(decimals)}${unit}`;
  };

  const help = options
    ? `${label}: Drag vertically or use arrow keys to select; click the value to cycle; double-click the knob to reset.`
    : `${label}: Drag vertically to adjust; Shift-drag for fine control. Click the value to type; double-click the knob to reset.`;

  return (
    <div
      className="knob-unit"
      data-dsp-label={label}
      data-dsp-help={description}
      onDoubleClick={() => onChange(defaultValue)}
    >
      <div
        className="knob-dial"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { dragState.current = null; }}
        role={options ? 'slider' : undefined}
        tabIndex={options ? 0 : undefined}
        aria-label={options ? label : undefined}
        aria-valuemin={options ? min : undefined}
        aria-valuemax={options ? max : undefined}
        aria-valuenow={options ? value : undefined}
        aria-valuetext={options ? formatDisplay() : undefined}
        onKeyDown={options ? (event) => {
          let next;
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = Math.min(max, value + 1);
          else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = Math.max(min, value - 1);
          else if (event.key === 'Home') next = min;
          else if (event.key === 'End') next = max;
          else return;
          event.preventDefault();
          onChange(next);
        } : undefined}
        style={{ '--accent': accent }}
      >
        <svg viewBox="0 0 44 44" className="knob-svg">
          <circle
            cx="22"
            cy="22"
            r="17"
            fill="none"
            stroke="#27272a"
            strokeWidth="3"
            strokeDasharray="80 107"
            transform="rotate(135 22 22)"
            strokeLinecap="round"
          />
          <circle
            cx="22"
            cy="22"
            r="17"
            fill="none"
            stroke={accent}
            strokeWidth="3"
            strokeDasharray={`${normalized * 80} 107`}
            transform="rotate(135 22 22)"
            strokeLinecap="round"
          />
        </svg>
        <div
          className="knob-cap"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <span className="knob-indicator" style={{ backgroundColor: accent }} />
        </div>
      </div>
      <div className="knob-label-row">
        <HelpTip text={help}>
          <span className="knob-label">{label}</span>
        </HelpTip>
      </div>
      {editing ? (
        <div className="knob-value-edit">
          <input
            autoFocus
            type="text"
            inputMode="decimal"
            value={draft}
            aria-label={`${label} exact value`}
            aria-invalid={editError}
            onChange={(event) => {
              setDraft(event.target.value);
              setEditError(false);
            }}
            onBlur={() => commitValueEdit(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitValueEdit(true);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                editActive.current = false;
                setEditing(false);
                setEditError(false);
                setDraft(Number(value).toFixed(decimals));
              }
            }}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          />
          {unit && <span>{unit}</span>}
          {editError && <span className="knob-value-error" role="alert">NUMBER</span>}
        </div>
      ) : (
        <button
          type="button"
          className="knob-val"
          onClick={options ? () => onChange(value === max ? min : value + 1) : beginValueEdit}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={options
            ? `${label}: ${formatDisplay()}. Click to select the next type.`
            : `${label}: ${formatDisplay()}. Click to edit the exact value.`}
        >
          {formatDisplay()}
        </button>
      )}
    </div>
  );
}
