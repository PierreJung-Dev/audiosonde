/**
 * essentia.js 0.1.x ships no `types` entry in its package.json, so TypeScript
 * cannot resolve its bundled d.ts under NodeNext resolution. The engine only
 * needs the constructor pair below; the precise algorithm surface is typed in
 * src/media/essentia.ts.
 */
declare module 'essentia.js' {
  const pkg: {
    Essentia: new (wasm: unknown) => unknown;
    EssentiaWASM: unknown;
  };
  export default pkg;
}
