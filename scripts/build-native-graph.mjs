import { build } from 'vite';
import { writeFile } from 'node:fs/promises';
import { PARAMETER_SCHEMA } from '../dsp/parameters.js';

await build({
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    emptyOutDir: false,
    outDir: 'native/build/generated',
    lib: {
      entry: 'src/audio/nativeGraph.js',
      name: 'LayerForgeNativeGraph',
      formats: ['iife'],
      fileName: () => 'native-graph.js'
    }
  }
});

const entries = PARAMETER_SCHEMA.map(({ id, name, min, max, default: value, unit }) =>
  `    { ${JSON.stringify(id)}, ${JSON.stringify(name)}, ${min}, ${max}, ${value}, ${JSON.stringify(unit)} },`
).join('\n');
await writeFile('native/build/generated/HostParameters.h', `#pragma once
struct HostParameterSpec { const char* id; const char* name; float min, max, initial; const char* unit; };
static constexpr HostParameterSpec hostParameterSpecs[] = {
${entries}
};
`);
