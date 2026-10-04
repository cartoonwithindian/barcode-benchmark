/**
 * Ambient globals for a Node runtime.
 *
 * The engine adapters talk to WebAssembly modules and to browser-shaped values
 * (a Quagga2 `HTMLImageElement` source, a canvas). Pulling in `lib.dom.d.ts`
 * would shadow Node's own `fetch`/`Blob`/`AbortController` types and hide real
 * mistakes, so the few names actually referenced are declared here instead.
 *
 * `WebAssembly` is genuinely present in Node 22+, so it is declared as a
 * namespace with the compile entry point only; nothing here fabricates a value
 * at runtime.
 */

declare namespace WebAssembly {
  interface Module {}
  interface Instance {
    exports: Record<string, unknown>;
  }
  interface Memory {}
  function compile(bytes: BufferSource): Promise<Module>;
  function instantiate(bytes: BufferSource): Promise<{ module: Module; instance: Instance }>;
  function instantiate(bytes: BufferSource, imports?: Record<string, unknown>): Promise<{ module: Module; instance: Instance }>;
}

/** Structurally typed only; Quagga2 receives an `ImageData`-like object. */
interface HTMLImageElement {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

declare module 'zbar.wasm/dist/instance.js' {
  interface ZbarSymbolSet {
    symbols: Array<{
      type: string;
      data: string;
      position: number;
      rotation: number;
      quality: number;
      numLines?: number;
    }>;
  }
  interface ZbarModule {
    scanRGBABuffer(buffer: ArrayBuffer, width: number, height: number): Promise<ZbarSymbolSet>;
    scanGrayBuffer(buffer: ArrayBuffer, width: number, height: number): Promise<ZbarSymbolSet>;
    getDefaultScanner(): Promise<unknown>;
  }
  export function getInstance(): Promise<ZbarModule>;
}