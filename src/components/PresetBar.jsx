import React from 'react';

export function PresetBar({
  presets,
  selected,
  libraryStatus,
  status,
  error,
  helpEnabled = true,
  isInitialPatch = true,
  busy,
  ready,
  onSelect,
  onInitialize,
  onRefresh,
  onSave,
  onSaveAs,
  onDelete
}) {
  const selectedInfo = presets.find((preset) => preset.filename === selected);
  const canSave = ready && !busy;
  const isCurrentPatch = !selectedInfo && !isInitialPatch;
  const lcdStatus = status || (selectedInfo ? (selectedInfo.available ? 'LOADED' : 'MISSING')
    : libraryStatus || (isCurrentPatch ? 'EDITED' : 'INIT'));
  return (
    <div className="topbar-group preset-bar" role="group" aria-label="Presets">
      <div className="lcd preset-lcd">
        <label className="lcd-row" htmlFor="layerforge-preset-select">
          <span className="lcd-label">PRESET</span>
          <select
            id="layerforge-preset-select"
            value={selectedInfo ? selected : isCurrentPatch ? '__current_patch__' : ''}
            disabled={!ready || busy}
            onChange={(event) => {
              if (event.target.value === '') onInitialize();
              else onSelect(event.target.value);
            }}
            aria-label="LayerForge presets. Loading another preset may ask for confirmation."
          >
            {isCurrentPatch && <option value="__current_patch__" disabled>-- CURRENT PATCH --</option>}
            <option value="">-- INIT PATCH --</option>
            {presets.map((preset) => (
              <option key={preset.filename} value={preset.filename}>
                {preset.available ? preset.name : `UNAVAILABLE - ${preset.name}`}
              </option>
            ))}
          </select>
        </label>
        <output className="lcd-status" role="status" title={error || lcdStatus}>{lcdStatus}</output>
      </div>
      <button type="button" className="topbar-button" onClick={onSave} disabled={!canSave}
        title={helpEnabled ? (selectedInfo?.available
          ? 'SAVE: Click to replace the selected preset.'
          : 'SAVE: Click to save a new preset.') : undefined}>
        SAVE
      </button>
      <button type="button" className="topbar-button" onClick={onSaveAs} disabled={!canSave}
        title={helpEnabled ? 'SAVE AS: Click to save a new preset.' : undefined}>
        SAVE AS
      </button>
      <button type="button" className="topbar-button topbar-icon-button" onClick={onRefresh}
        disabled={!ready || busy} aria-label="Refresh saved presets" title={helpEnabled ? 'REFRESH PRESETS: Click to rescan.' : undefined}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6a5.5 5.5 0 1 1 0 4M3 2v4h4" /></svg>
      </button>
      <button type="button" className="topbar-button topbar-icon-button preset-delete-button"
        onClick={() => onDelete(selectedInfo)} disabled={!selectedInfo || busy}
        aria-label="Delete the selected preset"
        title={selectedInfo?.available === false
          ? selectedInfo.error || 'Delete unavailable preset'
          : helpEnabled ? 'DELETE PRESET: Click to delete the selected preset.' : undefined}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" /></svg>
      </button>
    </div>
  );
}
