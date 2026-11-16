import React, { useEffect, useState } from 'react';

function formatPeak(peak) {
  const decibels = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  return `${peak === 0 ? '-∞' : decibels < -60 ? '<-60' : decibels.toFixed(1)} dBFS`;
}

export function OutputMeter() {
  const [peak, setPeak] = useState(0);
  const [lastPeak, setLastPeak] = useState(0);

  useEffect(() => {
    let timeout;
    let heldPeak = 0;
    let heldUntil = 0;
    let measuredPeak = 0;
    let lastSignalTime = -Infinity;
    const onMeter = (event) => {
      const { min, max } = event.detail || {};
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        console.error('[LayerForge] Invalid output meter data.');
        return;
      }
      const currentPeak = Math.max(Math.abs(min), Math.abs(max));
      const now = performance.now();
      if (currentPeak >= 0.0001) {
        measuredPeak = now - lastSignalTime > 300 ? currentPeak : Math.max(measuredPeak, currentPeak);
        lastSignalTime = now;
        setLastPeak(measuredPeak);
      }
      if (currentPeak >= heldPeak || now >= heldUntil) {
        heldPeak = currentPeak;
        heldUntil = now + 150;
      }
      setPeak(heldPeak);
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setPeak(0), 400);
    };
    window.addEventListener('layerforge:outputMeter', onMeter);
    return () => {
      window.removeEventListener('layerforge:outputMeter', onMeter);
      window.clearTimeout(timeout);
    };
  }, []);

  const decibels = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  const level = Math.max(0, Math.min(1, (decibels + 60) / 60));
  const value = formatPeak(peak);

  return (
    <div className="output-meter meter-display">
      <div className="output-meter-heading">
        <span>OUTPUT PEAK</span>
        <output>{value}</output>
      </div>
      <div
        className="output-meter-track"
        role="meter"
        aria-label="Post-master output peak"
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={Math.max(-60, Math.min(0, decibels))}
        aria-valuetext={value}
      >
        <div className={`output-meter-fill${peak >= 1 ? ' is-clipping' : ''}`} style={{ width: `${level * 100}%` }} />
      </div>
      <div className="meter-scale" aria-hidden="true"><span>−60</span><span>−40</span><span>−20</span><span>0 dBFS</span></div>
      <div className="output-meter-last"><span>LAST PEAK</span><output aria-label="Last measured output peak">{formatPeak(lastPeak)}</output></div>
    </div>
  );
}
