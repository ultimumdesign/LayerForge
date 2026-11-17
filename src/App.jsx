import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  createDefaultState,
  PARAMETER_SCHEMA,
  resetBusModuleKnobs,
  resetLayerKnobs,
  restorePatchState,
  serializePatchState,
  swapLayerSamples
} from '@dsp/parameters.js';
import { buildDrumGraph } from '@dsp/engine.js';
import { LayerForgeBridge } from './audio/bridge.js';
import { downloadWav, getPatchDurationSec, renderWavBlob, renderWaveformPreview } from './audio/wavExport.js';
import { getLayerPlaybackInfo } from './audio/waveform.js';
import { LiveComparisonTrace } from './audio/liveTrace.js';
import { getDiagnostics, subscribeDiagnostics } from './audio/diagnostics.js';
import { ChannelStrip } from './components/ChannelStrip.jsx';
import { NoiseWaveform } from './components/NoiseWaveform.jsx';
import { DiagnosticsPanel } from './components/DiagnosticsPanel.jsx';
import { LayerSumViewer } from './components/LayerSumViewer.jsx';
import { OutputMeter } from './components/OutputMeter.jsx';
import { EffectMeters } from './components/EffectMeters.jsx';
import { GearIcon } from './components/GearIcon.jsx';
import { RotaryKnob } from './components/RotaryKnob.jsx';
import { HelpEnabledContext } from './components/HelpTip.jsx';
import { PresetBar } from './components/PresetBar.jsx';
import { SystemMenu } from './components/SystemMenu.jsx';
import { INSTAGRAM_URL } from './links.js';
import { BORDER_TRACE_LEVELS, BORDER_TRACE_SPEEDS, getBorderTraceSettings, getUiTheme, UI_THEMES } from './uiThemes.js';
import { version } from '../package.json';

const EMPTY_SAMPLE_MAP = Object.freeze({});
const BUS_MODULE_LABELS = { noise: 'Noise synth', saturation: 'Saturation', glue: 'Glue compressor' };
const INITIAL_PATCH_JSON = JSON.stringify(serializePatchState(createDefaultState()));
// JUCE round-trips host parameters through normalized 32-bit floats.
const PARAMETER_TOLERANCES = new Map(PARAMETER_SCHEMA.map(({ id, min, max }) => {
  const layer = id.match(/^l(\d+)_(.+)$/);
  const path = layer ? `layers.${layer[1]}.${layer[2]}` : id.replace('_', '.');
  return [path, (max - min) * 2e-7];
}));

export function isInitialPatch(state) {
  return !hasPatchChanges(state, JSON.parse(INITIAL_PATCH_JSON));
}

export function hasPatchChanges(state, baseline) {
  if (!baseline || typeof baseline !== 'object') return true;
  const same = (left, right, path = '') => {
    if (typeof left === 'number' && typeof right === 'number') {
      return Number.isFinite(left) && Number.isFinite(right) &&
        Math.abs(left - right) <= (PARAMETER_TOLERANCES.get(path) || 0);
    }
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
        Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) &&
        same(left[key], right[key], path ? `${path}.${key}` : key));
  };
  return !same(serializePatchState(state), baseline);
}

export function matchesReferencedSample(audio, layer, buffers) {
  const left = buffers[layer.sampleKey];
  const right = layer.sampleRightKey ? buffers[layer.sampleRightKey] : null;
  if (!left || (layer.sampleRightKey && !right) || audio.numberOfChannels !== (right ? 2 : 1) ||
      audio.sampleRate !== layer.sampleRate || audio.length !== layer.sampleCount ||
      left.length !== audio.length || (right && right.length !== audio.length)) return false;
  const channels = [audio.getChannelData(0), right ? audio.getChannelData(1) : null];
  return [left, right].every((samples, channel) =>
    !samples || samples.every((value, index) => value === channels[channel][index]));
}

export function reorderBusModules(order, source, target) {
  const from = order.indexOf(source);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}

export function observeNativeEditorHeight(element, notify) {
  let timer = 0;
  let lastHeight = 0;
  const update = () => {
    timer = 0;
    const height = Math.ceil(element.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      notify(height);
    }
  };
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 120);
  };
  const onResize = () => {
    lastHeight = 0;
    schedule();
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(element);
  window.addEventListener('resize', onResize);
  schedule();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', onResize);
    window.clearTimeout(timer);
  };
}

function getStoredThemeId() {
  if (typeof window === 'undefined' || window.__JUCE__) return getUiTheme().id;
  try {
    return getUiTheme(window.localStorage.getItem('layerforge-ui-theme')).id;
  } catch (error) {
    console.error('[LayerForge] Could not restore the UI color theme:', error);
    return getUiTheme().id;
  }
}

function getStoredBorderTrace() {
  if (typeof window === 'undefined' || window.__JUCE__) return getBorderTraceSettings();
  try {
    return getBorderTraceSettings({
      level: window.localStorage.getItem('layerforge-border-trace-level'),
      speed: window.localStorage.getItem('layerforge-border-trace-speed')
    });
  } catch (error) {
    console.error('[LayerForge] Could not restore border tracing settings:', error);
    return getBorderTraceSettings();
  }
}

export function AboutDialog({ onClose, isNativePlugin }) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="storage-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <h2 id="about-title">ABOUT LAYERFORGE</h2>
        <p>Version {version}</p>
        <p>Multi-layer drum designer and clip engine.</p>
        <p>Repository: <a href="https://github.com/ultimumdesign/LayerForge" target="_blank" rel="noreferrer">github.com/ultimumdesign/LayerForge</a></p>
        <p>Licensed under GPL-3.0-or-later.</p>
        <div className="about-signature">
          <BrandSignature isNativePlugin={isNativePlugin} />
        </div>
        <div className="storage-dialog-actions">
          <button type="button" className="btn-export" onClick={onClose} autoFocus>CLOSE</button>
        </div>
      </section>
    </div>
  );
}

export function BrandSignature({ isNativePlugin }) {
  const openInstagram = (event) => {
    if (!isNativePlugin) return;
    event.preventDefault();
    if (typeof window._postMessageToPluginBackend === 'function') {
      window._postMessageToPluginBackend('openInstagram', {});
    } else {
      console.error('[LayerForge] Cannot open Instagram: native bridge is unavailable.');
    }
  };

  return (
    <a className="brand-signature" href={INSTAGRAM_URL} target="_blank" rel="noreferrer"
      aria-label="Made with love - ayatko, open Instagram" onClick={openInstagram}>
      made with love - ayatko
    </a>
  );
}

export function WavCopyButton({ ready, exporting, status, helpEnabled, onCopy }) {
  return (
    <button
      className={`topbar-button topbar-ready ${ready ? 'is-ready' : ''}`}
      onClick={onCopy}
      disabled={!ready || exporting}
      aria-live="polite"
      title={helpEnabled ? 'Copy the prepared WAV, then paste it in your DAW. Prepare a WAV first.' : undefined}
    >
      {ready ? status || 'COPY WAV' : 'COPY WAV'}
    </button>
  );
}

