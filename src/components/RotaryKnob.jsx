import React, { useRef } from 'react';

/**
 * Hardware-style Rotary Knob with vertical drag, fine-tune (Shift), and double-click reset.
 */
export function RotaryKnob({
  label,
  value,
  min,
  max,
  defaultValue = 0,
  unit = '',
  accent = '#f59e0b',
  decimals = 2,
  onChange
}) {
  const dragState = useRef(null);

  const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = -135 + normalized * 270;

  const handlePointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragState.current = {
      startY: e.clientY,
      startVal: value
    };
  };

  const handlePointerMove = (e) => {
    if (!dragState.current) return;
    const sensitivity = e.shiftKey ? 450 : 140;
    const deltaY = dragState.current.startY - e.clientY;
    const range = max - min;
    const next = Math.max(min, Math.min(max, dragState.current.startVal + (deltaY / sensitivity) * range));
    onChange(next);
  };

  const handlePointerUp = (e) => {
    if (dragState.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragState.current = null;
    }
  };

  const formatDisplay = () => {
    if (unit === 'Hz' && value >= 1000) {
      return `${(value / 1000).toFixed(1)}k`;
    }
    return `${Number(value).toFixed(decimals)}${unit}`;
  };

  return (
    <div
      className="knob-unit"
      onDoubleClick={() => onChange(defaultValue)}
      title="Drag vertically to adjust | Shift+Drag for fine | Double-click to reset"
    >
      <div
        className="knob-dial"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
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
      <span className="knob-label">{label}</span>
      <span className="knob-val">{formatDisplay()}</span>
    </div>
  );
}
