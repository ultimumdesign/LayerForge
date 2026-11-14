import React, { useRef, useState } from 'react';
import { createDiagnosticsReport } from '../audio/diagnostics.js';

export function DiagnosticsPanel({ entries, onClose }) {
  const reportRef = useRef(null);
  const [copyStatus, setCopyStatus] = useState('');
  const report = createDiagnosticsReport();

  const copyReport = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access unavailable');
      await navigator.clipboard.writeText(report);
      setCopyStatus('Report copied.');
    } catch {
      reportRef.current?.focus();
      reportRef.current?.select();
      setCopyStatus('Report selected. Press Cmd+C to copy.');
    }
  };

  return (
    <section className="diagnostics-panel" aria-label="Plugin diagnostics">
      <header className="diagnostics-header">
        <div>
          <strong>PLUGIN DIAGNOSTICS</strong>
          <span>{entries.length} recent event{entries.length === 1 ? '' : 's'}</span>
        </div>
        <button className="diagnostics-close" onClick={onClose} aria-label="Close diagnostics">
          CLOSE
        </button>
      </header>
      <p>
        Copy this report and attach it here. Native logs are also saved to
        {' '}<code>~/Library/Logs/LayerForge/LayerForge.log</code>.
      </p>
      <textarea ref={reportRef} readOnly value={report} aria-label="Diagnostics report" />
      <div className="diagnostics-actions">
        <button className="btn-export" onClick={copyReport}>COPY REPORT</button>
        <span role="status">{copyStatus}</span>
      </div>
    </section>
  );
}
