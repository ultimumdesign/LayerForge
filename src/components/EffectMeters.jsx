import React, { useEffect, useState } from 'react';
import { createHitPeakTracker, formatPeakDb, peakToDb } from '../audio/meterPeaks.js';

const MIN_PEAK = 0.0001;
const MIN_REDUCTION_DB = 0.05;

function PeakMeter({ label, peak, hitPeak }) {
  const db = peakToDb(peak);
  const text = formatPeakDb(peak);
  const level = Math.max(0, Math.min(1, (db + 60) / 72));
  return (
    <div className="effect-meter meter-display">
      <div className="output-meter-heading"><span>{label}</span><output>{text}</output></div>
      <div className="output-meter-track" role="meter" aria-label={`${label} peak`}
        aria-valuemin={-60} aria-valuemax={12} aria-valuenow={Math.max(-60, Math.min(12, db))}
        aria-valuetext={text}>
        <div className={`output-meter-fill${peak >= 1 ? ' is-clipping' : ''}`} style={{ width: `${level * 100}%` }} />
      </div>
      <div className="meter-scale" aria-hidden="true"><span>−60</span><span>−42</span><span>−24</span><span>−6</span><span>+12</span></div>
      <div className="output-meter-last">
        <span>HIT PEAK</span>
        <output aria-label={`${label} highest peak of the last hit`}>{formatPeakDb(hitPeak)}</output>
      </div>
    </div>
  );
}

export function GainReductionMeter({ reduction, hitReduction = 0 }) {
  const displayed = reduction > 0.05 ? `−${reduction.toFixed(1)}` : '0.0';
  return (
    <div className="effect-reduction meter-display">
      <div className="reduction-copy">
        <span>WET REDUCTION</span>
        <output aria-label="Compressor wet gain reduction">{displayed} dB</output>
        <span>MAX THIS HIT</span>
        <output aria-label="Largest compressor gain reduction of the last hit">
          {hitReduction > MIN_REDUCTION_DB ? `−${hitReduction.toFixed(1)}` : '0.0'} dB
        </output>
      </div>
      <div className="reduction-gauge">
        <div className="reduction-track" role="meter" aria-label="Compressor gain reduction"
          aria-valuemin={0} aria-valuemax={36} aria-valuenow={Math.min(36, reduction)}
          aria-valuetext={`${displayed} dB wet gain reduction${reduction > 36 ? ', meter capped at 36 dB' : ''}`}>
          <div className="reduction-fill" style={{ height: `${Math.min(1, reduction / 36) * 100}%` }} />
        </div>
        <div className="reduction-scale" aria-hidden="true"><span>0</span><span>−12</span><span>−24</span><span>−36</span></div>
      </div>
    </div>
  );
}

export function EffectMeters({ effect }) {
  const [values, setValues] = useState([0, 0, 0]);
  const [hits, setHits] = useState([0, 0, 0]);
  useEffect(() => {
    let timeout;
    const hitTracker = createHitPeakTracker([MIN_PEAK, MIN_PEAK, MIN_REDUCTION_DB]);
    const onMeter = (event) => {
      const effects = event.detail?.effects;
      if (!Array.isArray(effects) || effects.length !== 5 || effects.some((value) => !Number.isFinite(value) || value < 0)) {
        console.error('[LayerForge] Invalid effect meter data.');
        return;
      }
      const current = effect === 'saturation' ? [...effects.slice(0, 2), 0] : effects.slice(2, 5);
      setValues(current);
      setHits(hitTracker.update(current, performance.now()));
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => setValues([0, 0, 0]), 400);
    };
    window.addEventListener('layerforge:outputMeter', onMeter);
    return () => {
      window.removeEventListener('layerforge:outputMeter', onMeter);
      window.clearTimeout(timeout);
    };
  }, [effect]);
  return (
    <div className={`effect-meters${effect === 'glue' ? ' has-reduction' : ''}`} aria-label={`${effect === 'glue' ? 'Compressor' : 'Saturation'} metering`}>
      <PeakMeter label="INPUT" peak={values[0]} hitPeak={hits[0]} />
      <PeakMeter label="OUTPUT" peak={values[1]} hitPeak={hits[1]} />
      {effect === 'glue' && <GainReductionMeter reduction={values[2]} hitReduction={hits[2]} />}
    </div>
  );
}
