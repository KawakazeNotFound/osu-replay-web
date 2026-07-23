import type { ReplayData } from '../../types/index';

/** One of the four taiko keys. Matches TaikoAction enum order in osu.Game.Rulesets.Taiko/TaikoAction.cs. */
export type TaikoAction = 'LeftRim' | 'LeftCentre' | 'RightCentre' | 'RightRim';

/** A single key press (rising edge only) at `time` ms on the beatmap clock. */
export interface TaikoInputEvent {
  time: number;
  action: TaikoAction;
}

// Stable .osr bitfield: bit 0=LeftCentre, 1=LeftRim, 2=RightCentre, 3=RightRim.
const BIT_TO_ACTION: ReadonlyArray<{ bit: number; action: TaikoAction }> = [
  { bit: 1, action: 'LeftCentre'  },
  { bit: 2, action: 'LeftRim'     },
  { bit: 4, action: 'RightCentre' },
  { bit: 8, action: 'RightRim'    },
];

/**
 * Extract rising-edge key presses from a taiko replay's raw frames, sorted by
 * time. Accumulates timeDelta including negatives — lazer encodes audio lead-in
 * as the first frame's negative delta, and dropping it shifts the whole timeline
 * forward past every hit window.
 */
export function taikoFrames(replay: ReplayData): TaikoInputEvent[] {
  const events: TaikoInputEvent[] = [];
  let cumTime = 0;
  let prevKeys = 0;
  for (const frame of replay.frames) {
    cumTime += frame.timeDelta;
    const curKeys = frame.keys & 0b1111;
    const newPresses = curKeys & ~prevKeys;
    if (newPresses !== 0) {
      for (const { bit, action } of BIT_TO_ACTION) {
        if (newPresses & bit) events.push({ time: cumTime, action });
      }
    }
    prevKeys = curKeys;
  }
  return events;
}
