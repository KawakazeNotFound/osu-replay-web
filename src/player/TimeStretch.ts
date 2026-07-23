// Pitch-preserved tempo time-stretch of an AudioBuffer, used for DT/HT playback and offline
// rendering. Uses SoundTouch's WSOLA Stretch stage (@soundtouchjs/core) — the same algorithm
// family BASS_FX (osu! stable/lazer) and Firefox's `preservesPitch` use, so the output carries
// the in-game DT/HT sound character rather than an approximation. NC is NOT stretched (it
// pitch-shifts via playbackRate); only non-NC speed changes route through here.
//
// Measured behaviour: output ≈ input.length/tempo frames at the correct constant rate; start
// latency ~3 ms (sub-frame); the residual ~90 ms deficit is a FIXED WSOLA tail drop (song
// fade-out), NOT accumulating drift — it stays constant as input length grows, so A/V sync
// holds over a full map.
//
// The core (`timeStretchChannels`) is pure over Float32Array channel data — no AudioBuffer,
// no DOM — so the stretch worker (stretchWorker.ts) can run the identical code off the main
// thread; `timeStretch` is the synchronous AudioBuffer wrapper (the no-Worker fallback).

import { Stretch } from '@soundtouchjs/core';

/** Planar stereo output of `timeStretchChannels`: left/right channel data at the input sample rate. */
export interface StretchedChannels {
  L: Float32Array;
  R: Float32Array;
}

/**
 * Time-stretch planar stereo channel data by `tempo` (>1 shortens = DT, <1 lengthens = HT),
 * preserving pitch. Pass the same array as `L` and `R` for mono (fanned out to stereo —
 * SoundTouch's WSOLA is stereo-interleaved). Pure computation; safe in a Worker.
 */
export function timeStretchChannels(
  L: Float32Array, R: Float32Array, sampleRate: number, tempo: number,
): StretchedChannels {
  const inFrames = L.length;

  const st = new Stretch({ createBuffers: true });
  // Sample rate + auto sequence/seek/overlap windows (mirrors SoundTouch's own init); then tempo.
  st.setParameters(sampleRate, 0, 0, 0);
  st.tempo = tempo;

  const inBuf = st.inputBuffer;
  const outBuf = st.outputBuffer;
  if (inBuf === null || outBuf === null) {
    throw new Error('SoundTouch Stretch did not allocate its input/output buffers');
  }

  const CHUNK = 8192;
  const interleaved = new Float32Array(CHUNK * 2);
  const scratch = new Float32Array(CHUNK * 2 * 8);
  const outChunks: Float32Array[] = [];
  let outFrames = 0;

  const drain = (): void => {
    let avail = outBuf.frameCount;
    while (avail > 0) {
      const take = Math.min(avail, scratch.length / 2);
      outBuf.extract(scratch, 0, take);
      outBuf.receive(take);
      outChunks.push(scratch.slice(0, take * 2));
      outFrames += take;
      avail = outBuf.frameCount;
    }
  };

  let pos = 0;
  while (pos < inFrames) {
    const n = Math.min(CHUNK, inFrames - pos);
    for (let i = 0; i < n; i++) {
      interleaved[i * 2] = L[pos + i]!;
      interleaved[i * 2 + 1] = R[pos + i]!;
    }
    inBuf.putSamples(interleaved, 0, n);
    pos += n;
    st.process();         // drains all full WSOLA windows currently buffered
    drain();
  }
  drain();                // final partial output (tail < one window is dropped — fixed ~90ms)

  const frames = Math.max(1, outFrames);
  const oL = new Float32Array(frames);
  const oR = new Float32Array(frames);
  let w = 0;
  for (const c of outChunks) {
    const n = c.length / 2;
    for (let i = 0; i < n; i++) {
      oL[w] = c[i * 2]!;
      oR[w] = c[i * 2 + 1]!;
      w++;
    }
  }
  return { L: oL, R: oR };
}

/**
 * Time-stretch `input` by `tempo`, preserving pitch. Returns a new stereo AudioBuffer at the
 * input's sample rate, allocated via `ctx` (any BaseAudioContext — e.g. the export's
 * OfflineAudioContext). `tempo === 1` returns the input unchanged. SYNCHRONOUS (a main-thread
 * freeze for long inputs) — prefer stretchClient.ts's worker path where available.
 */
export function timeStretch(input: AudioBuffer, tempo: number, ctx: BaseAudioContext): AudioBuffer {
  if (tempo === 1) return input;
  const L = input.getChannelData(0);
  const R = input.numberOfChannels > 1 ? input.getChannelData(1) : L;
  const out = timeStretchChannels(L, R, input.sampleRate, tempo);
  const buf = ctx.createBuffer(2, out.L.length, input.sampleRate);
  buf.getChannelData(0).set(out.L);
  buf.getChannelData(1).set(out.R);
  return buf;
}