function ModuleSettingsDialog({ title, onClose, onReset, children }) {
  const handleKeyDown = (event) => {
    if (event.target.closest('[role="dialog"]') !== event.currentTarget || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      const focusable = [...event.currentTarget.querySelectorAll(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && event.target === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && event.target === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="module-settings-dialog" role="dialog" aria-modal="true"
        aria-label={`${title} settings`} onKeyDown={handleKeyDown}>
        <header className="waveform-editor-dialog-header">
          <strong>{title} SETTINGS</strong>
          <div className="module-settings-actions">
            <button type="button" className="waveform-editor-close" onClick={onReset}
              aria-label={`Reset ${title.toLowerCase()} knobs to defaults`}>RESET KNOBS</button>
            <button type="button" className="waveform-editor-close" onClick={onClose} autoFocus>CLOSE</button>
          </div>
        </header>
        {children}
      </section>
    </div>
  );
}

export default function App() {
  const bridgeRef = useRef(null);
  const moduleSettingsTriggerRef = useRef(null);
  const busDragRef = useRef(null);
  const busGripRefs = useRef({});
  const chassisRef = useRef(null);
  const presetLoadingRef = useRef(false);
  const pendingPresetSaveRef = useRef(null);
  const sampleRelinkResolveRef = useRef(null);
  const patchGenerationRef = useRef(0);
  const sumRenderQueueRef = useRef({ active: false, pending: null, timer: null });
  const [themeId, setThemeId] = useState(getStoredThemeId);
  const [borderTrace, setBorderTrace] = useState(getStoredBorderTrace);
  const [state, setState] = useState(() => createDefaultState());
  const [patchBaseline, setPatchBaseline] = useState(() => serializePatchState(createDefaultState()));
  const patchBaselineRef = useRef(patchBaseline);
  patchBaselineRef.current = patchBaseline;
  const [triggered, setTriggered] = useState(false);
  const [playbackId, setPlaybackId] = useState(0);
  const [diagnostics, setDiagnostics] = useState(getDiagnostics);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [moduleSettings, setModuleSettings] = useState(null);
  const [draggingBusModule, setDraggingBusModule] = useState(null);
  const [busDropTarget, setBusDropTarget] = useState(null);
  const [busOrderAnnouncement, setBusOrderAnnouncement] = useState('');
  const [resetTarget, setResetTarget] = useState(null);
  const [helpEnabled, setHelpEnabled] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [renderedLayerSum, setRenderedLayerSum] = useState(null);
  const [sumPreviewStatus, setSumPreviewStatus] = useState('QUEUED');
  const [sumResolution, setSumResolution] = useState(2048);
  const [editorResolution, setEditorResolution] = useState(512);
  const [traceEnabled, setTraceEnabled] = useState(true);
  const [trace, setTrace] = useState(null);
  const previewResolution = Math.max(sumResolution, editorResolution);
  const previewResolutionRef = useRef(previewResolution);
  previewResolutionRef.current = previewResolution;
  const [preparedWav, setPreparedWav] = useState(null);
  const [wavActionStatus, setWavActionStatus] = useState('');
  const [presetStatus, setPresetStatus] = useState('');
  const [showPresetWarning, setShowPresetWarning] = useState(false);
  const [presetName, setPresetName] = useState('LayerForge Preset');
  const [savedPresets, setSavedPresets] = useState([]);
  const [selectedPreset, setSelectedPreset] = useState('');
  const [presetToLoad, setPresetToLoad] = useState(null);
  const [presetToDelete, setPresetToDelete] = useState(null);
  const [presetToOverwrite, setPresetToOverwrite] = useState(null);
  const [presetLibraryStatus, setPresetLibraryStatus] = useState('PRESETS LOADING');
  const [presetError, setPresetError] = useState('');
  const [sampleRelinkMessage, setSampleRelinkMessage] = useState('');
  const [pluginStateLoaded, setPluginStateLoaded] = useState(false);
  const theme = getUiTheme(themeId);
  const initialPatch = isInitialPatch(state);
  const patchChanged = hasPatchChanges(state, patchBaseline);
  const isNativePlugin = typeof window !== 'undefined' && Boolean(window.__JUCE__);
  const patchStateJson = JSON.stringify({ ...serializePatchState(state), uiTheme: themeId });
  const patchStateRef = useRef(patchStateJson);
  patchStateRef.current = patchStateJson;
  const selectedPresetRef = useRef('');
  selectedPresetRef.current = selectedPreset;
  const borderTraceRef = useRef(borderTrace);
  borderTraceRef.current = borderTrace;
  const updatePatchBaseline = useCallback((baseline) => {
    patchBaselineRef.current = baseline;
    setPatchBaseline(baseline);
  }, []);
  // The loaded preset name rides along with the host-saved state so it survives editor closes.
  const snapshotPatchState = () => ({
    ...JSON.parse(patchStateRef.current),
    uiBorderTrace: borderTraceRef.current,
    loadedPreset: selectedPresetRef.current,
    savedPatchBaseline: patchBaselineRef.current
  });

  const refreshPresetLibrary = useCallback(async () => {
    const bridge = bridgeRef.current;
    if (!bridge?.isNativePlugin) return;

    try {
      const presets = await bridge.listNativePresets();
      setSavedPresets(presets);
      setPresetLibraryStatus(presets.length ? '' : 'NO SAVED PRESETS');
    } catch (error) {
      console.error('[LayerForge] Could not browse saved presets:', error);
      setPresetLibraryStatus('PRESET LIST UNAVAILABLE');
    }
  }, []);

  useEffect(() => subscribeDiagnostics(setDiagnostics), []);

  useEffect(() => () => {
    sampleRelinkResolveRef.current?.(false);
    sampleRelinkResolveRef.current = null;
    if (pendingPresetSaveRef.current) {
      window.clearTimeout(pendingPresetSaveRef.current.timeout);
      pendingPresetSaveRef.current = null;
    }
  }, []);

  useEffect(() => {
    if ((moduleSettings === 'noise' && !state.noise.enabled) ||
        (moduleSettings === 'saturation' && !state.master.saturationEnabled) ||
        (moduleSettings === 'glue' && !state.master.glueEnabled)) {
      setModuleSettings(null);
    }
  }, [moduleSettings, state.noise.enabled, state.master.saturationEnabled, state.master.glueEnabled]);

  useEffect(() => {
    if (!isNativePlugin) return undefined;
    return observeNativeEditorHeight(chassisRef.current, (height) => {
      try {
        window.__JUCE__.backend.emitEvent('elemMessage', { type: 'editorHeight', payload: height });
      } catch (error) {
        console.error('[LayerForge] Could not update the native editor size:', error);
      }
    });
  }, [isNativePlugin]);

  useEffect(() => {
    if (isNativePlugin) return;
    try {
      window.localStorage.setItem('layerforge-ui-theme', themeId);
    } catch (error) {
      console.error('[LayerForge] Could not save the UI color theme:', error);
    }
  }, [isNativePlugin, themeId]);

  useEffect(() => {
    if (isNativePlugin) return;
    try {
      window.localStorage.setItem('layerforge-border-trace-level', borderTrace.level);
      window.localStorage.setItem('layerforge-border-trace-speed', borderTrace.speed);
    } catch (error) {
      console.error('[LayerForge] Could not save border tracing settings:', error);
    }
  }, [isNativePlugin, borderTrace]);

  useEffect(() => {
    if (!showAbout) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setShowAbout(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [showAbout]);

  useEffect(() => {
    if (!resetTarget) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setResetTarget(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [resetTarget]);

  useEffect(() => {
    const onWavActionStatus = (event) => {
      const { key, status, error } = event.detail || {};
      if (key !== preparedWav?.key) return;
      if (error) console.error('[LayerForge] Native WAV action failed:', error);

      const labels = {
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
      const { status, error, path, requestId } = event.detail || {};
      const pending = pendingPresetSaveRef.current;
      if ((status === 'saved' || status === 'failed') && (!pending || requestId !== pending.requestId)) return;
      if (status === 'saved' || status === 'failed') window.clearTimeout(pending.timeout);
      if (error) console.error('[LayerForge] Preset operation failed:', error);
      const labels = {
        saved: 'PRESET SAVED',
        loaded: 'PRESET LOADED',
        deleted: 'PRESET DELETED',
        deleteFailed: 'DELETE FAILED',
        failed: 'PRESET SAVE FAILED'
      };
      setPresetStatus(labels[status] || '');
      setPresetError(error || '');
      if (status === 'saved') {
        if (pendingPresetSaveRef.current) {
          updatePatchBaseline(pendingPresetSaveRef.current.patch);
          pendingPresetSaveRef.current = null;
        }
        setSelectedPreset(path || '');
        setShowPresetWarning(false);
        setPresetToOverwrite(null);
        refreshPresetLibrary();
      } else if (status === 'deleted') {
        setSelectedPreset('');
        refreshPresetLibrary();
      } else if (status === 'failed') {
        pendingPresetSaveRef.current = null;
      }
    };

    window.addEventListener('layerforge:presetStatus', onPresetStatus);
    return () => window.removeEventListener('layerforge:presetStatus', onPresetStatus);
  }, [refreshPresetLibrary, updatePatchBaseline]);

  const triggerHit = useCallback(async (velocity = 1.0) => {
    if (bridgeRef.current) {
      await bridgeRef.current.ensureRunning();
    }
    setPlaybackId((current) => current + 1);
    setTriggered(true);
    if (bridgeRef.current?.isNativePlugin) {
      bridgeRef.current.auditionNative(velocity);
      setTimeout(() => setTriggered(false), 28);
      return;
    }
    setState((s) => ({ ...s, gate: 1, velocity }));
    setTimeout(() => {
      setState((s) => ({ ...s, gate: 0 }));
      setTriggered(false);
    }, 28);
  }, []);

  useEffect(() => {
    const bridge = new LayerForgeBridge();
    let active = true;
    let restoring = false;
    let requestedRevision = 0;
    bridgeRef.current = bridge;

    const initialization = bridge.initialize({
      onMidiTrigger: (vel) => { if (active) triggerHit(vel); },
      onNativeMidiTrigger: (count) => {
        if (active) setPlaybackId((current) => current + count);
      },
      onMeter: (data) => {
        if (active) window.dispatchEvent(new CustomEvent('layerforge:outputMeter', { detail: data }));
      },
      onTrace: (data) => {
        if (active) window.dispatchEvent(new CustomEvent('layerforge:outputTrace', { detail: data }));
      },
      onStateRestored: async (revision) => {
        requestedRevision = Math.max(requestedRevision, revision);
        patchGenerationRef.current += 1;
        if (pendingPresetSaveRef.current) {
          window.clearTimeout(pendingPresetSaveRef.current.timeout);
          setPresetStatus('PRESET SAVE UNCONFIRMED');
          setPresetError('The host project changed during saving. Check the preset library before trying again.');
        }
        pendingPresetSaveRef.current = null;
        if (restoring) return;
        restoring = true;
        try {
          let patch;
          do {
            while (active && bridge.pendingPluginState)
              await new Promise((resolve) => window.setTimeout(resolve, 20));
            if (!active) return;
            patch = await bridge.requestNativePluginState();
          } while (active && bridge.stateRevision < requestedRevision);
          if (!active) return;
          bridge.resumeOnRender = true;
          setState(restorePatchState(patch, bridge.vfsBuffers));
          setThemeId(getUiTheme(patch?.uiTheme).id);
          setBorderTrace(getBorderTraceSettings(patch?.uiBorderTrace));
          setSelectedPreset(typeof patch?.loadedPreset === 'string' ? patch.loadedPreset : '');
          updatePatchBaseline(patch?.savedPatchBaseline ??
            (patch?.loadedPreset ? null : JSON.parse(INITIAL_PATCH_JSON)));
          setPresetToLoad(null);
          setTrace(null);
          setPreparedWav(null);
        } catch (error) {
          console.error('[LayerForge] Could not restore host state:', error);
        } finally {
          restoring = false;
        }
      },
      onParameterChange: (paramId, value) => {
        if (!active) return;
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
    });
    initialization.then(async () => {
      if (!active) return;
      if (!restoring) bridge.resumeOnRender = true;
      setState(restorePatchState(bridge.restoredPluginState, bridge.vfsBuffers));
      if (bridge.isNativePlugin) {
        updatePatchBaseline(bridge.restoredPluginState?.savedPatchBaseline ??
          (bridge.restoredPluginState?.loadedPreset ? null : JSON.parse(INITIAL_PATCH_JSON)));
        setThemeId(getUiTheme(bridge.restoredPluginState?.uiTheme).id);
        setBorderTrace(getBorderTraceSettings(bridge.restoredPluginState?.uiBorderTrace));
        const loadedPreset = bridge.restoredPluginState?.loadedPreset;
        if (typeof loadedPreset === 'string') setSelectedPreset(loadedPreset);
      }
      setPluginStateLoaded(true);
      await refreshPresetLibrary();
    }).catch((error) => {
      console.error('[LayerForge] Audio engine initialization failed:', error);
    });
    return () => {
      active = false;
      bridge.onMidiTrigger = null;
      bridge.onNativeMidiTrigger = null;
      bridge.setTraceEnabled(false);
      if (!bridge.isNativePlugin) {
        const closeAudio = () => bridge.audioCtx?.state !== 'closed' ? bridge.audioCtx?.close() : undefined;
        initialization.then(closeAudio, closeAudio).catch((error) => {
          console.error('[LayerForge] Could not close the audio engine:', error);
        });
      }
    };
  }, [refreshPresetLibrary, triggerHit, updatePatchBaseline]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (pluginStateLoaded && bridge?.resumeOnRender) {
      bridge.resumeOnRender = false;
      bridge.resumeParameterUpdates();
    }
  }, [state, pluginStateLoaded]);

  useEffect(() => {
    if (!isNativePlugin || !pluginStateLoaded) return;
    if (presetLoadingRef.current || bridgeRef.current?.suspendParameterUpdates) return;
    try {
      bridgeRef.current?.saveNativePluginState(snapshotPatchState());
    } catch (error) {
      console.error('[LayerForge] Could not save the patch state:', error);
    }
  }, [isNativePlugin, patchStateJson, selectedPreset, pluginStateLoaded, borderTrace, patchBaseline]);

  useEffect(() => {
    const flushPatchState = () => {
      if (!isNativePlugin || !pluginStateLoaded || presetLoadingRef.current ||
          bridgeRef.current?.suspendParameterUpdates) return;
      try {
        bridgeRef.current?.saveNativePluginState(snapshotPatchState());
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
    if (!bridgeRef.current || bridgeRef.current.isNativePlugin) return;
    const renderResult = bridgeRef.current.render(...buildDrumGraph(state, true, bridgeRef.current.isNativePlugin));
    renderResult?.catch((error) => {
      console.error('[LayerForge] Audio graph render failed:', error);
    });
  }, [state]);

  useEffect(() => {
    bridgeRef.current?.setTraceEnabled(traceEnabled);
  }, [traceEnabled]);

  const sampleBuffers = bridgeRef.current?.vfsBuffers || EMPTY_SAMPLE_MAP;
  const sampleRates = bridgeRef.current?.vfsSampleRates || EMPTY_SAMPLE_MAP;
  const hasCurrentRenderedSum = renderedLayerSum?.patchKey === patchStateJson &&
    renderedLayerSum.resolution === previewResolution;
  const visibleLayerSum = hasCurrentRenderedSum ? renderedLayerSum.result : {
    peaks: [], min: [], max: [], durationSec: getPatchDurationSec(state, sampleBuffers)
  };
  const visibleSumStatus = hasCurrentRenderedSum
    ? 'DSP RENDER'
    : sumPreviewStatus === 'FAILED'
      ? 'RENDER FAILED'
      : 'RENDERING';
  const traceDurationRef = useRef(visibleLayerSum.durationSec);
  traceDurationRef.current = visibleLayerSum.durationSec || 0.14;
  const channelWaveforms = visibleLayerSum.comparison?.layers;
  useEffect(() => {
    if (!traceEnabled) return undefined;
    const collector = new LiveComparisonTrace(() => traceDurationRef.current, isNativePlugin);
    const onTrace = (event) => {
      try {
        const result = collector.consume(event.detail?.data, event.detail?.sampleRate);
        if (result) setTrace({ ...result, patchKey: patchStateJson });
      } catch (error) {
        console.error('[LayerForge] Live trace failed:', error);
        setTrace({ status: 'ERROR', patchKey: patchStateJson });
      }
    };
    window.addEventListener('layerforge:outputTrace', onTrace);
    return () => window.removeEventListener('layerforge:outputTrace', onTrace);
  }, [traceEnabled, patchStateJson, isNativePlugin]);
  const audiblePlaybackTracks = useMemo(
    () => getLayerPlaybackInfo(
      { layers: state.layers, noise: state.noise },
      sampleBuffers,
      sampleRates
    ),
    [state.layers, state.noise, sampleBuffers, sampleRates]
  );
  const sumPlaybackTracks = audiblePlaybackTracks.map((track) => ({
    ...track,
    color: theme.channelColors[track.index] || theme.accent,
    id: playbackId
  }));
  const hasSolo = state.layers.some((layer) => layer.solo) || (state.noise.enabled && state.noise.solo);
  if (
    state.noise.enabled && state.noise.gain > 0.0005 &&
    !state.noise.mute &&
    (!hasSolo || state.noise.solo)
  ) {
    const durationSec = state.noise.decay + 0.016;
    sumPlaybackTracks.push({
      id: playbackId,
      color: theme.accentTertiary,
      delaySec: 0,
      durationSec,
      endTimeSec: durationSec
    });
  }

  useEffect(() => {
    const queue = sumRenderQueueRef.current;
    const job = {
      key: patchStateJson,
      resolution: previewResolution,
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
      const isCurrentJob = () => currentJob.key === patchStateRef.current &&
        currentJob.resolution === previewResolutionRef.current;
      if (isCurrentJob()) setSumPreviewStatus('RENDERING');

      try {
        const result = await renderWaveformPreview(currentJob.state, currentJob.buffers, currentJob.resolution);
        if (isCurrentJob()) {
          setRenderedLayerSum({ patchKey: currentJob.key, resolution: currentJob.resolution, result });
          setSumPreviewStatus('READY');
        }
      } catch (error) {
        console.error('[LayerForge] DSP waveform preview failed:', error);
        if (isCurrentJob()) setSumPreviewStatus('FAILED');
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
  }, [patchStateJson, previewResolution]);

  // Spacebar quick audition shortcut
  useEffect(() => {
    const onKeyDown = (e) => {
      const activeElement = document.activeElement;
      if (e.code === 'Space' &&
          !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(activeElement?.tagName) &&
          !activeElement?.isContentEditable) {
        e.preventDefault();
        triggerHit(1.0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triggerHit]);

  const updateLayer = (idx, patch) => {
    for (const [key, value] of Object.entries(patch))
      if (PARAMETER_SCHEMA.some((parameter) => parameter.id === `l${idx}_${key}`))
        bridgeRef.current?.setHostParameter(`l${idx}_${key}`, value);
    setState((s) => ({
      ...s,
      layers: s.layers.map((l, i) => (i === idx ? { ...l, ...patch } : l))
    }));
  };

  const updateSection = (section, changes) => {
    for (const [key, value] of Object.entries(changes))
      if (PARAMETER_SCHEMA.some((parameter) => parameter.id === `${section}_${key}`))
        bridgeRef.current?.setHostParameter(`${section}_${key}`, value);
    setState((s) => ({ ...s, [section]: { ...s[section], ...changes } }));
  };

  const sendPatchParameters = (patch, prefix = '') => {
    for (const parameter of PARAMETER_SCHEMA) {
      if (prefix && !parameter.id.startsWith(prefix)) continue;
      const [section, key] = parameter.id.split('_');
      const value = section.startsWith('l')
        ? patch.layers[Number(section.slice(1))][key] : patch[section][key];
      bridgeRef.current?.setHostParameter(parameter.id, value);
    }
  };

  const handleSampleDrop = async (idx, file) => {
    if (!bridgeRef.current) return;
    const generation = patchGenerationRef.current;
    let info;
    try {
      if (bridgeRef.current.isNativePlugin) {
        bridgeRef.current.saveNativePluginState(snapshotPatchState());
      }
      info = await bridgeRef.current.loadSampleFile(idx, file);
    } catch (error) {
      console.error(`[LayerForge] Could not load sample "${file.name}":`, error);
      alert(`Could not load "${file.name}": ${error.message}`);
      return;
    }
    if (generation !== patchGenerationRef.current) return;

    updateLayer(idx, {
      name: info.name,
      sourceName: info.sourceName,
      sourceLocation: info.sourceLocation,
      sampleRate: info.sampleRate,
      sampleCount: info.sampleCount,
      sampleKey: info.sampleKey,
      sampleRightKey: info.sampleRightKey,
      loaded: true,
      trimStart: info.trimStart,
      trimEnd: info.trimEnd
    });
    triggerHit(1.0).catch((error) => {
      console.error('[LayerForge] Could not audition the loaded sample:', error);
    });
  };

  const handleNativeSampleBrowse = async (idx) => {
    try {
      const file = await bridgeRef.current.chooseNativeSample();
      if (file) await handleSampleDrop(idx, file);
    } catch (error) {
      console.error('[LayerForge] Could not browse for a sample:', error);
      alert(`Could not browse for a sample: ${error.message}`);
    }
  };

  const handleRevealSample = async (idx, sourcePath) => {
    try {
      let path = sourcePath;
      if (typeof path !== 'string' || !(/^\//.test(path) || /^[A-Za-z]:[\\/]/.test(path))) {
        const layer = JSON.parse(patchStateRef.current).layers[idx];
        if (!window.confirm('The original sample location is unavailable. Select the original file to reveal it.')) return;
        const file = await bridgeRef.current.chooseNativeSample(true);
        if (!file) return;
        const currentLayer = JSON.parse(patchStateRef.current).layers[idx];
        if (!currentLayer.loaded || currentLayer.sampleKey !== layer.sampleKey) {
          throw new Error('The channel sample changed while locating the file. Try again.');
        }
        if (layer.sourceName && file.name !== layer.sourceName) {
          throw new Error(`Select the original sample "${layer.sourceName}".`);
        }
        path = file.path;
        updateLayer(idx, { sourceLocation: path });
      }
      window._postMessageToPluginBackend('revealSample', { path });
    } catch (error) {
      console.error('[LayerForge] Could not reveal sample:', error);
      alert(`Could not reveal sample: ${error.message}`);
    }
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
      setWavActionStatus('PREPARE FAILED');
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

  const requestSampleRelink = (message) => {
    if (sampleRelinkResolveRef.current) {
      return Promise.reject(new Error('A sample selection is already in progress.'));
    }
    return new Promise((resolve) => {
      sampleRelinkResolveRef.current = resolve;
      setSampleRelinkMessage(message);
    });
  };

  const finishSampleRelink = (accepted) => {
    const resolve = sampleRelinkResolveRef.current;
    sampleRelinkResolveRef.current = null;
    setSampleRelinkMessage('');
    resolve?.(accepted);
  };

  const confirmPresetExport = async (overwrite) => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    setPresetStatus('SAVING PRESET...');
    setPresetError('');
    try {
      const patch = serializePatchState(state);
      const originalPatch = JSON.stringify(patch);
      const generation = patchGenerationRef.current;
      const references = [];
      for (let index = 0; index < patch.layers.length; index += 1) {
        const layer = patch.layers[index];
        if (!layer.loaded) continue;
        let file = null;
        if (typeof layer.sourceLocation === 'string' &&
            (/^\//.test(layer.sourceLocation) || /^[A-Za-z]:[\\/]/.test(layer.sourceLocation))) {
          try {
            file = await bridge.readNativeSample(layer.sourceLocation);
            if (!matchesReferencedSample(await bridge.decodeSampleFile(file), layer, bridge.vfsBuffers)) {
              console.warn(`[LayerForge] Referenced sample no longer matches channel ${index + 1}.`);
              file = null;
            }
          } catch (error) {
            console.warn(`[LayerForge] Could not read the sample reference for channel ${index + 1}:`, error);
          }
        }
        if (!file) {
          if (!await requestSampleRelink(`Locate "${layer.sourceName || 'the original sample'}" for channel ${index + 1} to save this preset. The selected file must match the loaded audio.`)) {
            throw new Error('Sample selection canceled; the preset was not saved.');
          }
          file = await bridge.chooseNativeSample();
          if (!file) throw new Error('Sample selection canceled; the preset was not saved.');
          if (!matchesReferencedSample(await bridge.decodeSampleFile(file), layer, bridge.vfsBuffers)) {
            throw new Error(`The selected file does not match the audio loaded in channel ${index + 1}.`);
          }
        }
        if (!/^[0-9a-f]{64}$/.test(file.sha256 || '')) {
          throw new Error(`Could not verify the sample for channel ${index + 1}.`);
        }
        layer.sourceLocation = file.path;
        references.push({ layer: index, path: file.path, sha256: file.sha256 });
      }
      const currentPatch = JSON.parse(patchStateRef.current);
      delete currentPatch.uiTheme;
      if (generation !== patchGenerationRef.current || JSON.stringify(currentPatch) !== originalPatch) {
        throw new Error('The patch changed while preparing the preset. Save again.');
      }
      patchStateRef.current = JSON.stringify({ ...patch, uiTheme: themeId });
      setState((current) => ({
        ...current,
        layers: current.layers.map((layer, index) => ({
          ...layer, sourceLocation: patch.layers[index].sourceLocation
        }))
      }));
      bridge.saveNativePluginState(snapshotPatchState());
      const requestId = `preset-save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => {
        if (pendingPresetSaveRef.current?.requestId !== requestId) return;
        pendingPresetSaveRef.current = null;
        const message = 'Preset save was not confirmed. Check the preset library before trying again.';
        setPresetStatus('PRESET SAVE UNCONFIRMED');
        setPresetError(message);
        console.error(`[LayerForge] ${message}`);
      }, 60000);
      pendingPresetSaveRef.current = { patch, requestId, timeout };
      bridge.exportNativePreset(overwrite
        ? { state: patch, name: overwrite.name, overwrite: overwrite.filename, references, requestId }
        : { state: patch, name: presetName, references, requestId });
    } catch (error) {
      if (pendingPresetSaveRef.current)
        window.clearTimeout(pendingPresetSaveRef.current.timeout);
      pendingPresetSaveRef.current = null;
      setPresetStatus('PRESET SAVE FAILED');
      setPresetError(error.message);
      console.error('[LayerForge] Could not save the preset:', error);
    }
  };

  const handleSelectPreset = async (filename) => {
    setPresetError('');
    const bridge = bridgeRef.current;
    const preset = savedPresets.find((item) => item.filename === filename);
    if (!preset) {
      setPresetStatus('');
      return;
    }
    if (!preset.available) {
      setSelectedPreset(filename);
      setPresetStatus('PRESET UNAVAILABLE');
      setPresetError(preset.error || '');
      return;
    }
    if (!bridge || presetLoadingRef.current || exporting) return;

    presetLoadingRef.current = true;
    const originalPatch = JSON.stringify(serializePatchState(state));
    const generation = patchGenerationRef.current;
    let loaded = false;
    setPresetStatus('LOADING PRESET...');
    setPresetError('');
    try {
      const patch = await bridge.loadNativePreset(preset.filename, () => {
        const currentPatch = JSON.parse(patchStateRef.current);
        delete currentPatch.uiTheme;
        return generation === patchGenerationRef.current && JSON.stringify(currentPatch) === originalPatch;
      }, requestSampleRelink);
      const restored = restorePatchState(patch, bridge.vfsBuffers);
      const currentTheme = JSON.parse(patchStateRef.current).uiTheme;
      patchStateRef.current = JSON.stringify({ ...serializePatchState(restored), uiTheme: currentTheme });
      updatePatchBaseline(serializePatchState(restored));
      bridge.saveNativePluginState({ ...snapshotPatchState(), loadedPreset: filename });
      setState(restored);
      setSelectedPreset(filename);
      setPresetStatus('PRESET LOADED');
      loaded = true;
    } catch (error) {
      console.error('[LayerForge] Could not load the saved preset:', error);
      setPresetStatus('PRESET LOAD FAILED');
      setPresetError(error.message);
    } finally {
      presetLoadingRef.current = false;
      if (!loaded && generation === patchGenerationRef.current && !bridge.suspendParameterUpdates) {
        try {
          bridge.saveNativePluginState(snapshotPatchState());
        } catch (error) {
          console.error('[LayerForge] Could not save the patch state after loading a preset:', error);
        }
      }
    }
  };

  const requestPresetLoad = (filename) => {
    const preset = savedPresets.find((item) => item.filename === filename);
    if (preset?.available && patchChanged) {
      setPresetToLoad(preset);
      return;
    }
    handleSelectPreset(filename);
  };

  const confirmPresetDelete = () => {
    const bridge = bridgeRef.current;
    if (!bridge || !presetToDelete) return;
    try {
      bridge.deleteNativePreset(presetToDelete.filename);
      setPresetStatus('DELETING PRESET...');
      setPresetError('');
    } catch (error) {
      console.error('[LayerForge] Could not delete the saved preset:', error);
      setPresetStatus('DELETE FAILED');
      setPresetError(error.message);
    }
    setPresetToDelete(null);
  };

  const initializePatch = () => {
    patchGenerationRef.current += 1;
    const initialized = createDefaultState();
    sendPatchParameters(initialized);
    patchStateRef.current = JSON.stringify({ ...serializePatchState(initialized), uiTheme: themeId });
    updatePatchBaseline(serializePatchState(initialized));
    setState(initialized);
    setTrace(null);
    setSelectedPreset('');
    setPresetStatus('');
    setPresetError('');
    setPreparedWav(null);
    setWavActionStatus('');
  };

  const confirmReset = () => {
    if (resetTarget?.kind === 'channel') {
      const index = resetTarget.index;
      sendPatchParameters({ ...state, layers: state.layers.map((layer, i) =>
        i === index ? resetLayerKnobs(layer) : layer) }, `l${index}_`);
      setState((current) => ({
        ...current,
        layers: current.layers.map((layer, layerIndex) =>
          layerIndex === index ? resetLayerKnobs(layer) : layer)
      }));
    } else if (resetTarget?.kind === 'module') {
      sendPatchParameters(resetBusModuleKnobs(state, resetTarget.module),
        resetTarget.module === 'noise' ? 'noise_' : `master_${resetTarget.module}`);
      setState((current) => resetBusModuleKnobs(current, resetTarget.module));
    } else if (resetTarget?.kind === 'patch' && !presetLoadingRef.current && !exporting &&
               presetStatus !== 'SAVING PRESET...') {
      initializePatch();
    }
    setResetTarget(null);
  };

  const selectedPresetInfo = savedPresets.find((item) => item.filename === selectedPreset);

  const moveBusModule = (source, target, restoreFocus = false) => {
    const next = reorderBusModules(state.master.busOrder, source, target);
    if (next === state.master.busOrder) return;
    setState((current) => ({
      ...current,
      master: { ...current.master, busOrder: reorderBusModules(current.master.busOrder, source, target) }
    }));
    setBusOrderAnnouncement(`${BUS_MODULE_LABELS[source]} moved to position ${next.indexOf(source) + 1} of ${next.length}.`);
    if (restoreFocus) requestAnimationFrame(() => busGripRefs.current[source]?.focus());
  };

  const endBusDrag = () => {
    busDragRef.current = null;
    setDraggingBusModule(null);
    setBusDropTarget(null);
  };

  const busDropProps = (id) => ({
    'data-bus-module': id,
    onDragOver: (event) => {
      if (!busDragRef.current) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setBusDropTarget(id);
    },
    onDrop: (event) => {
      const source = busDragRef.current;
      if (!source) return;
      event.preventDefault();
      moveBusModule(source, id);
      endBusDrag();
    }
  });

  const busGrip = (id, index) => {
    const label = BUS_MODULE_LABELS[id];
    return (
      <button type="button" className="bus-reorder-grip" draggable="true"
        ref={(element) => { busGripRefs.current[id] = element; }}
        aria-label={`Reorder ${label}, position ${index + 1} of ${state.master.busOrder.length}`}
        aria-describedby="bus-reorder-hint" aria-keyshortcuts="ArrowUp ArrowDown"
        title={`Drag ${label} to reorder, or use the up and down arrow keys`}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          moveBusModule(id, state.master.busOrder[index + (event.key === 'ArrowUp' ? -1 : 1)], true);
        }}
        onDragStart={(event) => {
          busDragRef.current = id;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', id);
          setDraggingBusModule(id);
        }}
        onDragEnd={endBusDrag}>
        <span aria-hidden="true">⠿</span>
      </button>
    );
  };

  const closeModuleSettings = () => {
    setModuleSettings(null);
    moduleSettingsTriggerRef.current?.focus();
  };

  const settingsButton = (id, label, disabled = false) => (
    <button type="button" className="action-btn action-btn-utility module-settings-button"
      aria-label={`${label} settings`} aria-haspopup="dialog" disabled={disabled}
      onClick={(event) => {
        moduleSettingsTriggerRef.current = event.currentTarget;
        setModuleSettings(id);
      }}>
      <GearIcon />
    </button>
  );

  return (
    <HelpEnabledContext.Provider value={helpEnabled}>
    <div
      ref={chassisRef}
      className={`chassis${isNativePlugin ? ' native-host' : ''}`}
      data-theme={theme.id}
      data-border-trace={borderTrace.level}
      data-border-trace-speed={borderTrace.speed}
      style={{
        '--theme-background': theme.background,
        '--theme-surface': theme.surface,
        '--theme-raised': theme.raised,
        '--theme-panel': theme.panel,
        '--theme-border': theme.border,
        '--theme-accent': theme.accent,
        '--theme-accent-secondary': theme.accentSecondary,
        '--theme-accent-tertiary': theme.accentTertiary,
        '--theme-glow': theme.glow,
        '--theme-text': theme.text,
        '--theme-muted': theme.muted,
        '--theme-grid': theme.grid
      }}
    >
      {/* Header Bar */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-monitor" role="img" aria-label={`LayerForge version ${version}`}>
            <div className={`brand-screen lcd ${triggered ? 'is-hit' : ''}`}>
              <span className="brand-name">LAYERFORGE</span>
              <span className="brand-version">v{version} <i aria-hidden="true" /></span>
            </div>
          </div>
        </div>

        <div className="actions">
          <div className="topbar-row">
          {isNativePlugin && (
            <PresetBar
              presets={savedPresets}
              selected={selectedPreset}
              libraryStatus={presetLibraryStatus}
              status={presetStatus}
              error={presetError}
              isInitialPatch={initialPatch}
              busy={presetStatus === 'LOADING PRESET...' || presetStatus === 'SAVING PRESET...' || exporting}
              ready={pluginStateLoaded}
              onSelect={requestPresetLoad}
              onInitialize={() => patchChanged ? setResetTarget({ kind: 'patch' }) : initializePatch()}
              onRefresh={refreshPresetLibrary}
              onSave={() => {
                setPresetError('');
                if (selectedPresetInfo?.available) {
                  setPresetToOverwrite(selectedPresetInfo);
                } else {
                  setShowPresetWarning(true);
                }
              }}
              onSaveAs={() => {
                setShowPresetWarning(true);
                setPresetError('');
              }}
              onDelete={(preset) => {
                setPresetError('');
                setPresetToDelete(preset);
              }}
            />
          )}
          </div>
          <div className="topbar-row">
          <div className="topbar-group" role="group" aria-label="Audio">
            <button
              className={`topbar-button topbar-hit ${triggered ? 'is-active' : ''}`}
              onMouseDown={() => triggerHit(1.0)}
            >
              HIT [SPACE / MIDI]
            </button>
            <button
              className="topbar-button"
              onClick={handleExport}
              disabled={exporting}
              title={helpEnabled ? (isNativePlugin ? 'Render a WAV in memory for copying or saving' : 'Render and download a 24-bit WAV') : undefined}
            >
              {exporting ? 'RENDERING WAV...' : wavActionStatus === 'PREPARE FAILED'
                ? 'PREPARE FAILED - RETRY'
                : isNativePlugin ? 'PREPARE WAV' : 'EXPORT 24-BIT .WAV'}
            </button>
            <WavCopyButton ready={Boolean(preparedWav)} exporting={exporting}
              status={wavActionStatus} helpEnabled={helpEnabled} onCopy={handleCopyPreparedWav} />
            <button
              className="topbar-button"
              onClick={handleSavePreparedWav}
              disabled={!preparedWav || exporting}
              title={helpEnabled ? 'Save a permanent WAV copy to a location you choose' : undefined}
            >
              SAVE WAV
            </button>
          </div>
          <label className="theme-picker lcd" htmlFor="layerforge-theme-select">
            <span>THEME</span>
            <select
              id="layerforge-theme-select"
              value={themeId}
              onChange={(event) => setThemeId(event.target.value)}
              aria-label="Color theme"
            >
              {UI_THEMES.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <SystemMenu
            isNativePlugin={isNativePlugin}
            helpEnabled={helpEnabled}
            onToggleHelp={() => setHelpEnabled((enabled) => !enabled)}
            borderTrace={borderTrace}
            onCycleBorderTraceLevel={() => setBorderTrace((current) => ({
              ...current, level: BORDER_TRACE_LEVELS[(BORDER_TRACE_LEVELS.indexOf(current.level) + 1) % BORDER_TRACE_LEVELS.length]
            }))}
            onCycleBorderTraceSpeed={() => setBorderTrace((current) => ({
              ...current, speed: BORDER_TRACE_SPEEDS[(BORDER_TRACE_SPEEDS.indexOf(current.speed) + 1) % BORDER_TRACE_SPEEDS.length]
            }))}
            initializeDisabled={(isNativePlugin && !pluginStateLoaded) || presetStatus === 'LOADING PRESET...' ||
              presetStatus === 'SAVING PRESET...' || exporting}
            onInitialize={() => setResetTarget({ kind: 'patch' })}
            onAbout={() => setShowAbout(true)}
            onDiagnostics={() => setShowDiagnostics((open) => !open)}
            diagnosticsCount={diagnostics.length}
          />
          </div>
        </div>
      </header>

      {showDiagnostics && (
        <DiagnosticsPanel entries={diagnostics} onClose={() => setShowDiagnostics(false)} />
      )}

      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} isNativePlugin={isNativePlugin} />}

      <main className="rack">
        {state.layers.map((layer, idx) => (
          <ChannelStrip
            key={idx}
            index={idx}
            layer={layer}
            sampleBuffers={sampleBuffers}
            sampleRates={sampleRates}
            processedWaveform={channelWaveforms?.[idx]}
            processedDuration={visibleLayerSum.durationSec}
            processedStatus={visibleSumStatus}
            editorResolution={editorResolution}
            onEditorResolutionChange={setEditorResolution}
            channelColors={theme.channelColors}
            playbackId={playbackId}
            onFileDrop={handleSampleDrop}
            onNativeSampleBrowse={isNativePlugin ? handleNativeSampleBrowse : undefined}
            onRevealSample={isNativePlugin ? (path) => handleRevealSample(idx, path) : undefined}
            onChange={updateLayer}
            onResetKnobs={(index) => setResetTarget({ kind: 'channel', index })}
            onSwapSamples={(other) => setState((current) => ({
              ...current, layers: swapLayerSamples(current.layers, idx, other)
            }))}
            allLayers={state.layers}
          />
        ))}
        <section className="strip strip-master">
          <div className="strip-header">
            <span className="strip-tag tag-rose">SIGNAL CHAIN</span>
          </div>
          <div className="bus-flow-start">CHANNELS</div>
          <div id="bus-reorder-hint" className="bus-reorder-hint">DRAG GRIP TO REORDER · ↑/↓ KEYS</div>
          <div className="visually-hidden" role="status" aria-live="polite">{busOrderAnnouncement}</div>
          <div className="master-modules" aria-label="Signal chain flow">
        {state.master.busOrder.map((module, index) => module === 'noise' ? (
        <section key={module} {...busDropProps(module)} className={`effect-section noise-module ${
          state.noise.enabled && !state.noise.mute && state.noise.gain > 0.0005 &&
          (!hasSolo || state.noise.solo) ? 'flow-active' : ''
        }${draggingBusModule === module ? ' is-dragging' : ''}${busDropTarget === module && draggingBusModule !== module ? ' is-drop-target' : ''}`}>
          <div className="effect-heading">
            {busGrip('noise', index)}
            <strong>{index + 1} · NOISE SYNTH</strong>
            {settingsButton('noise', 'Noise synth', !state.noise.enabled)}
            <button type="button"
              className={`effect-toggle ${state.noise.enabled ? 'effect-enabled' : ''}`}
              aria-label={state.noise.enabled ? 'Disable noise synth' : 'Enable noise synth'}
              aria-pressed={state.noise.enabled}
              onClick={() => setState((s) => ({
                ...s, noise: { ...s.noise, enabled: !s.noise.enabled }
              }))}>{state.noise.enabled ? 'ON · BYPASS' : 'OFF · ENABLE'}</button>
          </div>

          {moduleSettings === 'noise' && state.noise.enabled && (
          <ModuleSettingsDialog title="NOISE SYNTH" onClose={closeModuleSettings}
            onReset={() => setResetTarget({ kind: 'module', module: 'noise' })}>
          <NoiseWaveform
            noise={state.noise}
            waveform={visibleLayerSum.comparison?.noise}
            editorResolution={editorResolution}
            onEditorResolutionChange={setEditorResolution}
            durationSec={visibleLayerSum.durationSec}
            previewStatus={visibleSumStatus}
            playbackId={playbackId}
            accent={theme.accentTertiary}
            onChange={(changes) => updateSection('noise', changes)}
          />

          <div className="knob-grid">
            <RotaryKnob
              label="FREQ"
              value={state.noise.cutoff}
              min={20}
              max={20000}
              defaultValue={4800}
              unit="Hz"
              decimals={0}
              accent="var(--theme-accent-tertiary)"
              onChange={(v) => updateSection('noise', { cutoff: v })}
            />
            <RotaryKnob
              label="RESO"
              value={state.noise.q}
              min={0.1}
              max={30}
              defaultValue={1.4}
              decimals={1}
              accent="var(--theme-accent-tertiary)"
              onChange={(v) => updateSection('noise', { q: v })}
            />
            <RotaryKnob
              label="DECAY"
              value={state.noise.decay}
              min={0.002}
              max={3}
              defaultValue={0.075}
              unit="s"
              decimals={3}
              accent="var(--theme-accent-tertiary)"
              onChange={(v) => updateSection('noise', { decay: v })}
            />
            <RotaryKnob
              label="CLIP DRV"
              value={state.noise.clipDrive}
              min={0}
              max={36}
              defaultValue={3.0}
              unit="dB"
              decimals={1}
              accent="var(--theme-accent-secondary)"
              onChange={(v) => updateSection('noise', { clipDrive: v })}
            />
            <RotaryKnob
              label="MIX"
              value={state.noise.gain}
              min={0}
              max={2}
              defaultValue={0.22}
              decimals={2}
              accent="var(--theme-accent)"
              onChange={(v) => updateSection('noise', { gain: v })}
            />
          </div>
          </ModuleSettingsDialog>
          )}
        </section>

        ) : module === 'saturation' ? (
          <div key={module} {...busDropProps(module)} className={`effect-section ${state.master.saturationEnabled ? 'flow-active' : ''}${draggingBusModule === module ? ' is-dragging' : ''}${busDropTarget === module && draggingBusModule !== module ? ' is-drop-target' : ''}`}>
            <div className="effect-heading">
              {busGrip('saturation', index)}
              <strong>{index + 1} · SATURATION</strong>
              {settingsButton('saturation', 'Saturation', !state.master.saturationEnabled)}
              <button
                type="button"
                className={`effect-toggle ${state.master.saturationEnabled ? 'effect-enabled' : ''}`}
                aria-label={state.master.saturationEnabled ? 'Bypass master saturation' : 'Enable master saturation'}
                aria-pressed={state.master.saturationEnabled}
                onClick={() => setState((s) => ({
                  ...s, master: { ...s.master, saturationEnabled: !s.master.saturationEnabled }
                }))}
              >{state.master.saturationEnabled ? 'ON · BYPASS' : 'OFF · ENABLE'}</button>
            </div>
            {moduleSettings === 'saturation' && state.master.saturationEnabled && (
              <ModuleSettingsDialog title="SATURATION" onClose={closeModuleSettings}
            onReset={() => setResetTarget({ kind: 'module', module: 'saturation' })}>
              <EffectMeters effect="saturation" />
              <div className="knob-grid effect-knobs effect-knobs-three">
                <RotaryKnob
                  label="SAT DRIVE" value={state.master.saturationDrive} min={0} max={24}
                  defaultValue={6} unit="dB" decimals={1}
                  onChange={(v) => updateSection('master', { saturationDrive: v })}
                />
                <RotaryKnob
                  label="SAT DRY/WET" value={state.master.saturationMix} min={0} max={1}
                  defaultValue={1} decimals={2}
                  onChange={(v) => updateSection('master', { saturationMix: v })}
                />
                <RotaryKnob
                  label="OUTPUT" value={state.master.saturationGainDb} min={-24} max={24}
                  defaultValue={0} unit="dB" decimals={1}
                  onChange={(v) => updateSection('master', { saturationGainDb: v })}
                />
              </div>
              </ModuleSettingsDialog>
            )}
          </div>
        ) : (
          <div key={module} {...busDropProps(module)} className={`effect-section ${state.master.glueEnabled ? 'flow-active' : ''}${draggingBusModule === module ? ' is-dragging' : ''}${busDropTarget === module && draggingBusModule !== module ? ' is-drop-target' : ''}`}>
            <div className="effect-heading">
              {busGrip('glue', index)}
              <strong>{index + 1} · GLUE COMPRESSOR</strong>
              {settingsButton('glue', 'Glue compressor', !state.master.glueEnabled)}
              <button
                type="button"
                className={`effect-toggle ${state.master.glueEnabled ? 'effect-enabled' : ''}`}
                aria-label={state.master.glueEnabled ? 'Bypass glue compressor' : 'Enable glue compressor'}
                aria-pressed={state.master.glueEnabled}
                onClick={() => setState((s) => ({
                  ...s, master: { ...s.master, glueEnabled: !s.master.glueEnabled }
                }))}
              >{state.master.glueEnabled ? 'ON · BYPASS' : 'OFF · ENABLE'}</button>
            </div>
            {moduleSettings === 'glue' && state.master.glueEnabled && (
              <ModuleSettingsDialog title="GLUE COMPRESSOR" onClose={closeModuleSettings}
            onReset={() => setResetTarget({ kind: 'module', module: 'glue' })}>
              <EffectMeters effect="glue" />
              <div className="knob-grid effect-knobs">
                <RotaryKnob
                  label="THRESH" value={state.master.glueThreshold} min={-36} max={0}
                  defaultValue={-12} unit="dB" decimals={1}
                  onChange={(v) => updateSection('master', { glueThreshold: v })}
                />
                <RotaryKnob
                  label="RATIO" value={state.master.glueRatio} min={1} max={8}
                  defaultValue={2} unit=":1" decimals={1}
                  onChange={(v) => updateSection('master', { glueRatio: v })}
                />
                <RotaryKnob
                  label="ATTACK" value={state.master.glueAttack * 1000} min={1} max={100}
                  defaultValue={10} unit="ms" decimals={0}
                  onChange={(v) => updateSection('master', { glueAttack: v / 1000 })}
                />
                <RotaryKnob
                  label="RELEASE" value={state.master.glueRelease * 1000} min={30} max={600}
                  defaultValue={120} unit="ms" decimals={0}
                  onChange={(v) => updateSection('master', { glueRelease: v / 1000 })}
                />
                <RotaryKnob
                  label="KNEE" value={state.master.glueKnee} min={0} max={24}
                  defaultValue={6} unit="dB" decimals={1}
                  onChange={(v) => updateSection('master', { glueKnee: v })}
                />
                <RotaryKnob
                  label="DRY/WET" value={state.master.glueMix} min={0} max={1}
                  defaultValue={1} decimals={2}
                  onChange={(v) => updateSection('master', { glueMix: v })}
                />
                <RotaryKnob
                  label="OUTPUT" value={state.master.glueGainDb} min={-24} max={24}
                  defaultValue={0} unit="dB" decimals={1}
                  onChange={(v) => updateSection('master', { glueGainDb: v })}
                />
              </div>
              </ModuleSettingsDialog>
            )}
          </div>
        ))}
          </div>

          <div className="bus-flow-end">TO OUTPUT STAGE</div>
        </section>

        <section className="output-stage" aria-label="Output stage controls">
          <div className="output-stage-heading">OUTPUT STAGE · CLIPPER → CEILING → OUTPUT</div>
          <div className="knob-grid master-knobs">
            <RotaryKnob
              label="BUS DRIVE"
              value={state.master.drive}
              min={0}
              max={24}
              defaultValue={2.0}
              unit="dB"
              decimals={1}
              accent="var(--theme-accent-secondary)"
              onChange={(v) => updateSection('master', { drive: v })}
            />
            <RotaryKnob
              label="SOFT/HARD"
              value={state.master.hardness}
              min={0}
              max={1}
              defaultValue={0.45}
              decimals={2}
              accent="var(--theme-accent-secondary)"
              onChange={(v) => updateSection('master', { hardness: v })}
            />
            <RotaryKnob
              label="CEILING"
              value={state.master.ceiling}
              min={0.1}
              max={1.0}
              defaultValue={0.95}
              decimals={2}
              accent="var(--theme-accent)"
              onChange={(v) => updateSection('master', { ceiling: v })}
            />
            <RotaryKnob
              label="OUTPUT"
              value={state.master.outputDb}
              min={-60}
              max={12}
              defaultValue={0}
              unit="dB"
              decimals={1}
              description="Adjust final output after the clipper and ceiling. Boosting can exceed 0 dBFS."
              accent="var(--theme-accent-secondary)"
              onChange={(v) => updateSection('master', { outputDb: v })}
            />
          </div>
        </section>

        <div className="rack-sum">
          <LayerSumViewer
            sum={visibleLayerSum}
            previewStatus={visibleSumStatus}
            playheads={sumPlaybackTracks}
            playbackId={playbackId}
            theme={theme}
            layers={state.layers}
            noise={state.noise}
            resolution={sumResolution}
            onResolutionChange={setSumResolution}
            traceEnabled={traceEnabled}
            trace={trace}
            onTraceEnabledChange={(enabled) => {
              setTrace(null);
              setTraceEnabled(enabled);
            }}
            patchKey={patchStateJson}
          />
          <OutputMeter />
        </div>
      </main>

      {resetTarget && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="reset-title">
              {resetTarget.kind === 'patch' ? 'INITIALIZE PATCH?'
                : resetTarget.kind === 'module' ? `RESET ${BUS_MODULE_LABELS[resetTarget.module].toUpperCase()} KNOBS?`
                : `RESET CH 0${resetTarget.index + 1} KNOBS?`}
            </h2>
            <p>
              {resetTarget.kind === 'patch'
                ? 'Remove all loaded samples and restore the initial channel, noise and master settings? Noise will be disabled. Unsaved changes will be lost.'
                : resetTarget.kind === 'module'
                  ? 'Reset this module\'s knobs to their defaults? Its on/off state and position in the signal flow are kept.'
                  : 'Reset all channel knobs to their defaults? The sample, trim, envelope, mute and solo settings will be kept.'}
            </p>
            <div className="storage-dialog-actions">
              <button type="button" className="btn-debug" onClick={() => setResetTarget(null)} autoFocus>
                CANCEL
              </button>
              <button
                type="button"
                className="btn-export btn-export-warning"
                onClick={confirmReset}
                disabled={resetTarget.kind === 'patch' && (presetStatus === 'LOADING PRESET...' ||
                  presetStatus === 'SAVING PRESET...' || exporting)}
              >
                {resetTarget.kind === 'patch' ? 'INITIALIZE' : 'RESET KNOBS'}
              </button>
            </div>
          </section>
        </div>
      )}

      {presetToLoad && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-load-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="preset-load-title">LOAD PRESET?</h2>
            <p>
              Loading "{presetToLoad.name}" replaces the current patch. Unsaved settings and
              samples will be lost. To keep them, save first, then select the preset again.
            </p>
            <div className="storage-dialog-actions">
              <button type="button" className="btn-debug" onClick={() => setPresetToLoad(null)} autoFocus>
                CANCEL
              </button>
              <button type="button" className="btn-debug" onClick={() => {
                setPresetToLoad(null);
                setPresetError('');
                setShowPresetWarning(true);
              }}>
                SAVE AS
              </button>
              <button type="button" className="btn-export btn-export-warning" onClick={() => {
                setPresetToLoad(null);
                handleSelectPreset(presetToLoad.filename);
              }}>
                LOAD WITHOUT SAVING
              </button>
            </div>
          </section>
        </div>
      )}

      {showPresetWarning && !sampleRelinkMessage && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-warning-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="preset-warning-title">SAVE PRESET</h2>
            <p>
              Saves the plugin configuration and references to the original sample files, not
              the audio itself. Moving or changing a sample requires locating the original file
              when loading. Presets are stored in the LayerForge preset library.
            </p>
            <label className="preset-name-field">
              <span>PRESET NAME</span>
              <input
                type="text"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                maxLength={100}
              />
            </label>
            {presetError && <p className="preset-dialog-error">{presetError}</p>}
            <div className="storage-dialog-actions">
              <button
                className="btn-debug"
                onClick={() => {
                  setShowPresetWarning(false);
                  setPresetError('');
                }}
              >
                CANCEL
              </button>
              <button
                className="btn-export btn-export-warning"
                onClick={() => confirmPresetExport()}
                disabled={!presetName.trim() || presetStatus === 'SAVING PRESET...'}
              >
                SAVE PRESET
              </button>
            </div>
          </section>
        </div>
      )}
      {presetToOverwrite && !sampleRelinkMessage && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-overwrite-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="preset-overwrite-title">REPLACE PRESET?</h2>
            <p>
              Replace "{presetToOverwrite.name}" with the current patch and its sample references? The previous
              contents of this preset cannot be recovered.
            </p>
            {presetError && <p className="preset-dialog-error">{presetError}</p>}
            <div className="storage-dialog-actions">
              <button className="btn-debug" onClick={() => setPresetToOverwrite(null)} autoFocus>
                CANCEL
              </button>
              <button
                className="btn-export btn-export-warning"
                onClick={() => confirmPresetExport(presetToOverwrite)}
                disabled={presetStatus === 'SAVING PRESET...'}
              >
                REPLACE
              </button>
            </div>
          </section>
        </div>
      )}
      {sampleRelinkMessage && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="sample-relink-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="sample-relink-title">LOCATE ORIGINAL SAMPLE</h2>
            <p>{sampleRelinkMessage}</p>
            <div className="storage-dialog-actions">
              <button type="button" className="btn-debug" onClick={() => finishSampleRelink(false)} autoFocus>
                CANCEL
              </button>
              <button type="button" className="btn-export btn-export-warning" onClick={() => finishSampleRelink(true)}>
                LOCATE SAMPLE
              </button>
            </div>
          </section>
        </div>
      )}
      {presetToDelete && (
        <div className="modal-backdrop">
          <section className="storage-dialog" role="dialog" aria-modal="true" aria-labelledby="preset-delete-title">
            <span className="storage-dialog-icon">!</span>
            <h2 id="preset-delete-title">DELETE SAVED PRESET?</h2>
            <p>
              {presetToDelete.available
                ? `Remove "${presetToDelete.name}" from the LayerForge preset library? This cannot be undone.`
                : `"${presetToDelete.name}" is unavailable: ${presetToDelete.error}. Delete it from the library?`}
            </p>
            {presetError && <p className="preset-dialog-error">{presetError}</p>}
            <div className="storage-dialog-actions">
              <button className="btn-debug" onClick={() => setPresetToDelete(null)}>
                CANCEL
              </button>
              <button className="btn-export btn-export-warning" onClick={confirmPresetDelete}>
                DELETE PRESET
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
    </HelpEnabledContext.Provider>
  );
}
