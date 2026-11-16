/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */
const TRACE_CHUNK_SIZE = 2048;
const TRACE_CHANNEL_COUNT = 13;

class LayerForgeOutputMonitor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.traceEnabled = false;
    this.generation = 0;
    this.pool = Array.from({ length: 4 }, () =>
      Array.from({ length: TRACE_CHANNEL_COUNT }, () => new Float32Array(TRACE_CHUNK_SIZE))
    );
    this.buffer = null;
    this.count = 0;
    this.peak = 0;
    this.meterFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'trace') {
        this.traceEnabled = data.enabled;
        this.generation = data.generation;
        if (this.buffer) this.pool.push(this.buffer);
        this.buffer = null;
        this.count = 0;
      } else if (data.type === 'recycle') {
        this.pool.push(data.buffers);
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    if (!output.length) return true;
    const length = output[0].length;
    for (let index = 0; index < length; index += 1) {
      const left = input[0]?.[index] ?? 0;
      const right = input[1]?.[index] ?? left;
      output[0][index] = left;
      if (output[1]) output[1][index] = right;
      this.peak = Math.max(this.peak, Math.abs(left), Math.abs(right));

      if (this.traceEnabled) {
        if (!this.buffer && this.pool.length) {
          this.buffer = this.pool.pop();
          this.startFrame = currentFrame + index;
        }
        if (this.buffer) {
          this.buffer[0][this.count] = left;
          this.buffer[1][this.count] = right;
          for (let channel = 2; channel < TRACE_CHANNEL_COUNT; channel += 1) {
            this.buffer[channel][this.count] = input[channel]?.[index] ?? 0;
          }
          this.count += 1;
          if (this.count === TRACE_CHUNK_SIZE) {
            this.port.postMessage({
              type: 'trace',
              generation: this.generation,
              startFrame: this.startFrame,
              buffers: this.buffer
            }, this.buffer.map((channel) => channel.buffer));
            this.buffer = null;
            this.count = 0;
          }
        }
      }
    }
    this.meterFrames += length;
    if (this.meterFrames >= sampleRate / 60) {
      this.port.postMessage({ type: 'meter', peak: this.peak });
      this.peak = 0;
      this.meterFrames = 0;
    }
    return true;
  }
}

registerProcessor('layerforge-output-monitor', LayerForgeOutputMonitor);
