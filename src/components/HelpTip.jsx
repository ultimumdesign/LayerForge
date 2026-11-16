import React, { createContext, useContext, useId } from 'react';

export const HelpEnabledContext = createContext(true);

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
