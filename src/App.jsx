import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createDefaultState } from '@dsp/parameters.js';
import { buildDrumGraph } from '@dsp/engine.js';
import { LayerForgeBridge } from './audio/bridge.js';
import { downloadWav, renderWavBlob } from './audio/wavExport.js';
import { getDiagnostics, subscribeDiagnostics } from './audio/diagnostics.js';
import { ChannelStrip } from './components/ChannelStrip.jsx';
import { DiagnosticsPanel } from './components/DiagnosticsPanel.jsx';
import { RotaryKnob } from './components/RotaryKnob.jsx';

export default function App() {
  const bridgeRef = useRef(null);
  const [state, setState] = useState(() => createDefaultState());
  const [triggered, setTriggered] = useState(false);
  const [diagnostics, setDiagnostics] = useState(getDiagnostics);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [preparedWav, setPreparedWav] = useState(null);

  useEffect(() => subscribeDiagnostics(setDiagnostics), []);

  const triggerHit = useCallback(async (velocity = 1.0) => {
    if (bridgeRef.current) {
      await bridgeRef.current.ensureRunning();
    }
    setTriggered(true);
    setState((s) => ({ ...s, gate: 1, velocity }));
    setTimeout(() => {
      setState((s) => ({ ...s, gate: 0 }));
      setTriggered(false);
    }, 28);
  }, []);

  useEffect(() => {
    const bridge = new LayerForgeBridge();
    bridgeRef.current = bridge;

    bridge.initialize({
      onMidiTrigger: (vel) => triggerHit(vel),
      onParameterChange: (paramId, value) => {
        // Maps DAW automation parameter IDs back into React state
        if (paramId.startsWith('l')) {
          const match = paramId.match(/^l(\d+)_(.+)$/);
          if (match) {
            const idx = Number(match[1]);
            const key = match[2];
            setState((s) => ({
              ...s,
              layers: s.layers.map((l, i) => (i === idx ? { ...l, [key]: value } : l))
            }));
          }
        } else if (paramId.startsWith('noise_')) {
          const key = paramId.replace('noise_', '');
          setState((s) => ({ ...s, noise: { ...s.noise, [key]: value } }));
        } else if (paramId.startsWith('master_')) {
          const key = paramId.replace('master_', '');
          setState((s) => ({ ...s, master: { ...s.master, [key]: value } }));
        }
      }
    }).catch((error) => {
      console.error('[LayerForge] Audio engine initialization failed:', error);
    });
  }, [triggerHit]);

  // Re-evaluate Elementary DSP graph on state updates
  useEffect(() => {
    if (!bridgeRef.current) return;
    const [left, right] = buildDrumGraph(state);
    const renderResult = bridgeRef.current.render(left, right);
    renderResult?.catch((error) => {
      console.error('[LayerForge] Audio graph render failed:', error);
    });
  }, [state]);

  // Spacebar quick audition shortcut
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        triggerHit(1.0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triggerHit]);

  const updateLayer = (idx, patch) => {
    setState((s) => ({
      ...s,
      layers: s.layers.map((l, i) => (i === idx ? { ...l, ...patch } : l))
    }));
  };

  const handleSampleDrop = async (idx, file) => {
    if (!bridgeRef.current) return;
    let info;
    try {
      info = await bridgeRef.current.loadSampleFile(idx, file);
    } catch (error) {
      console.error(`[LayerForge] Could not load sample "${file.name}":`, error);
      return;
    }

    updateLayer(idx, { name: info.name, sampleKey: info.sampleKey, loaded: true });
    triggerHit(1.0).catch((error) => {
      console.error('[LayerForge] Could not audition the loaded sample:', error);
    });
  };

  const handleExport = async () => {
    const bridge = bridgeRef.current;
    if (!bridge || exporting) return;

    setExporting(true);
    setPreparedWav(null);
    try {
      const wavBlob = await renderWavBlob(state, bridge.vfsBuffers);
      const filename = `LayerForge_Drum_${Date.now()}.wav`;
      if (bridge.isNativePlugin) {
        const key = await bridge.prepareNativeWav(wavBlob, filename);
        setPreparedWav({ key, filename });
      } else {
        downloadWav(wavBlob, filename);
      }
    } catch (error) {
      console.error('[LayerForge] WAV export failed:', error);
    } finally {
      setExporting(false);
    }
  };

  const handleWavDragStart = (event) => {
    if (!preparedWav || !bridgeRef.current) return;
    event.dataTransfer?.setData('text/plain', preparedWav.filename);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    try {
      bridgeRef.current.startNativeWavDrag(preparedWav.key);
    } catch (error) {
      console.error('[LayerForge] Could not start WAV drag:', error);
    }
  };

  return (
    <div className="chassis">
      {/* Header Bar */}
      <header className="topbar">
        <div className="brand">
          <div className={`led ${triggered ? 'led-on' : ''}`} />
          <div>
            <h1>LAYERFORGE</h1>
            <span>MULTI-LAYER TRANSIENT &amp; CLIP ENGINE</span>
          </div>
        </div>

        <div className="actions">
          <button
            className={`btn-trigger ${triggered ? 'is-active' : ''}`}
            onMouseDown={() => triggerHit(1.0)}
          >
            HIT [SPACE / MIDI]
          </button>
          <button
            className={`btn-export ${preparedWav ? 'btn-export-ready' : ''}`}
            onClick={handleExport}
            draggable={Boolean(preparedWav && !exporting)}
            onDragStart={preparedWav ? handleWavDragStart : undefined}
            disabled={exporting}
            title={preparedWav ? `Drag ${preparedWav.filename} into Ableton` : 'Render a WAV for export'}
          >
            {exporting ? 'RENDERING WAV...' : preparedWav ? 'DRAG WAV TO ABLETON' : 'EXPORT 24-BIT .WAV'}
          </button>
          <button className="btn-debug" onClick={() => setShowDiagnostics((open) => !open)}>
            DEBUG{diagnostics.length > 0 ? ` (${diagnostics.length})` : ''}
          </button>
        </div>
      </header>

      {showDiagnostics && (
        <DiagnosticsPanel entries={diagnostics} onClose={() => setShowDiagnostics(false)} />
      )}

      {/* Main Rack */}
      <main className="rack">
        {state.layers.map((layer, idx) => (
          <ChannelStrip
            key={idx}
            index={idx}
            layer={layer}
            onFileDrop={handleSampleDrop}
            onChange={updateLayer}
          />
        ))}

        {/* Noise Engine Strip */}
        <section className={`strip strip-noise ${state.noise.mute ? 'is-muted' : ''}`}>
          <div className="strip-header">
            <span className="strip-tag tag-cyan">NOISE SYNTH</span>
            <div className="strip-toggles">
              <button
                className={`mini-btn ${state.noise.mute ? 'active-mute' : ''}`}
                onClick={() =>
                  setState((s) => ({ ...s, noise: { ...s.noise, mute: !s.noise.mute } }))
                }
              >
                M
              </button>
              <button
                className={`mini-btn ${state.noise.solo ? 'active-solo' : ''}`}
                onClick={() =>
                  setState((s) => ({ ...s, noise: { ...s.noise, solo: !s.noise.solo } }))
                }
              >
                S
              </button>
            </div>
          </div>

          <div className="module-badge badge-cyan">
            <div>BANDPASS AIR</div>
            <span>ENVELOPE GENERATOR</span>
          </div>

          <div className="knob-grid">
            <RotaryKnob
              label="FREQ"
              value={state.noise.cutoff}
              min={150}
              max={16000}
              defaultValue={4800}
              unit="Hz"
              decimals={0}
              accent="#22d3ee"
              onChange={(v) => setState((s) => ({ ...s, noise: { ...s.noise, cutoff: v } }))}
            />
            <RotaryKnob
              label="RESO"
              value={state.noise.q}
              min={0.5}
              max={10}
              defaultValue={1.4}
              decimals={1}
              accent="#22d3ee"
              onChange={(v) => setState((s) => ({ ...s, noise: { ...s.noise, q: v } }))}
            />
            <RotaryKnob
              label="DECAY"
              value={state.noise.decay}
              min={0.005}
              max={0.6}
              defaultValue={0.075}
              unit="s"
              decimals={3}
              accent="#22d3ee"
              onChange={(v) => setState((s) => ({ ...s, noise: { ...s.noise, decay: v } }))}
            />
            <RotaryKnob
              label="CLIP DRV"
              value={state.noise.clipDrive}
              min={0}
              max={24}
              defaultValue={3.0}
              unit="dB"
              decimals={1}
              accent="#fb7185"
              onChange={(v) => setState((s) => ({ ...s, noise: { ...s.noise, clipDrive: v } }))}
            />
            <RotaryKnob
              label="MIX"
              value={state.noise.gain}
              min={0}
              max={1}
              defaultValue={0.22}
              decimals={2}
              accent="#34d399"
              onChange={(v) => setState((s) => ({ ...s, noise: { ...s.noise, gain: v } }))}
            />
          </div>
        </section>

        {/* Master Bus Strip */}
        <section className="strip strip-master">
          <div className="strip-header">
            <span className="strip-tag tag-rose">MASTER BUS</span>
          </div>

          <div className="module-badge badge-rose">
            <div>HYBRID CLIPPER</div>
            <span>SOFT TANH → BRICKWALL</span>
          </div>

          <div className="knob-grid master-knobs">
            <RotaryKnob
              label="BUS DRIVE"
              value={state.master.drive}
              min={0}
              max={24}
              defaultValue={2.0}
              unit="dB"
              decimals={1}
              accent="#fb7185"
              onChange={(v) => setState((s) => ({ ...s, master: { ...s.master, drive: v } }))}
            />
            <RotaryKnob
              label="SOFT/HARD"
              value={state.master.hardness}
              min={0}
              max={1}
              defaultValue={0.45}
              decimals={2}
              accent="#fb7185"
              onChange={(v) => setState((s) => ({ ...s, master: { ...s.master, hardness: v } }))}
            />
            <RotaryKnob
              label="CEILING"
              value={state.master.ceiling}
              min={0.1}
              max={1.0}
              defaultValue={0.95}
              decimals={2}
              accent="#f59e0b"
              onChange={(v) => setState((s) => ({ ...s, master: { ...s.master, ceiling: v } }))}
            />
          </div>
        </section>
      </main>
    </div>
  );
}
