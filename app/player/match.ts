/**
 * Multi-replay playback: several replays of one beatmap, side by side.
 *
 * Built as N independent sessions rather than one renderer drawing N cursors. That is how
 * upstream does it too — its own source says so, `8 canvas slots for 2v2/4v4` — and the reason
 * is that `Renderer` is one instance per canvas per session all the way down: one skin merge, one
 * ruleset session, one judged result stream. Teaching it to draw a second player would mean
 * reworking the render pipeline and the judged paths that pipeline reads, which are the parts
 * already validated against danser and lazer. N sessions reuses all of that unchanged.
 *
 * What makes it affordable is `BeatmapAssets`: the first session decodes the `.osz` — audio,
 * background, hitsounds, storyboard images — and every later one is handed that same object, so
 * the archive is unzipped and parsed once no matter how many players there are.
 *
 * One session is audible and owns the clock; the rest read it through `player.setClockFn`, so
 * they cannot drift. There is no second audio timeline to keep in step, because there is only
 * ever one.
 */

import {
  createReplaySession,
  type BeatmapAssets, type CoreSession, type ReplayData, type SkinAssets,
} from '../../src/index.js';

/** One participant: who they are, what they played, and where they are drawn. */
export interface MatchSlot {
  /** Display name; falls back to the replay's own username when the caller has nothing better. */
  readonly name: string;
  readonly session: CoreSession;
  readonly canvas: HTMLCanvasElement;
  /** Team, for team_versus rooms. Null in head-to-head and for solo comparisons. */
  readonly team: 'red' | 'blue' | null;
  /** True for the slot whose audio is playing. Exactly one slot has this. */
  readonly audible: boolean;
}

export interface MatchInputs {
  /** `.osz` bytes, decoded once and shared. */
  readonly beatmapSet: ArrayBuffer;
  readonly audioContext: AudioContext;
  readonly skin: SkinAssets;
  readonly lazerDefaultsUrl?: string;
  /** One entry per participant, in the order they should be laid out. */
  readonly players: readonly {
    readonly name: string;
    readonly replay: ReplayData;
    readonly canvas: HTMLCanvasElement;
    readonly team?: 'red' | 'blue' | null;
  }[];
  /**
   * Which player's audio to use. Defaults to the first. A specific index matters when only one
   * replay covers the whole map — an early-quit replay would end the shared clock early.
   */
  readonly audibleIndex?: number;
  readonly log?: (message: string) => void;
}

export interface MatchHandle {
  readonly slots: readonly MatchSlot[];
  /** The slot driving audio and the clock. */
  readonly audible: MatchSlot;
  /**
   * How long the match runs: the longest replay in it. See {@link matchDurationMs} for why it is
   * not the audible slot's own length.
   */
  readonly durationMs: number;
  /** Starts every renderer and the shared audio at `presMs`. */
  play(presMs: number): Promise<void>;
  pause(): void;
  /** Moves the shared clock; every slot follows. */
  seek(presMs: number): Promise<void>;
  /** Per-player figures at the current moment, for a live scoreboard. */
  standings(): readonly MatchStanding[];
  /** Destroys every session. Shared assets are released once, not per slot. */
  destroy(): void;
}

export interface MatchStanding {
  readonly name: string;
  readonly team: 'red' | 'blue' | null;
  readonly score: number;
  readonly combo: number;
  readonly maxCombo: number;
  /** 0–1. */
  readonly accuracy: number;
  /** Rank within the standings as returned, 1-based. */
  readonly position: number;
}

/**
 * How long a match runs: the longest replay in it.
 *
 * Not the audible slot's own length, which is what this used to take. That slot only owns the
 * audio; its replay is no more authoritative than anyone else's, and a player who quit early has a
 * short one. Reading the duration off it ended the match while the others were still playing —
 * and because the audio is the song rather than the replay, it kept going while every renderer sat
 * clamped at its last frame, which reads as a hang rather than as an ending.
 *
 * A match is over when its last replay is.
 */
export function matchDurationMs(presentationDurations: readonly number[]): number {
  return presentationDurations.reduce((longest, ms) => Math.max(longest, ms), 0);
}

/**
 * Builds every session, sharing one decode.
 *
 * Sessions are built in sequence rather than with `Promise.all`: the first produces the
 * `BeatmapAssets` the rest reuse, and running them concurrently would have each unzip the archive
 * itself — the exact cost this exists to avoid.
 */
