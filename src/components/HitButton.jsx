import React from 'react';

export function HitButton({ triggered, onHit, autoFocus = false }) {
  return (
    <button
      type="button"
      className={`topbar-button topbar-hit ${triggered ? 'is-active' : ''}`}
      aria-label="Trigger hit (Space or MIDI)"
      aria-keyshortcuts="Space"
      data-dsp-label="HIT" data-dsp-help="Triggers a hit at full velocity; MIDI notes can also trigger it."
      autoFocus={autoFocus}
      onMouseDown={(event) => {
        if (event.button === 0) onHit();
      }}
      onClick={(event) => {
        if (event.detail === 0) onHit();
      }}
    >
      <span className="topbar-hit-label">HIT</span>
      <span className="topbar-hit-hint">SPACE / MIDI</span>
    </button>
  );
}

export function AuditionCloseButton({ onClose, onHit, label = 'Close settings (Enter or Escape)' }) {
  return (
    <button type="button" className="waveform-editor-close" onClick={onClose}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.code !== 'Space' || event.defaultPrevented) return;
        event.preventDefault();
        if (!event.repeat) onHit();
      }}>CLOSE</button>
  );
}
