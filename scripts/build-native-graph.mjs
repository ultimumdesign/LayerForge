import { build } from 'vite';

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