export async function createMatch(inputs: MatchInputs): Promise<MatchHandle> {
  const { players, audioContext, skin, beatmapSet } = inputs;
  if (players.length === 0) throw new Error('a match needs at least one player');

  const audibleIndex = inputs.audibleIndex ?? 0;
  if (audibleIndex < 0 || audibleIndex >= players.length) {
    throw new Error(`audibleIndex ${audibleIndex} is outside 0..${players.length - 1}`);
  }
  const log = inputs.log ?? ((): void => {});

  const slots: MatchSlot[] = [];
  let shared: BeatmapAssets | null = null;

  const disposePartiallyBuiltMatch = (): void => {
    for (const slot of slots) {
      try {
        slot.session.destroy();
      } catch (cleanupError) {
        log(`failed to clean up ${slot.name}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
    // CoreSession.destroy deliberately leaves shared beatmap assets owned by this builder.
    shared?.background?.close();
  };

  try {
    for (const [index, player] of players.entries()) {
      log(`building ${player.name} (${index + 1}/${players.length})…`);
      const session = await createReplaySession({
        canvas: player.canvas,
        audioContext,
        replay: player.replay,
        // First pass decodes; the rest are handed the result.
        beatmapSet: shared ?? beatmapSet,
        skin,
        ...(inputs.lazerDefaultsUrl !== undefined
          ? { lazerDefaultsUrl: inputs.lazerDefaultsUrl }
          : {}),
      });
      shared ??= session.assets;
      slots.push({
        name: player.name !== '' ? player.name : player.replay.username,
        session,
        canvas: player.canvas,
        team: player.team ?? null,
        audible: index === audibleIndex,
      });
    }
  } catch (error) {
    disposePartiallyBuiltMatch();
    throw error;
  }

  const audible = slots[audibleIndex]!;
  const clock = audible.session.audioSync.clockFn;
  // Every slot reads the audible slot's audio clock, including that slot itself, so there is one
  // time source rather than one per session.
  for (const slot of slots) slot.session.player.setClockFn(clock);

  // Silent slots still own an AudioSync — createReplaySession always makes one — so their gains
  // are zeroed. Never calling playFrom would also keep them quiet, but a stray seek that did call
  // it would then play a second copy of the song over the first.
  for (const slot of slots) {
    if (slot.audible) continue;
    slot.session.audioSync.setSongVolume(0);
    slot.session.audioSync.setEffectsVolume(0);
  }

  const durationMs = matchDurationMs(
    slots.map(slot => slot.session.timeMapper.presentationDurationMs),
  );

  return {
    slots,
    audible,
    durationMs,

    async play(presMs: number): Promise<void> {
      for (const slot of slots) slot.session.renderer.start();
      await audible.session.audioSync.playFrom(presMs);
      for (const slot of slots) {
        slot.session.player.seek(presMs);
        slot.session.player.play();
      }
    },

    pause(): void {
      audible.session.audioSync.pause();
      for (const slot of slots) slot.session.player.pause();
    },

    async seek(presMs: number): Promise<void> {
      const clamped = Math.max(0, Math.min(durationMs, presMs));
      await audible.session.audioSync.seekTo(clamped);
      // Each player is seeked too: the clock function alone moves the *reading*, but a Player
      // holds its own position for the paused case, so leaving them behind shows stale frames.
      for (const slot of slots) slot.session.player.seek(clamped);
    },

    standings(): readonly MatchStanding[] {
      const rows = slots.map(slot => {
        const { renderer } = slot.session;
        const score = renderer.currentScore();
        // The HUD timelines are the same ones the canvas draws from, so a scoreboard built on
        // them cannot disagree with what is on screen.
        const mapTimeMs = timeOf(slot);
        return {
          name: slot.name,
          team: slot.team,
          score,
          combo: comboAt(slot, mapTimeMs),
          maxCombo: maxComboUpTo(slot, mapTimeMs),
          accuracy: accAt(slot, mapTimeMs),
          position: 0,
        };
      });
      // Sorted by score, which is what a scoreboard means by position. Ties keep input order.
      const ordered = [...rows].sort((a, b) => b.score - a.score);
      return ordered.map((row, index) => ({ ...row, position: index + 1 }));
    },

    destroy(): void {
      for (const slot of slots) slot.session.destroy();
      // Every slot was handed the *same* BeatmapAssets, and CoreSession.destroy deliberately does
      // not release it — so the one GPU resource in there is closed once here. Closing it per slot
      // would double-close a bitmap that N renderers had been drawing.
      //
      // storyboardImages is left alone: it holds undecoded bytes, and each renderer's own
      // storyboard assets (the decoded bitmaps) were released by its session's destroy().
      shared?.background?.close();
    },
  };
}

/** Beatmap time a slot is currently drawing, matching `Renderer.currentScore`'s own maths. */
function timeOf(slot: MatchSlot): number {
  const { renderer, timeMapper, player } = slot.session;
  return timeMapper.toMapTime(player.currentTimeMs)
    + renderer.options.audioOffsetMs * timeMapper.speed
    - renderer.oldOffsetMs;
}

/** Last value at or before `t` in a time-sorted array. */
function sampleAt<T extends { time: number }>(frames: readonly T[], t: number): T | null {
  if (frames.length === 0 || t < frames[0]!.time) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.time <= t) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo]!;
}

function comboAt(slot: MatchSlot, t: number): number {
  return sampleAt(slot.session.renderer.comboFrames, t)?.combo ?? 0;
}

function accAt(slot: MatchSlot, t: number): number {
  // Before the first judged object there is no accuracy yet; osu! shows 100%, not 0%.
  return sampleAt(slot.session.renderer.accFrames, t)?.acc ?? 1;
}

/**
 * Highest combo reached up to `t`.
 *
 * Walks rather than binary-searches: the running maximum is not monotonic in the frame array's
 * *values*, only in its index, so there is nothing to bisect on. Combo frames number in the
 * thousands and this runs once per slot per UI refresh, which is cheap enough — a cached
 * prefix maximum would be the fix if a scoreboard ever refreshed per animation frame.
 */
function maxComboUpTo(slot: MatchSlot, t: number): number {
  let best = 0;
  for (const frame of slot.session.renderer.comboFrames) {
    if (frame.time > t) break;
    if (frame.combo > best) best = frame.combo;
  }
  return best;
}
