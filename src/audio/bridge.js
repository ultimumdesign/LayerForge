import { Renderer as ElementaryRenderer } from '@elemaudio/core';
import WebRenderer from '@elemaudio/web-renderer';

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
    this.onParameterChange = null;
    this.isInitialized = false;
    this.pluginStateLoaded = !this.isNativePlugin;
    this.restoredPluginState = null;
    this.pendingPluginState = null;
    this.pendingPluginStateRequestId = null;
    this.pendingRender = null;
    this.remapNativeInstructions = createNativeInstructionRemapper();
    this.pendingWavTransfers = new Map();
    this.pendingClipboardWrites = new Map();
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
    this.nativePluginStateListener = ({ requestId, stateJson }) => {
      if (requestId !== this.pendingPluginStateRequestId || !this.pendingPluginState) return;

      window.clearTimeout(this.pendingPluginState.timeout);
      const { resolve, reject } = this.pendingPluginState;
      this.pendingPluginState = null;
      this.pendingPluginStateRequestId = null;
      try {
        const state = stateJson ? JSON.parse(stateJson) : null;
        const missingSample = state?.layers?.find(
          (layer) => layer.loaded && (!layer.sampleKey || !this.vfsBuffers[layer.sampleKey])
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
      if (this.onMidiTrigger) {
        this.onMidiTrigger((event.detail?.velocity ?? 127) / 127);
      }
    };
  }

  async initialize({ onMidiTrigger, onParameterChange }) {
    this.onMidiTrigger = onMidiTrigger;
    this.onParameterChange = onParameterChange;

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
        'layerforgeSampleRestore',
        this.nativeSampleRestoreListener
      );
      window.__JUCE__.backend.addEventListener(
        'layerforgePluginState',
        this.nativePluginStateListener
      );
      this.restoredPluginState = await this.requestNativePluginState();
      this.pluginStateLoaded = true;
    } else {
      this.audioCtx = new AudioContext();
      this.core = new WebRenderer();
      const node = await this.core.initialize(this.audioCtx, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      node.connect(this.audioCtx.destination);

      await this._setupWebMidi();
    }

    this.isInitialized = true;
    if (this.pendingRender) {
      const [leftNode, rightNode] = this.pendingRender;
      this.pendingRender = null;
      await this.core.render(leftNode, rightNode);
    }
  }

  async _setupWebMidi() {
    if (!navigator.requestMIDIAccess) return;
    try {
      const access = await navigator.requestMIDIAccess();
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

  async ensureRunning() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  render(leftNode, rightNode) {
    if (!this.core) return;
    if (!this.isInitialized) {
      this.pendingRender = [leftNode, rightNode];
      return;
    }
    try {
      return this.core.render(leftNode, rightNode);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async loadSampleFile(layerIdx, file) {
    const arrayBuffer = await file.arrayBuffer();
    const decodeCtx = this.audioCtx || new OfflineAudioContext(1, 44100, 44100);
    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);

    // Mono sum if stereo so sample playback stays phase-coherent
    let monoData;
    if (audioBuffer.numberOfChannels > 1) {
      const ch0 = audioBuffer.getChannelData(0);
      const ch1 = audioBuffer.getChannelData(1);
      monoData = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        monoData[i] = 0.5 * (ch0[i] + ch1[i]);
      }
    } else {
      monoData = audioBuffer.getChannelData(0);
    }

    const vfsKey = `layer_${layerIdx}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (this.isNativePlugin) {
      const postMessage = window._postMessageToPluginBackend;
      if (typeof postMessage !== 'function') {
        throw new Error('Native sample bridge is unavailable.');
      }

      const chunkSize = 8192;
      postMessage('sampleTransfer', {
        action: 'begin',
        key: vfsKey,
        sampleCount: monoData.length,
        sampleRate: audioBuffer.sampleRate
      });
      for (let offset = 0; offset < monoData.length; offset += chunkSize) {
        postMessage('sampleTransfer', {
          action: 'chunk',
          key: vfsKey,
          offset,
          samples: monoData.subarray(offset, Math.min(offset + chunkSize, monoData.length))
        });
      }
      postMessage('sampleTransfer', { action: 'end', key: vfsKey });
    } else if (this.core?.updateVirtualFileSystem) {
      await this.core.updateVirtualFileSystem({ [vfsKey]: monoData });
    }

    this.vfsBuffers[vfsKey] = monoData;
    this.vfsSampleRates[vfsKey] = audioBuffer.sampleRate;

    return {
      name: file.name.replace(/\.[^/.]+$/, ''),
      sourceName: file.name,
      sourceLocation:
        typeof file.path === 'string' && file.path
          ? file.path
          : file.webkitRelativePath || null,
      sampleKey: vfsKey,
      durationSec: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      sampleCount: monoData.length
    };
  }

  requestNativePluginState() {
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
        window._postMessageToPluginBackend('getPluginState', { requestId });
      } catch (error) {
        window.clearTimeout(timeout);
        this.pendingPluginState = null;
        this.pendingPluginStateRequestId = null;
        reject(error);
      }
    });
  }

  saveNativePluginState(state) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native patch-state storage is unavailable.');
    }
    postMessage('pluginState', JSON.stringify(state));
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

  setNativeWavDragTarget(key, bounds = {}, enabled = true) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') return;

    postMessage('wavDragTarget', { key, enabled, ...bounds });
  }

  saveNativeWav(key) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native WAV saving is unavailable.');
    }
    postMessage('wavSaveAs', { key });
  }

  exportNativePreset(state) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native preset export is unavailable.');
    }
    postMessage('presetExport', JSON.stringify(state));
  }

  revealNativeWav(key) {
    const postMessage = window._postMessageToPluginBackend;
    if (!this.isNativePlugin || typeof postMessage !== 'function') {
      throw new Error('Native WAV file access is unavailable.');
    }

    postMessage('wavReveal', { key });
  }
}
