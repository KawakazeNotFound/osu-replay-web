import type { ReplayData } from '../../types/index';

/** A single key edge decoded from the replay: a press or release of one column at `time` ms. */
export interface ManiaInputEvent {
  time: number;
  column: number;
  kind: 'press' | 'release';
}

/**
 * Decode each .osr frame's MouseX as a column bitmask:
 * LSB = column 0, bit i = column i. Only bits 0..totalColumns-1 are honoured —
 * stable's first replay frame encodes its cursor-X marker (`256` = bit 8) in
 * MouseX, which would otherwise leak as a spurious column-8 press. ppy/osu's
 * LegacyReplayDecoder applies the same `i < TotalColumns` clip.
 *
 * cumTime accumulates negative deltas (lazer encodes audio lead-in as a
 * negative first delta; dropping it shifts the whole timeline forward past
 * every hit window). Output events are emitted in frame order; once spurious
 * bits are masked off, the event stream is monotonic in time.
 */
export function maniaFrames(replay: ReplayData, totalColumns: number): ManiaInputEvent[] {
  const events: ManiaInputEvent[] = [];
  if (totalColumns <= 0) return events;
  const columnMask = totalColumns >= 32 ? -1 >>> 0 : (1 << totalColumns) - 1;
  let cumTime = 0;
  let prevMask = 0;
  for (const frame of replay.frames) {
    cumTime += frame.timeDelta;
    const curMask = (frame.x | 0) & columnMask;
    const presses  = curMask & ~prevMask;
    const releases = ~curMask & prevMask;
    if (presses !== 0 || releases !== 0) {
      for (let col = 0; col < totalColumns; col++) {
        const bit = 1 << col;
        if (presses  & bit) events.push({ time: cumTime, column: col, kind: 'press'   });
        if (releases & bit) events.push({ time: cumTime, column: col, kind: 'release' });
      }
    }
    prevMask = curMask;
  }
  return events;
}
