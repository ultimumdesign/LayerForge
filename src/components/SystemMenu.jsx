import React, { useEffect, useRef, useState } from 'react';
import { USAGE_GUIDE_URL } from '../links.js';

export function SystemMenu({
  isNativePlugin,
  helpEnabled,
  onToggleHelp,
  dspInfoEnabled,
  onToggleDspInfo,
  borderTrace,
  onCycleBorderTraceLevel,
  onCycleBorderTraceSpeed,
  initializeDisabled,
  onInitialize,
  onAbout,
  onOpenOutputScope,
  onDiagnostics,
  diagnosticsCount
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const run = (action) => () => {
    setOpen(false);
    action();
  };

  const openGuide = (event) => {
    if (!isNativePlugin) {
      setOpen(false);
      return;
    }
    event.preventDefault();
    if (typeof window._postMessageToPluginBackend === 'function') {
      window._postMessageToPluginBackend('openUsageGuide', {});
    } else {
      console.error('[LayerForge] Cannot open the usage guide: native bridge is unavailable.');
    }
    setOpen(false);
  };

  return (
    <div className="utility-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="topbar-button topbar-menu-button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="layerforge-utility-menu"
      >
        MENU <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div id="layerforge-utility-menu" className="utility-menu-panel" role="menu">
          <a role="menuitem" href={USAGE_GUIDE_URL} target="_blank" rel="noreferrer" onClick={openGuide}>
            <span>USAGE GUIDE</span>
          </a>
          <button type="button" role="menuitemcheckbox" aria-checked={helpEnabled} onClick={run(onToggleHelp)}>
            <span>HOVER HELP</span><em>{helpEnabled ? 'ON' : 'OFF'}</em>
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={dspInfoEnabled} onClick={run(onToggleDspInfo)}>
            <span>DSP INFO DISPLAY</span><em>{dspInfoEnabled ? 'ON' : 'OFF'}</em>
          </button>
          <button type="button" role="menuitem" onClick={onCycleBorderTraceLevel}
            aria-label={`Border tracing intensity: ${borderTrace.level}. Activate to change.`}>
            <span>BORDER TRACE</span><em>{borderTrace.level.toUpperCase()}</em>
          </button>
          <button type="button" role="menuitem" onClick={onCycleBorderTraceSpeed}
            aria-label={`Border tracing speed: ${borderTrace.speed}. Activate to change.`}>
            <span>TRACE SPEED</span><em>{borderTrace.speed.toUpperCase()}</em>
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={run(onOpenOutputScope)}>
            <span>EXPANDED OUTPUT SCOPE</span>
          </button>
          <button type="button" role="menuitem" disabled={initializeDisabled} onClick={run(onInitialize)}>
            <span>INITIALIZE PATCH</span>
          </button>
          <button type="button" role="menuitem" onClick={run(onDiagnostics)}>
            <span>DIAGNOSTICS</span>{diagnosticsCount > 0 && <em>{diagnosticsCount}</em>}
          </button>
          <button type="button" role="menuitem" onClick={run(onAbout)}>
            <span>ABOUT</span>
          </button>
        </div>
      )}
    </div>
  );
}
