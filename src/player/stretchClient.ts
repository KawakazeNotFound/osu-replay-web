// Client side of the DT/HT stretch worker: runs TimeStretch's WSOLA core in a module worker
// (off the main thread) and falls back to the synchronous in-thread stretch when workers are
// unavailable or the worker errors. The worker is spawned per stretch and terminated when it
// resolves — a stretch is a one-shot, seconds-long job and holding the worker (plus
// SoundTouch's buffers) between uses would just pin memory.

import { timeStretch } from './TimeStretch.js';
import { spawnWorker, workerAvailable } from './workers.js';

/** True when the stretch will run off-thread (no synchronous main-thread freeze). */
export function stretchWorkerAvailable(): boolean {
  return workerAvailable('stretch');
}

/**
 * Pitch-preserved stretch of `input` by `tempo` (>1 = faster/DT, <1 = slower/HT), off the
 * main thread where possible. Resolves with a new stereo AudioBuffer allocated via `ctx`
 * (same contract as the sync `timeStretch`). Any worker failure — spawn, runtime error,
 * malformed reply — falls back to the synchronous stretch so the caller always gets a result.
 */
export async function stretchAudioBuffer(
  input: AudioBuffer, tempo: number, ctx: BaseAudioContext,
): Promise<AudioBuffer> {
  if (tempo === 1) return input;

  const worker = spawnWorker('stretch');
  if (worker === null) return timeStretch(input, tempo, ctx);

  const L = input.getChannelData(0);
  const R = input.numberOfChannels > 1 ? input.getChannelData(1) : L;

  try {
    const out = await new Promise<{ L: Float32Array; R: Float32Array }>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ L?: Float32Array; R?: Float32Array; error?: string }>) => {
        const d = e.data;
        if (d.L instanceof Float32Array && d.R instanceof Float32Array) resolve({ L: d.L, R: d.R });
        else reject(new Error(d.error ?? 'stretch worker returned no data'));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'stretch worker error'));
      // No transfer list: getChannelData views the live AudioBuffer's storage — clone, don't
      // detach it (the session's song buffer must stay usable for live playback).
      worker.postMessage({ L, R, sampleRate: input.sampleRate, tempo });
    });
    const buf = ctx.createBuffer(2, out.L.length, input.sampleRate);
    buf.getChannelData(0).set(out.L);
    buf.getChannelData(1).set(out.R);
    return buf;
  } catch {
    // Worker path failed → the synchronous fallback still produces a result (a main-thread
    // freeze without a message in the worst case — rare enough not to plumb messaging for).
    return timeStretch(input, tempo, ctx);
  } finally {
    worker.terminate();
  }
}
