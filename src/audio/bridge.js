import { Renderer as ElementaryRenderer } from '@elemaudio/core';
import WebRenderer from '@elemaudio/web-renderer';
import outputMonitorSource from './outputMonitorWorklet.js?raw';
import { getDefaultSampleTrim } from './waveform.js';

function createNativeInstructionRemapper() {
  const mappedIds = new Map();
  const usedIds = new Set();
  let nextId = Math.floor(Math.random() * 0x7fffffff);

  const mapId = (id) => {
    if (!mappedIds.has(id)) {
      while (usedIds.has(nextId)) nextId = (nextId + 1) & 0x7fffffff;
      mappedIds.set(id, nextId);
      usedIds.add(nextId);
      nextId = (nextId + 1) & 0x7fffffff;
    }
    return mappedIds.get(id);
  };

  return (batch) =>
    batch.map((instruction) => {
      const remapped = [...instruction];
      switch (instruction[0]) {
        case 0:
        case 1:
        case 3:
          remapped[1] = mapId(instruction[1]);
          break;
        case 2:
          remapped[1] = mapId(instruction[1]);
          remapped[2] = mapId(instruction[2]);
          break;
        case 4:
          remapped[1] = instruction[1].map(mapId);
          break;
      }
      return remapped;
    });
}

/**
 * Unified Audio & MIDI Bridge
 * Automatically detects whether the UI is running inside a native JUCE VST3/AU wrapper
 * or inside a standalone browser tab for rapid dev/prototyping.
 */
