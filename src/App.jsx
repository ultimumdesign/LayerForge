import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  createDefaultState,
  restorePatchState,
  serializePatchState
} from '@dsp/parameters.js';
import { buildDrumGraph } from '@dsp/engine.js';
import { LayerForgeBridge } from './audio/bridge.js';
import { downloadWav, renderWavBlob, renderWaveformPreview } from './audio/wavExport.js';
import { getLayerPlaybackInfo, getLayerSumPeaks } from './audio/waveform.js';
import { getDiagnostics, subscribeDiagnostics } from './audio/diagnostics.js';
import { ChannelStrip } from './components/ChannelStrip.jsx';
import { DiagnosticsPanel } from './components/DiagnosticsPanel.jsx';
import { RotaryKnob } from './components/RotaryKnob.jsx';
import { WaveformViewer } from './components/WaveformViewer.jsx';

export default function App() {
  const bridgeRef = useRef(null);
  const wavActionRef = useRef(null);
  const utilityMenuRef = useRef(null);
  const sumRenderQueueRef = useRef({ active: false, pending: null, timer: null });
  const [state, setState] = useState(() => createDefaultState());
  const [triggered, setTriggered] = useState(false);
  const [playbackId, setPlaybackId] = useState(0);
  const [playbackStartedAt, setPlaybackStartedAt] = useState(0);
  const [diagnostics, setDiagnostics] = useState(getDiagnostics);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showUtilityMenu, setShowUtilityMenu] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [renderedLayerSum, setRenderedLayerSum] = useState(null);
  const [sumPreviewStatus, setSumPreviewStatus] = useState('QUEUED');
  const [preparedWav, setPreparedWav] = useState(null);
  const [wavActionStatus, setWavActionStatus] = useState('');
  const [presetStatus, setPresetStatus] = useState('');
  const [showPresetWarning, setShowPresetWarning] = useState(false);
  const [pluginStateLoaded, setPluginStateLoaded] = useState(false);
  const isNativePlugin = typeof window !== 'undefined' && Boolean(window.__JUCE__);
  const patchStateJson = JSON.stringify(serializePatchState(state));
  const patchStateRef = useRef(patchStateJson);
  patchStateRef.current = patchStateJson;

  useEffect(() => subscribeDiagnostics(setDiagnostics), []);

  useEffect(() => {
    if (!showUtilityMenu) return undefined;
    const closeOnOutsideClick = (event) => {
      if (!utilityMenuRef.current?.contains(event.target)) setShowUtilityMenu(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setShowUtilityMenu(false);
    };
    window.addEventListener('pointerdown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [showUtilityMenu]);

  useEffect(() => {
    if (!preparedWav || !bridgeRef.current?.isNativePlugin) return;

    const bridge = bridgeRef.current;
    const target = wavActionRef.current;
    if (!target) return;

    const updateTarget = () => {
      try {
        if (exporting) {
          bridge.setNativeWavDragTarget(preparedWav.key, {}, false);
          return;
        }

        const rect = target.getBoundingClientRect();
        bridge.setNativeWavDragTarget(preparedWav.key, {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        });
      } catch (error) {
        console.error('[LayerForge] Could not update the native WAV drag target:', error);
      }
    };

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateTarget);
    observer?.observe(target);
    window.addEventListener('resize', updateTarget);
    updateTarget();

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateTarget);
      try {
        bridge.setNativeWavDragTarget(preparedWav.key, {}, false);
      } catch (error) {
        console.error('[LayerForge] Could not disable the native WAV drag target:', error);
      }
    };
  }, [preparedWav, exporting]);

  useEffect(() => {
    const onWavActionStatus = (event) => {
      const { key, status, error } = event.detail || {};
      if (key !== preparedWav?.key) return;
      if (error) console.error('[LayerForge] Native WAV action failed:', error);

      const labels = {
        copied: 'COPIED',
        copyFailed: 'COPY FAILED',
        dragReady: 'READY TO DRAG',
        dragStarted: 'DRAGGING...',
        dragFailed: 'DRAG FAILED',
        dropAccepted: 'DROP OK',
        dropRejected: 'DROP REJECTED',
        saved: 'SAVED',
        saveFailed: 'SAVE FAILED',
        saveCancelled: 'SAVE CANCELED'
      };
      setWavActionStatus(labels[status] || '');
    };

    window.addEventListener('layerforge:wavActionStatus', onWavActionStatus);
    return () => window.removeEventListener('layerforge:wavActionStatus', onWavActionStatus);
  }, [preparedWav]);

  useEffect(() => {
    const onPresetStatus = (event) => {
      const { status, error } = event.detail || {};
      if (error) console.error('[LayerForge] Preset export failed:', error);
      const labels = {
        saved: 'PRESET SAVED',
        cancelled: 'EXPORT CANCELED',
        failed: 'EXPORT FAILED'
      };
      setPresetStatus(labels[status] || '');
      if (status !== 'started') setShowPresetWarning(false);
    };

    window.addEventListener('layerforge:presetStatus', onPresetStatus);
    return () => window.removeEventListener('layerforge:presetStatus', onPresetStatus);
  }, []);

  const triggerHit = useCallback(async (velocity = 1.0) => {
    if (bridgeRef.current) {
      await bridgeRef.current.ensureRunning();
    }
    setPlaybackId((current) => current + 1);
    setPlaybackStartedAt(performance.now());
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
    }).then(() => {
      setState(restorePatchState(bridge.restoredPluginState, bridge.vfsBuffers));
      setPluginStateLoaded(true);
    }).catch((error) => {
      console.error('[LayerForge] Audio engine initialization failed:', error);
    });
  }, [triggerHit]);

  useEffect(() => {
    if (!isNativePlugin || !pluginStateLoaded) return;
    const timer = window.setTimeout(() => {
      try {
        bridgeRef.current?.saveNativePluginState(JSON.parse(patchStateJson));
      } catch (error) {
        console.error('[LayerForge] Could not save the patch state:', error);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [isNativePlugin, patchStateJson, pluginStateLoaded]);

  useEffect(() => {
    const flushPatchState = () => {
      if (!isNativePlugin || !pluginStateLoaded) return;
      try {
        bridgeRef.current?.saveNativePluginState(JSON.parse(patchStateRef.current));
      } catch (error) {
        console.error('[LayerForge] Could not save the patch state before closing:', error);
      }
    };
    window.addEventListener('pagehide', flushPatchState);
    return () => {
      window.removeEventListener('pagehide', flushPatchState);
      flushPatchState();
    };
  }, [isNativePlugin, pluginStateLoaded]);

  // Re-evaluate Elementary DSP graph on state updates
  useEffect(() => {
    if (!bridgeRef.current) return;
    if (bridgeRef.current.isNativePlugin && !bridgeRef.current.pluginStateLoaded) return;
    const [left, right] = buildDrumGraph(state);
    const renderResult = bridgeRef.current.render(left, right);
    renderResult?.catch((error) => {
      console.error('[LayerForge] Audio graph render failed:', error);
    });
  }, [state]);

  const layerSum = getLayerSumPeaks(
    state,
    bridgeRef.current?.vfsBuffers || {},
    bridgeRef.current?.vfsSampleRates || {}
  );
  const sampleBuffers = bridgeRef.current?.vfsBuffers || {};
  const sampleRates = bridgeRef.current?.vfsSampleRates || {};
  const hasCurrentRenderedSum = renderedLayerSum?.patchKey === patchStateJson;
  const visibleLayerSum = hasCurrentRenderedSum ? renderedLayerSum.result : layerSum;
  const visibleSumStatus = hasCurrentRenderedSum
    ? 'DSP RENDER'
    : sumPreviewStatus === 'FAILED'
      ? 'RENDER FAILED'
      : 'LIVE ESTIMATE';
  const audiblePlaybackTracks = getLayerPlaybackInfo(state, sampleBuffers, sampleRates);
  const sumPlaybackTracks = audiblePlaybackTracks.map((track) => ({
    ...track,
    id: playbackId
  }));
  const hasSolo = state.layers.some((layer) => layer.solo) || state.noise.solo;
  if (
    state.noise.gain > 0.0005 &&
    !state.noise.mute &&
    (!hasSolo || state.noise.solo)
  ) {
    const durationSec = state.noise.decay + 0.016;
    sumPlaybackTracks.push({
      id: playbackId,
      color: '#22d3ee',
      delaySec: 0,
      durationSec,
      endTimeSec: durationSec
    });
  }

  useEffect(() => {
    const queue = sumRenderQueueRef.current;
    const job = {
      key: patchStateJson,
      state: { ...JSON.parse(patchStateJson), gate: 0, velocity: 1 },
      buffers: bridgeRef.current?.vfsBuffers || {}
    };
    queue.pending = job;
    if (queue.timer) window.clearTimeout(queue.timer);
    setSumPreviewStatus('QUEUED');

    const renderPending = async () => {
      queue.timer = null;
      if (queue.active || !queue.pending) return;
      queue.active = true;
      const currentJob = queue.pending;
      queue.pending = null;
      if (currentJob.key === patchStateRef.current) setSumPreviewStatus('RENDERING');

      try {
        const result = await renderWaveformPreview(currentJob.state, currentJob.buffers);
        if (currentJob.key === patchStateRef.current) {
          setRenderedLayerSum({ patchKey: currentJob.key, result });
          setSumPreviewStatus('READY');
        }
      } catch (error) {
        console.error('[LayerForge] DSP waveform preview failed:', error);
        if (currentJob.key === patchStateRef.current) setSumPreviewStatus('FAILED');
      } finally {
        queue.active = false;
        if (queue.pending && !queue.timer) {
          queue.timer = window.setTimeout(renderPending, 0);
        }
      }
    };

    queue.timer = window.setTimeout(renderPending, 260);
    return () => {
      if (queue.timer) window.clearTimeout(queue.timer);
      queue.timer = null;
    };
  }, [patchStateJson]);

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

    updateLayer(idx, {
      name: info.name,
      sourceName: info.sourceName,
      sourceLocation: info.sourceLocation,
      sampleRate: info.sampleRate,
      sampleCount: info.sampleCount,
      sampleKey: info.sampleKey,
      loaded: true,
      trimStart: 0,
      trimEnd: 1
    });
    triggerHit(1.0).catch((error) => {
      console.error('[LayerForge] Could not audition the loaded sample:', error);
    });
  };

  const handleExport = async () => {
    const bridge = bridgeRef.current;
    if (!bridge || exporting) return;

    setExporting(true);
    setWavActionStatus('');
    try {
      const wavBlob = await renderWavBlob(state, bridge.vfsBuffers);
      const filename = `LayerForge_Drum_${Date.now()}.wav`;
      if (bridge.isNativePlugin) {
        const key = await bridge.prepareNativeWav(wavBlob, filename);
        setPreparedWav({ key, filename, blob: wavBlob });
      } else {
        downloadWav(wavBlob, filename);
      }
    } catch (error) {
      console.error('[LayerForge] WAV export failed:', error);
    } finally {
      setExporting(false);
    }
  };

  const handleCopyPreparedWav = async () => {
    if (!preparedWav || !bridgeRef.current) return;

    setWavActionStatus('COPYING WAV...');
    try {
      await bridgeRef.current.copyNativeWavToClipboard(preparedWav.key);
      setWavActionStatus('COPIED');
    } catch (error) {
      console.error('[LayerForge] Could not copy WAV to the clipboard:', error);
      setWavActionStatus('COPY FAILED');
    }
  };

  const handleWavDragStart = (event) => {
    if (!preparedWav || !bridgeRef.current) return;

    try {
      const file = new File([preparedWav.blob], preparedWav.filename, { type: 'audio/wav' });
      event.dataTransfer?.items.add(file);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    } catch (error) {
      console.error('[LayerForge] Could not attach the WAV file to the drag:', error);
    }

    setWavActionStatus('COPYING WAV...');
    bridgeRef.current.copyNativeWavToClipboard(preparedWav.key).then(
      () => setWavActionStatus('COPIED'),
      (error) => {
        console.error('[LayerForge] Could not copy WAV to the clipboard:', error);
        setWavActionStatus('COPY FAILED');
      }
    );
  };

  const handleSavePreparedWav = () => {
    if (!preparedWav || !bridgeRef.current) return;
    setWavActionStatus('SAVING WAV...');
    try {
      bridgeRef.current.saveNativeWav(preparedWav.key);
    } catch (error) {
      console.error('[LayerForge] Could not save the WAV file:', error);
      setWavActionStatus('SAVE FAILED');
    }
  };

  const confirmPresetExport = () => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setShowPresetWarning(false);
    setPresetStatus('PREPARING PRESET...');
    try {
      const patch = serializePatchState(state);
      bridge.saveNativePluginState(patch);
      bridge.exportNativePreset(patch);
    } catch (error) {
      console.error('[LayerForge] Could not export the preset:', error);
      setPresetStatus('EXPORT FAILED');
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
            className="btn-export"
            onClick={handleExport}
            disabled={exporting}
            title="Render and export a new 24-bit WAV"
          >
            {exporting ? 'RENDERING WAV...' : 'EXPORT 24-BIT .WAV'}
          </button>
          {preparedWav && (
            <button
              ref={wavActionRef}
              className="btn-export btn-export-ready"
              onClick={handleCopyPreparedWav}
              draggable={!exporting}
              onDragStart={handleWavDragStart}
              disabled={exporting}
              title="Click to copy the WAV file, or drag it into Ableton. Save WAV creates a permanent copy."
            >
              {wavActionStatus || 'COPY / DRAG WAV'}
            </button>
          )}
          {preparedWav && (
            <button
              className="btn-export"
              onClick={handleSavePreparedWav}
              disabled={exporting}
              title="Save a permanent WAV copy to a location you choose"
            >
              SAVE WAV
            </button>
          )}
          <div className="utility-menu" ref={utilityMenuRef}>
            <button
              className="btn-debug"
              onClick={() => setShowUtilityMenu((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={showUtilityMenu}
              aria-controls="layerforge-utility-menu"
            >
              SYSTEM MENU ▾
            </button>
            {showUtilityMenu && (
              <div id="layerforge-utility-menu" className="utility-menu-panel" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowDiagnostics((open) => !open);
                    setShowUtilityMenu(false);
                  }}
                >
                  DIAGNOSTICS{diagnostics.length > 0 ? ` (${diagnostics.length})` : ''}
                </button>
                {isNativePlugin && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setShowPresetWarning(true);
                      setShowUtilityMenu(false);
                    }}
                  >
                    {presetStatus || 'EXPORT PRESET'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {showDiagnostics && (
        <DiagnosticsPanel entries={diagnostics} onClose={() => setShowDiagnostics(false)} />
      )}

      {isNativePlugin && state.layers.some((layer) => layer.loaded) && (
        <p className="storage-note">
          PROJECT SAVES INCLUDE COMPLETE SAMPLE AUDIO · PROJECT FILE SIZE WILL GROW
        </p>
      )}

      <WaveformViewer
        title="LAYER SUM"
        peaksOverride={visibleLayerSum.peaks}
        durationOverride={visibleLayerSum.durationSec}
        stereoWaveform={visibleLayerSum.stereoWaveform}
        previewStatus={visibleSumStatus}
        playheads={sumPlaybackTracks}
        playbackId={playbackId}
        playbackStartedAt={playbackStartedAt}
        accent="#34d399"
        compact
        note="DSP-rendered stereo sum with channel effects, noise, and master processing · drag to rotate."
      />

      {/* Main Rack */}
      <main className="rack">
        {state.layers.map((layer, idx) => (
          <ChannelStrip
            key={idx}
            index={idx}
            layer={layer}
            sampleBuffers={sampleBuffers}
            sampleRates={sampleRates}
            playbackId={playbackId}
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

      {showPresetWarning && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-warning-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="preset-warning-title">SELF-CONTAINED PRESET</h2>
            <p>
              The preset includes the complete audio sample data for every loaded channel, not just
              file references. Presets can be large and will use disk space. Source file names and
              locations are included when the browser provides them.
            </p>
            <div className="storage-dialog-actions">
              <button className="btn-debug" onClick={() => setShowPresetWarning(false)}>
                CANCEL
              </button>
              <button className="btn-export btn-export-warning" onClick={confirmPresetExport}>
                SAVE PRESET
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
