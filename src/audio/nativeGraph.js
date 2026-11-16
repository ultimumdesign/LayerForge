import { Renderer } from '@elemaudio/core';
import { buildDrumGraph } from '../../dsp/engine.js';
import { restorePatchState } from '../../dsp/parameters.js';

globalThis.buildLayerForgeGraph = (patch, sampleLengths) => {
  const buffers = Object.fromEntries(
    Object.entries(sampleLengths).map(([key, length]) => [key, { length }])
  );
  const state = restorePatchState(patch, buffers);
  let instructions;
  const renderer = new Renderer((batch) => {
    instructions = batch;
  });
  renderer.render(...buildDrumGraph(state, true, true));

  const ids = new Map();
  const mapId = (id) => {
    if (!ids.has(id)) ids.set(id, -1 - ids.size);
    return ids.get(id);
  };
  return JSON.stringify(instructions.map((instruction) => {
    const mapped = [...instruction];
    if ([0, 1, 3].includes(mapped[0])) mapped[1] = mapId(mapped[1]);
    if (mapped[0] === 2) {
      mapped[1] = mapId(mapped[1]);
      mapped[2] = mapId(mapped[2]);
    }
    if (mapped[0] === 4) mapped[1] = mapped[1].map(mapId);
    return mapped;
  }));
};