export class LayerForgeBridge {
  constructor() {
    this.isNativePlugin = typeof window !== 'undefined' && Boolean(window.__JUCE__);
    this.core = null;
    this.audioCtx = null;
    this.vfsBuffers = {};
    this.vfsSampleRates = {};
    this.onMidiTrigger = null;
    this.onNativeMidiTrigger = null;
    this.onParameterChange = null;
    this.onStateRestored = null;
    this.stateRevision = 0;
    this.parameterUpdates = {};
    this.suspendParameterUpdates = true;
    this.resumeOnRender = false;
    this.onMeter = null;
    this.onTrace = null;
    this.traceEnabled = false;
    this.traceGeneration = 0;
    this.outputMonitor = null;
    this.isInitialized = false;
    this.pluginStateLoaded = !this.isNativePlugin;
    this.restoredPluginState = null;
    this.pendingPluginState = null;
    this.pendingPluginStateRequestId = null;
    this.pendingRender = null;
    this.remapNativeInstructions = createNativeInstructionRemapper();
    this.pendingWavTransfers = new Map();
    this.pendingClipboardWrites = new Map();
    this.pendingPresetList = null;
    this.pendingSampleFile = null;
    this.nativeSampleFileListener = (details) => {
      const pending = this.pendingSampleFile;
      if (!pending || details.requestId !== pending.requestId) return;
      if (details.action === 'begin') {
        if (!Number.isSafeInteger(details.size) || details.size <= 0 || details.size > 0x7fffffff ||
            typeof details.name !== 'string' || typeof details.path !== 'string') {
          this.pendingSampleFile = null;
          pending.reject(new Error('Invalid sample file from the native host.'));
          return;
        }
        try {
          pending.bytes = new Uint8Array(details.size);
          pending.name = details.name;
          pending.path = details.path;
          pending.sha256 = details.sha256;
          pending.received = 0;
        } catch (error) {
          this.pendingSampleFile = null;
          pending.reject(error);
        }
      } else if (details.action === 'chunk') {
        if (!pending.bytes || details.offset !== pending.received || !Array.isArray(details.bytes) ||
            details.bytes.length > pending.bytes.length - pending.received ||
            details.bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
          this.pendingSampleFile = null;
          pending.reject(new Error('Native sample file transfer is invalid or incomplete.'));
          return;
        }
        pending.bytes.set(details.bytes, pending.received);
        pending.received += details.bytes.length;
      } else if (details.action === 'end') {
        this.pendingSampleFile = null;
        if (!pending.bytes || pending.received !== pending.bytes.length) {
          pending.reject(new Error('Native sample file transfer ended before completion.'));
          return;
        }
        pending.resolve({
          name: pending.name, path: pending.path, sha256: pending.sha256,
          arrayBuffer: async () => pending.bytes.buffer
        });
      } else if (details.action === 'location') {
        this.pendingSampleFile = null;
        if (!pending.locationOnly || typeof details.name !== 'string' || !details.name ||
            typeof details.path !== 'string' || !details.path) {
          pending.reject(new Error('Invalid sample location from the native host.'));
          return;
        }
        pending.resolve({ name: details.name, path: details.path });
      } else if (details.action === 'cancel') {
        this.pendingSampleFile = null;
        pending.resolve(null);
      } else if (details.action === 'error') {
        this.pendingSampleFile = null;
        pending.reject(new Error(details.error || 'Could not open the sample file.'));
      }
    };
    this.nativeRevealSampleListener = ({ error }) => {
      if (error) {
        console.error('[LayerForge] Could not reveal sample:', error);
        window.alert(error);
      }
    };
    this.nativeWavReadyListener = ({ key, success, error }) => {
      const pending = this.pendingWavTransfers.get(key);
      if (!pending) return;

      window.clearTimeout(pending.timeout);
      this.pendingWavTransfers.delete(key);
      if (success) {
        pending.resolve(key);
      } else {
        pending.reject(new Error(error || 'The native host could not stage the WAV for export.'));
      }
    };
    this.nativeWavClipboardListener = ({ requestId, success, error }) => {
      const pending = this.pendingClipboardWrites.get(requestId);
      if (!pending) return;

      window.clearTimeout(pending.timeout);
      this.pendingClipboardWrites.delete(requestId);
      if (success) {
        pending.resolve();
      } else {
        pending.reject(new Error(error || 'The native host could not copy the WAV to the clipboard.'));
      }
    };
    this.nativeWavActionStatusListener = (details) => {
      window.dispatchEvent(new CustomEvent('layerforge:wavActionStatus', { detail: details }));
    };
    this.nativePresetStatusListener = (details) => {
      window.dispatchEvent(new CustomEvent('layerforge:presetStatus', { detail: details }));
    };
    this.nativePresetListListener = ({ requestId, presets, error }) => {
      const pending = this.pendingPresetList;
      if (!pending || requestId !== pending.requestId) return;

      window.clearTimeout(pending.timeout);
      this.pendingPresetList = null;
      if (error) pending.reject(new Error(error));
      else if (!Array.isArray(presets)) pending.reject(new Error('Invalid preset library response.'));
      else pending.resolve(presets);
    };
    this.nativePresetLoadFailureListener = ({ requestId, error }) => {
      const pending = this.pendingPluginState;
      if (!pending || requestId !== this.pendingPluginStateRequestId) return;

      window.clearTimeout(pending.timeout);
      this.pendingPluginState = null;
      this.pendingPluginStateRequestId = null;
      pending.reject(new Error(error || 'Could not load the selected preset.'));
    };
    this.nativePresetReferencesListener = ({ requestId, manifest }) => {
      const pending = this.pendingPluginState;
      if (!pending || requestId !== this.pendingPluginStateRequestId) return;
      window.clearTimeout(pending.timeout);
      this.pendingPluginState = null;
      this.pendingPluginStateRequestId = null;
      if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.samples) || !manifest.patch) {
        pending.reject(new Error('Invalid referenced preset manifest.'));
      } else {
        pending.resolve({ referenceManifest: manifest });
      }
    };
    this.nativeSampleRestoreBuffers = new Map();
    this.nativeSampleRestoreListener = (details) => {
      if (details?.requestId !== this.pendingPluginStateRequestId) return;
      const { action, key } = details;
      if (typeof key !== 'string' || !key) return;

      if (action === 'begin') {
        const { sampleCount, sampleRate } = details;
        if (
          !Number.isSafeInteger(sampleCount) ||
          sampleCount <= 0 ||
          sampleCount > 0x7fffffff ||
          !Number.isFinite(sampleRate) ||
          sampleRate <= 0 ||
          sampleRate > 768000
        ) {
          console.error('[LayerForge] Native patch contains invalid sample metadata.');
          return;
        }
        try {
          this.nativeSampleRestoreBuffers.set(key, {
            sampleCount,
            sampleRate,
            samples: new Float32Array(sampleCount),
            received: 0
          });
        } catch (error) {
          console.error('[LayerForge] Could not allocate restored sample memory:', error);
        }
        return;
      }

      const transfer = this.nativeSampleRestoreBuffers.get(key);
      if (!transfer) return;

      if (action === 'chunk') {
        const { offset, samples } = details;
        if (
          offset !== transfer.received ||
          !Array.isArray(samples) ||
          offset + samples.length > transfer.sampleCount
        ) {
          this.nativeSampleRestoreBuffers.delete(key);
          console.error('[LayerForge] Native patch sample data is incomplete or out of order.');
          return;
        }

        for (let index = 0; index < samples.length; index += 1) {
          const value = samples[index];
          if (!Number.isFinite(value)) {
            this.nativeSampleRestoreBuffers.delete(key);
            console.error('[LayerForge] Native patch contains an invalid sample value.');
            return;
          }
          transfer.samples[offset + index] = value;
        }
        transfer.received += samples.length;
        return;
      }

      if (action === 'end') {
        if (
          details.offset !== transfer.sampleCount ||
          transfer.received !== transfer.sampleCount
        ) {
          this.nativeSampleRestoreBuffers.delete(key);
          console.error('[LayerForge] Native patch sample data ended before completion.');
          return;
        }
        this.vfsBuffers[key] = transfer.samples;
        this.vfsSampleRates[key] = transfer.sampleRate;
        this.nativeSampleRestoreBuffers.delete(key);
      }
    };
    this.nativePluginStateListener = ({ requestId, stateJson, revision }) => {
      if (requestId !== this.pendingPluginStateRequestId || !this.pendingPluginState) return;

      window.clearTimeout(this.pendingPluginState.timeout);
      const { resolve, reject } = this.pendingPluginState;
      this.pendingPluginState = null;
      this.pendingPluginStateRequestId = null;
      try {
        this.stateRevision = revision;
        this.parameterUpdates = {};
        const state = stateJson ? JSON.parse(stateJson) : null;
        const missingSample = state?.layers?.find(
          (layer) => layer.loaded && (
            !layer.sampleKey || !this.vfsBuffers[layer.sampleKey] ||
            (layer.sampleRightKey && (
              !this.vfsBuffers[layer.sampleRightKey] ||
              this.vfsBuffers[layer.sampleRightKey].length !== this.vfsBuffers[layer.sampleKey].length
            ))
          )
        );
        if (missingSample) {
          throw new Error(
            `Saved audio data for "${missingSample.sourceName || missingSample.name || 'a channel'}" is missing or incomplete.`
          );
        }
        resolve(state);
      } catch (error) {
        reject(new Error(`Could not restore the saved LayerForge patch: ${error.message}`));
      }
    };
    this.nativeMidiListener = (event) => {
      this.onNativeMidiTrigger?.(event.detail?.count ?? 1);
    };
    this.nativeMeterListener = (data) => this.onMeter?.(data);
    this.nativeParametersListener = (changes) => {
      if (this.suspendParameterUpdates) Object.assign(this.parameterUpdates, changes);
      else Object.entries(changes).forEach(([id, value]) => this.onParameterChange?.(id, value));
    };
    this.nativeStateRestoredListener = ({ revision }) => {
      this.suspendParameterUpdates = true;
      this.resumeOnRender = false;
      this.parameterUpdates = {};
      this.onStateRestored?.(revision);
    };
    this.nativeTraceListener = (data) => {
      if (this.traceEnabled && data.generation === this.traceGeneration) this.onTrace?.(data);
    };
  }

  async initialize({ onMidiTrigger, onNativeMidiTrigger, onParameterChange, onStateRestored, onMeter, onTrace }) {
    this.onMidiTrigger = onMidiTrigger;
    this.onNativeMidiTrigger = onNativeMidiTrigger;
    this.onParameterChange = onParameterChange;
    this.onStateRestored = onStateRestored;
    this.onMeter = onMeter;
    this.onTrace = onTrace;

    if (this.isNativePlugin) {
      window._postMessageToPluginBackend = (type, payload) => {
        let messagePayload = payload;
        if (type === 'updateVirtualFileSystem') {
          messagePayload = Object.fromEntries(
            Object.entries(payload).map(([key, data]) => [key, Array.from(data)])
          );
        } else if (type === 'sampleTransfer' && payload.samples) {
          messagePayload = { ...payload, samples: Array.from(payload.samples) };
        } else if (type === 'wavTransfer' && payload.bytes) {
          messagePayload = { ...payload, bytes: Array.from(payload.bytes) };
        }
        try {
          window.__JUCE__.backend.emitEvent('elemMessage', { type, payload: messagePayload });
        } catch (error) {
          console.error('[LayerForge] Could not send a message to the native host:', error);
          throw error;
        }
      };
      this.core = new ElementaryRenderer((batch) => {
        const remappedBatch = this.remapNativeInstructions(batch);
        window._postMessageToPluginBackend('renderInstructions', JSON.stringify(remappedBatch));
      });
      window.addEventListener('layerforge:midi', this.nativeMidiListener);
      window.__JUCE__.backend.addEventListener('layerforgeWavReady', this.nativeWavReadyListener);
      window.__JUCE__.backend.addEventListener(
        'layerforgeWavClipboardResult',
        this.nativeWavClipboardListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgeWavActionStatus',
        this.nativeWavActionStatusListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgePresetStatus',
        this.nativePresetStatusListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgePresetList',
        this.nativePresetListListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgePresetLoadFailed',
        this.nativePresetLoadFailureListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgePresetReferences',
        this.nativePresetReferencesListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgeSampleRestore',
        this.nativeSampleRestoreListener
      );
      window.__JUCE__.backend.addEventListener('layerforgeSampleFile', this.nativeSampleFileListener);
      window.__JUCE__.backend.addEventListener('layerforgeRevealSample', this.nativeRevealSampleListener);
      window.__JUCE__.backend.addEventListener(
        'layerforgePluginState',
        this.nativePluginStateListener
      );
      window.__JUCE__.backend.addEventListener('layerforgeOutputMeter', this.nativeMeterListener);
      window.__JUCE__.backend.addEventListener('layerforgeOutputTrace', this.nativeTraceListener);
      window.__JUCE__.backend.addEventListener('layerforgeParameters', this.nativeParametersListener);
      window.__JUCE__.backend.addEventListener('layerforgeStateRestored', this.nativeStateRestoredListener);
      this.restoredPluginState = await this.requestNativePluginState();
      this.pluginStateLoaded = true;
    } else {
      this.audioCtx = new AudioContext();
      this.core = new WebRenderer();
      const node = await this.core.initialize(this.audioCtx, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [18]
      });
      const workletUrl = URL.createObjectURL(new Blob([outputMonitorSource], { type: 'text/javascript' }));
      try {
        await this.audioCtx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      this.outputMonitor = new AudioWorkletNode(this.audioCtx, 'layerforge-output-monitor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 18,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
        outputChannelCount: [2]
      });
      this.outputMonitor.port.onmessage = ({ data }) => {
        if (data.type === 'meter') {
          this.onMeter?.({ min: 0, max: data.peak, effects: data.effects });
        } else if (data.type === 'trace') {
          try {
            if (this.traceEnabled && data.generation === this.traceGeneration) {
              const clock = Float64Array.from(data.buffers[0], (_, index) => data.startFrame + index);
              this.onTrace?.({
                data: [...data.buffers.slice(0, 3), clock, ...data.buffers.slice(3)],
                sampleRate: this.audioCtx.sampleRate
              });
            }
          } finally {
            this.outputMonitor.port.postMessage(
              { type: 'recycle', buffers: data.buffers },
              data.buffers.map((channel) => channel.buffer)
            );
          }
        }
      };
      node.connect(this.outputMonitor);
      this.outputMonitor.connect(this.audioCtx.destination);

      await this._setupWebMidi();
    }

    this.isInitialized = true;
    this.setTraceEnabled(this.traceEnabled);
    if (this.pendingRender) {
      const nodes = this.pendingRender;
      this.pendingRender = null;
      await this.core.render(...nodes);
    }
  }

  setTraceEnabled(enabled) {
    this.traceEnabled = enabled;
    this.traceGeneration += 1;
    if (this.isInitialized) {
      if (this.isNativePlugin) {
        window._postMessageToPluginBackend('traceActive', { enabled, generation: this.traceGeneration });
      } else {
        this.outputMonitor.port.postMessage({ type: 'trace', enabled, generation: this.traceGeneration });
      }
    }
  }

  async _setupWebMidi() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
      if (!this.onMidiTrigger) return;
      access.inputs.forEach((input) => {
        input.onmidimessage = (msg) => {
          const [status, , velocity] = msg.data;
          const cmd = status & 0xf0;
          if (cmd === 0x90 && velocity > 0 && this.onMidiTrigger) {
            this.onMidiTrigger(velocity / 127);
          }
        };
      });
    } catch (err) {
      console.warn('[LayerForge] Web MIDI unavailable:', err);
    }
  }

  auditionNative(velocity) {
    window._postMessageToPluginBackend('midiAudition', { velocity });
  }

  async ensureRunning() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  render(...nodes) {
    if (!this.core) return;
    if (!this.isInitialized) {
      this.pendingRender = nodes;
      return;
    }
    try {
      return this.core.render(...nodes);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async decodeSampleFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const decodeCtx = this.audioCtx || new OfflineAudioContext(1, 44100, 44100);
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);

    if (audioBuffer.numberOfChannels > 2) {
      throw new Error('Only mono and stereo audio files are supported.');
    }
    return audioBuffer;
  }

  async loadSampleFile(layerIdx, file) {
    const audioBuffer = await this.decodeSampleFile(file);

    const vfsKey = `layer_${layerIdx}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const rightKey = audioBuffer.numberOfChannels === 2 ? `${vfsKey}:right` : null;
    const resources = { [vfsKey]: audioBuffer.getChannelData(0) };
    if (rightKey) resources[rightKey] = audioBuffer.getChannelData(1);

    if (this.isNativePlugin) {
      const postMessage = window._postMessageToPluginBackend;
      if (typeof postMessage !== 'function') {
        throw new Error('Native sample bridge is unavailable.');
      }

      const chunkSize = 8192;
      for (const [key, samples] of Object.entries(resources)) {
        postMessage('sampleTransfer', {
          action: 'begin', key, sampleCount: samples.length, sampleRate: audioBuffer.sampleRate
        });
        for (let offset = 0; offset < samples.length; offset += chunkSize) {
          postMessage('sampleTransfer', {
            action: 'chunk', key, offset,
            samples: samples.subarray(offset, Math.min(offset + chunkSize, samples.length))
          });
        }
        postMessage('sampleTransfer', { action: 'end', key });
      }
    } else if (this.core?.updateVirtualFileSystem) {
      await this.core.updateVirtualFileSystem(resources);
    }

    for (const [key, samples] of Object.entries(resources)) {
      this.vfsBuffers[key] = samples;
      this.vfsSampleRates[key] = audioBuffer.sampleRate;
    }

    return {
      name: file.name.replace(/\.[^/.]+$/, ''),
      sourceName: file.name,
      sourceLocation:
        typeof file.path === 'string' && file.path
          ? file.path
          : file.webkitRelativePath || null,
      sampleKey: vfsKey,
      sampleRightKey: rightKey,
      durationSec: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      sampleCount: audioBuffer.length,
      ...getDefaultSampleTrim(resources[vfsKey], audioBuffer.sampleRate, rightKey ? resources[rightKey] : undefined)
    };
  }

  chooseNativeSample(locationOnly = false) {
    if (!this.isNativePlugin || typeof window._postMessageToPluginBackend !== 'function') {
      return Promise.reject(new Error('Native sample browser is unavailable.'));
    }
    if (this.pendingSampleFile) return Promise.reject(new Error('A sample browser is already open.'));
    const requestId = `sample-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      this.pendingSampleFile = { requestId, resolve, reject, locationOnly };
      try {
        window._postMessageToPluginBackend('chooseSample', { requestId, locationOnly });
      } catch (error) {
        this.pendingSampleFile = null;
        reject(error);
      }
    });
  }

  readNativeSample(path) {
    if (!this.isNativePlugin || typeof window._postMessageToPluginBackend !== 'function') {
      return Promise.reject(new Error('Native sample access is unavailable.'));
    }
    if (this.pendingSampleFile) return Promise.reject(new Error('A sample file request is already open.'));
    const requestId = `sample-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingSampleFile = null;
        reject(new Error('Timed out while reading the referenced sample.'));
      }, 60000);
      this.pendingSampleFile = {
        requestId,
        resolve: (file) => { window.clearTimeout(timeout); resolve(file); },
        reject: (error) => { window.clearTimeout(timeout); reject(error); }
      };
      try {
        window._postMessageToPluginBackend('readSampleFile', { requestId, path });
      } catch (error) {
        window.clearTimeout(timeout);
        this.pendingSampleFile = null;
        reject(error);
      }
    });
  }

  requestNativePluginState() {
    return this.requestNativeState('getPluginState');
  }

  requestNativeState(messageType, payload = {}) {
    if (this.pendingPluginState) {
      return Promise.reject(new Error('A patch restore is already in progress.'));
    }
    const requestId = `state_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.pendingPluginStateRequestId = requestId;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingPluginState = null;
        this.pendingPluginStateRequestId = null;
        reject(new Error('Timed out while restoring the saved LayerForge patch.'));
      }, 60000);
      this.pendingPluginState = { resolve, reject, timeout };

      try {
        window._postMessageToPluginBackend(messageType, { ...payload, requestId });
      } catch (error) {
        window.clearTimeout(timeout);
        this.pendingPluginState = null;
        this.pendingPluginStateRequestId = null;
        reject(error);
      }
    });
  }

  async listNativePresets() {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native preset browsing is unavailable.');
    }

    if (this.pendingPresetList) {
      window.clearTimeout(this.pendingPresetList.timeout);
      this.pendingPresetList.reject(new Error('Preset list request was replaced.'));
      this.pendingPresetList = null;
    }
    const requestId = `presets_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingPresetList = null;
        reject(new Error('Timed out while browsing saved presets.'));
      }, 15000);
      this.pendingPresetList = { requestId, resolve, reject, timeout };
      try {
        postMessage('presetList', { requestId });
      } catch (error) {
        window.clearTimeout(timeout);
        this.pendingPresetList = null;
        reject(error);
      }
    });
    return result;
  }

  async loadNativePreset(filename, canApply = () => true, confirmRelink) {
    if (!this.isNativePlugin || typeof window._postMessageToPluginBackend !== 'function') {
      throw new Error('Native preset loading is unavailable.');
    }
    const revision = this.stateRevision;
    const result = await this.requestNativeState('presetLoad', { filename, revision });
    if (!result?.referenceManifest) return result;

    const { patch, samples } = result.referenceManifest;
    const resolved = [];
    for (let index = 0; index < patch.layers.length; index += 1) {
      const layer = patch.layers[index];
      if (!layer.loaded) continue;
      const reference = samples.find((sample) => sample.key === layer.sampleKey);
      if (!reference || typeof reference.sourceLocation !== 'string' ||
          !/^[0-9a-f]{64}$/.test(reference.sha256 || '')) {
        throw new Error(`The sample reference for channel ${index + 1} is invalid.`);
      }
      let file = null;
      try {
        const candidate = await this.readNativeSample(reference.sourceLocation);
        if (candidate.sha256 === reference.sha256) file = candidate;
        else console.warn(`[LayerForge] Referenced sample for channel ${index + 1} has changed.`);
      } catch (error) {
        console.warn(`[LayerForge] Could not read the sample reference for channel ${index + 1}:`, error);
      }
      if (!file) {
        if (typeof confirmRelink !== 'function') {
          throw new Error('Sample relinking is unavailable.');
        }
        if (!await confirmRelink(`"${reference.sourceName || 'The original sample'}" for channel ${index + 1} is missing or changed. Locate the original file to load this preset.`)) {
          throw new Error('Sample relinking canceled; the preset was not loaded.');
        }
        file = await this.chooseNativeSample();
        if (!file) throw new Error('Sample relinking canceled; the preset was not loaded.');
        if (file.sha256 !== reference.sha256) {
          throw new Error(`The selected file does not match the original sample for channel ${index + 1}.`);
        }
      }
      const loaded = await this.loadSampleFile(index, file);
      if (loaded.sampleRate !== reference.sampleRate || loaded.sampleCount !== reference.sampleCount ||
          Boolean(loaded.sampleRightKey) !== Boolean(layer.sampleRightKey)) {
        throw new Error(`The referenced sample for channel ${index + 1} decoded differently.`);
      }
      resolved.push({
        layer: index, path: file.path, sampleKey: loaded.sampleKey,
        sampleRightKey: loaded.sampleRightKey
      });
    }
    if (revision !== this.stateRevision || !canApply()) {
      throw new Error('The patch changed while loading the preset. Try again.');
    }
    return this.requestNativeState('presetApplyReferences', { filename, revision, samples: resolved });
  }

  deleteNativePreset(filename) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native preset deletion is unavailable.');
    }
    postMessage('presetDelete', { filename });
  }

  saveNativePluginState(state) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native patch-state storage is unavailable.');
    }
    if (this.suspendParameterUpdates) {
      throw new Error('The host patch is still being restored.');
    }
    postMessage('pluginState', { stateJson: JSON.stringify(state), revision: this.stateRevision });
  }

  setHostParameter(id, value) {
    if (this.isNativePlugin && this.pluginStateLoaded && !this.suspendParameterUpdates)
      window._postMessageToPluginBackend('parameterChange', { id, value, revision: this.stateRevision });
  }

  resumeParameterUpdates() {
    this.suspendParameterUpdates = false;
    const updates = this.parameterUpdates;
    this.parameterUpdates = {};
    Object.entries(updates).forEach(([id, value]) => this.onParameterChange?.(id, value));
  }

  async prepareNativeWav(blob, filename) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native WAV export is unavailable.');
    }

    const key = `export_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ready = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingWavTransfers.delete(key);
        reject(new Error('Timed out while staging the WAV for export.'));
      }, 15000);
      this.pendingWavTransfers.set(key, { resolve, reject, timeout });
    });

    try {
      const chunkSize = 8192;
      postMessage('wavTransfer', {
        action: 'begin',
        key,
        filename,
        byteCount: bytes.length
      });
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        postMessage('wavTransfer', {
          action: 'chunk',
          key,
          offset,
          bytes: bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
        });
      }
      postMessage('wavTransfer', { action: 'end', key });
    } catch (error) {
      const pending = this.pendingWavTransfers.get(key);
      if (pending) window.clearTimeout(pending.timeout);
      this.pendingWavTransfers.delete(key);
      throw error;
    }

    return ready;
  }

  copyNativeWavToClipboard(key) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      return Promise.reject(new Error('Native WAV clipboard export is unavailable.'));
    }

    const requestId = `clipboard_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingClipboardWrites.delete(requestId);
        reject(new Error('Timed out while copying the WAV to the clipboard.'));
      }, 10000);
      this.pendingClipboardWrites.set(requestId, { resolve, reject, timeout });
    });

    try {
      postMessage('wavClipboard', { key, requestId });
    } catch (error) {
      const pending = this.pendingClipboardWrites.get(requestId);
      if (pending) window.clearTimeout(pending.timeout);
      this.pendingClipboardWrites.delete(requestId);
      return Promise.reject(error);
    }

    return result;
  }

  saveNativeWav(key) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native WAV saving is unavailable.');
    }
    postMessage('wavSaveAs', { key });
  }

  exportNativePreset(preset) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native preset export is unavailable.');
    }
    postMessage('presetExport', JSON.stringify(preset));
  }

}
