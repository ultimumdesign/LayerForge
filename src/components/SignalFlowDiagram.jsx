import React, { useState } from 'react';

const EFFECTS = {
  ringMod: {
    label: 'RING MOD',
    detail: 'Sine carriers multiply the bus; phase, bias, rectification and stereo spread shape them before dry/wet and output gain.'
  },
  convolve: {
    label: 'CONVOLUTION',
    detail: 'Built-in stereo impulse response, predelay and filtering blend with the dry bus, followed by module output gain.'
  },
  saturation: {
    label: 'SATURATION',
    detail: 'The selected saturation curve processes the bus; its wet/dry mix and module output gain set the result.'
  },
  glue: {
    label: 'GLUE COMPRESSOR',
    detail: 'Stereo-linked compression shapes the bus dynamics, then blends with the dry bus and applies module output gain.'
  }
};

function FlowNode({ id, label, status, detail, selected, onSelect, color, children }) {
  return (
    <button type="button" className={`signal-flow-node${selected ? ' is-selected' : ''}`}
      style={color ? { '--flow-node-color': color } : undefined}
      data-flow-status={status}
      aria-pressed={selected} onClick={() => onSelect(id)}
      data-dsp-label={label} data-dsp-help={detail}>
      <span className="signal-flow-node-heading"><strong>{label}</strong><span>{status}</span></span>
      <span className="signal-flow-node-summary">{children}</span>
    </button>
  );
}

export function SignalFlowDiagram({ layers, noise, master, theme }) {
  const [selectedId, setSelectedId] = useState('sum');
  const anySolo = layers.some((layer) => layer.solo) || (noise.enabled && noise.solo);
  const noiseStatus = !noise.enabled ? 'OFF'
    : noise.mute ? 'MUTED'
      : anySolo && !noise.solo ? 'SOLO EXCLUDED'
        : noise.gain <= 0.0005 ? 'MIX ZERO' : 'ROUTED';
  const nodes = [
    ...layers.map((layer, index) => ({
      id: `channel-${index}`,
      label: `CH 0${index + 1}`,
      status: !layer.loaded ? 'EMPTY' : layer.mute ? 'MUTED'
        : anySolo && !layer.solo ? 'SOLO EXCLUDED' : 'ROUTED',
      summary: 'SAMPLE → SHAPE → MIX',
      color: theme.channelColors[index] || theme.accent,
      detail: 'Sample playback uses trim, pitch and phase alignment. Clip gain and envelope precede delay, filters, transient shaping, channel clipping, stereo width and mix.'
    })),
    {
      id: 'sum', label: 'CHANNEL SUM', status: 'STEREO BUS', summary: 'CHANNELS + VELOCITY',
      detail: 'The processed channel outputs are summed in stereo and scaled by hit velocity before entering the ordered bus. Noise joins later at its selected position.'
    },
    {
      id: 'noise', label: 'NOISE SYNTH', status: noiseStatus, summary: 'NOISE → FILTER → ENVELOPE → CLIP',
      color: theme.accentTertiary,
      detail: 'The selected noise is filtered, shaped by decay, trim and envelope, clipped and mixed. At its insertion point, it is scaled by hit velocity and added to both bus sides.'
    },
    {
      id: 'noise-add', label: 'NOISE INSERT', status: noiseStatus, summary: '+ NOISE INTO BUS',
      detail: 'Noise is added here, not at the start of the chain. Only effects after this point process the noise; the channel bus continues through this point.'
    },
    ...Object.entries(EFFECTS).map(([id, effect]) => ({
      id, ...effect,
      status: !master[`${id}Enabled`] ? 'OFF' : master[`${id}Mute`] ? 'MUTED' : 'ACTIVE',
      summary: 'BUS PROCESSING'
    })),
    {
      id: 'clipper', label: 'MASTER CLIPPER', status: 'OUTPUT STAGE', summary: 'DRIVE → SOFT / HARD',
      detail: 'The master clipper processes the ordered bus after all signal-chain modules.'
    },
    {
      id: 'ceiling', label: 'CEILING', status: 'OUTPUT STAGE', summary: 'POST-CLIP SCALE',
      detail: 'Ceiling scales the clipped signal. It is not a limiter after the output control.'
    },
    {
      id: 'output', label: 'OUTPUT', status: 'FINAL STEREO', summary: 'OUTPUT GAIN → HOST / WAV',
      detail: 'Output gain follows the ceiling. Boosting it can exceed 0 dBFS; this final stereo signal feeds playback, the output meter and WAV export.'
    }
  ];
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const selected = byId[selectedId];
  const node = (id) => {
    const item = byId[id];
    return <FlowNode key={id} {...item} selected={selectedId === id} onSelect={setSelectedId}>{item.summary}</FlowNode>;
  };

  return (
    <div className="signal-flow" aria-label="Signal flow diagram">
      <div className="signal-flow-intro">
        <div><strong>FROM SOURCES TO OUTPUT</strong><span>SELECT A STAGE TO EXPLORE</span></div>
        <span>ROUTING VIEW · NOT A LIVE METER</span>
      </div>
      <div className="signal-flow-map-viewport">
        <div className="signal-flow-map">
          <div className="signal-flow-sources" aria-label="Sample channels into the channel sum">
            {layers.map((_, index) => node(`channel-${index}`))}
            {node('sum')}
          </div>
          <div className="signal-flow-section-label">↓ ORDERED BUS · LEFT TO RIGHT →</div>
          <div className="signal-flow-bus" aria-label="Ordered bus modules">
            {master.busOrder.map((id) => (
              <div className="signal-flow-step" key={id}>
                {id === 'noise' ? (
                  <div className="signal-flow-noise">
                    {node('noise')}
                    <span className="signal-flow-branch" aria-hidden="true">↓</span>
                    {node('noise-add')}
                  </div>
                ) : node(id)}
              </div>
            ))}
          </div>
          <div className="signal-flow-section-label">↓ OUTPUT STAGE · LEFT TO RIGHT →</div>
          <div className="signal-flow-output" aria-label="Output stage">
            {['clipper', 'ceiling', 'output'].map((id) => (
              <div className="signal-flow-step" key={id}>{node(id)}</div>
            ))}
          </div>
        </div>
      </div>
      <aside className="signal-flow-detail" aria-live="polite" tabIndex={0}>
        <div><span>SELECTED STAGE · {selected.status}</span><strong>{selected.label}</strong></div>
        <p>{selected.detail}</p>
      </aside>
    </div>
  );
}
