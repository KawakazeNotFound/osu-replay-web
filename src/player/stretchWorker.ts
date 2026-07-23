// Module-worker entry for the DT/HT time-stretch. Runs the same WSOLA core as the main
// thread (TimeStretch.timeStretchChannels) so the output is identical; being off-thread
// avoids the multi-second main-thread freeze of the synchronous stretch. The bundler must
// build this file as its own module-worker entry and register its URL in the worker
// manifest (see workers.ts). Spawned per stretch and terminated by the client
// (stretchClient.ts) — one request, one reply.

import { timeStretchChannels } from './TimeStretch.js';

interface StretchRequest {
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  tempo: number;
}

type StretchResponse =
  | { L: Float32Array; R: Float32Array }
  | { error: string };

// tsconfig lib is dom (not webworker); type the dedicated-worker surface we use explicitly.
declare const self: {
  onmessage: ((e: MessageEvent<StretchRequest>) => void) | null;
  postMessage(message: StretchResponse, transfer?: Transferable[]): void;
};

self.onmessage = (e: MessageEvent<StretchRequest>): void => {
  try {
    const { L, R, sampleRate, tempo } = e.data;
    const out = timeStretchChannels(L, R, sampleRate, tempo);
    const transfer = out.L.buffer === out.R.buffer ? [out.L.buffer] : [out.L.buffer, out.R.buffer];
    self.postMessage({ L: out.L, R: out.R }, transfer);
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
