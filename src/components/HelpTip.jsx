import React, { createContext, useContext, useId } from 'react';

export const HelpEnabledContext = createContext(true);
export const DspInfoContext = createContext({ enabled: false, info: null });

export function DspInfoScreen() {
  const { enabled, info } = useContext(DspInfoContext);
  if (!enabled) return null;
  return (
    <div className="dsp-info-screen" role="status" aria-live="polite">
      <strong>{info?.label || 'DSP INFO'}</strong>
      <span>{info?.text || 'Hover or focus a knob or control for a description.'}</span>
    </div>
  );
}

export function HelpTip({ text, children }) {
  const enabled = useContext(HelpEnabledContext);
  const contentId = useId();

  if (!enabled || !text) return children;

  return (
    <span className="help-tip" tabIndex={0} aria-describedby={contentId}>
      {children}
      <span id={contentId} className="help-tip-popover" role="tooltip">
        {text}
      </span>
    </span>
  );
}
