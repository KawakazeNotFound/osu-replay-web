// Hand-written declaration for the direct lzma_worker import (the lzma package ships
// no types, and its package root pulls in Node's 'path' — see ReplayParser.ts).
declare module 'lzma/src/lzma_worker.js' {
  export const LZMA: {
    decompress: (
      data: Uint8Array,
      cb: (result: number[] | string, error: Error | null) => void,
    ) => void;
  };
}
