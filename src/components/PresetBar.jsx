import React from 'react';

export function PresetBar({
  presets,
  selected,
  libraryStatus,
  status,
  error,
  busy,
  ready,
  onSelect,
  onRefresh,
  onSave,
  onSaveOver,
  onDelete
}) {
  const selectedInfo = presets.find((preset) => preset.filename === selected);
  const canSaveOver = Boolean(selectedInfo?.available) && ready && !busy;
  return (
    <div className="topbar-group preset-bar" role="group" aria-label="Presets">
      <label className="preset-select" htmlFor="layerforge-preset-select">
        <span>PRESET</span>
        <select
          id="layerforge-preset-select"
          value={selectedInfo ? selected : ''}
          disabled={!ready || busy}
          onChange={(event) => onSelect(event.target.value)}
          aria-label="Saved LayerForge presets. Selecting one loads it."
        >
          <option value="">{libraryStatus || 'SELECT PRESET'}</option>
          {presets.map((preset) => (
            <option key={preset.filename} value={preset.filename}>
              {preset.available ? preset.name : `UNAVAILABLE - ${preset.name}`}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="topbar-button" onClick={onSave} disabled={!ready || busy}
        title="Save the current patch and samples as a new preset">
        SAVE
      </button>
      <button type="button" className="topbar-button" onClick={onSaveOver} disabled={!canSaveOver}
        title={selectedInfo ? `Replace "${selectedInfo.name}" with the current patch` : 'Select a preset to replace'}>
        SAVE OVER
      </button>
      <button type="button" className="topbar-button topbar-icon-button" onClick={onRefresh}
        disabled={!ready || busy} aria-label="Refresh saved presets" title="Rescan the preset folder">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6a5.5 5.5 0 1 1 0 4M3 2v4h4" /></svg>
      </button>
      <button type="button" className="topbar-button topbar-icon-button preset-delete-button"
        onClick={() => onDelete(selectedInfo)} disabled={!selectedInfo || busy}
        aria-label="Delete the selected preset"
        title={selectedInfo?.available === false
          ? selectedInfo.error || 'Delete unavailable preset'
          : 'Delete the selected preset'}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" /></svg>
      </button>
      <output className="preset-status" role="status" title={error || status}>{status}</output>
    </div>
  );
}
