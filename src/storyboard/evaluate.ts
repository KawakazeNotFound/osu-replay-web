/**
 * Turns parsed storyboard commands into a concrete sprite state at a given time.
 *
 * Two stages, because the shapes wanted for storage and for per-frame sampling differ:
 *
 *  1. `compileDrawable` flattens a drawable's command tree into one sorted timeline per
 *     animatable property, in absolute milliseconds, with `L` loops expanded. Done once
 *     per drawable and cached by the caller — a storyboard with 577 sprites should not pay
 *     this for sprites that never come on screen, so compile lazily.
 *  2. `evaluateSprite` samples those timelines. Hot path: called for every visible sprite
 *     every frame, so it allocates nothing beyond the returned state.
 *
 * Sampling follows osu!'s rules: before a property's first command the first start value
 * holds, after the last command the last end value holds, and in a gap between commands the
 * previous end value holds.
 */

import {
  type SbCommand, type SbDrawable, type SbParam, type SbTweenCommand,
} from './types.js';

// ---- easing ---------------------------------------------------------------------------

// Constants lifted from osu!framework's Easing implementation so the exotic curves match
// rather than merely looking similar.
const ELASTIC_CONST = (2 * Math.PI) / 0.3;
const ELASTIC_CONST2 = 0.3 / 4;
const BACK_CONST = 1.70158;
const BACK_CONST2 = BACK_CONST * 1.525;
const BOUNCE_CONST = 1 / 2.75;

function outBounce(t: number): number {
  if (t < BOUNCE_CONST) return 7.5625 * t * t;
  if (t < 2 * BOUNCE_CONST) {
    const s = t - 1.5 * BOUNCE_CONST;
    return 7.5625 * s * s + 0.75;
  }
  if (t < 2.5 * BOUNCE_CONST) {
    const s = t - 2.25 * BOUNCE_CONST;
    return 7.5625 * s * s + 0.9375;
  }
  const s = t - 2.625 * BOUNCE_CONST;
  return 7.5625 * s * s + 0.984375;
}

function inBounce(t: number): number {
  return 1 - outBounce(1 - t);
}

/**
 * Maps a linear 0–1 progress through an osu! easing id. Ids follow osu!framework's `Easing`
 * enum; 1 (`Out`) and 2 (`In`) are the legacy aliases for the quadratic curves, and both are
 * common in real storyboards. Unknown ids fall through to linear rather than throwing.
 */
export function applyEasing(easing: number, p: number): number {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  switch (easing) {
    case 0: return t;                                             // None (linear)
    case 1: case 4: return t * (2 - t);                           // Out / OutQuad
    case 2: case 3: return t * t;                                 // In / InQuad
    case 5: return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case 6: return t * t * t;
    case 7: return 1 - (1 - t) ** 3;
    case 8: return t < 0.5 ? 4 * t ** 3 : 1 - 4 * (1 - t) ** 3;
    case 9: return t ** 4;
    case 10: return 1 - (1 - t) ** 4;
    case 11: return t < 0.5 ? 8 * t ** 4 : 1 - 8 * (1 - t) ** 4;
    case 12: return t ** 5;
    case 13: return 1 - (1 - t) ** 5;
    case 14: return t < 0.5 ? 16 * t ** 5 : 1 - 16 * (1 - t) ** 5;
    case 15: return 1 - Math.cos(t * Math.PI * 0.5);
    case 16: return Math.sin(t * Math.PI * 0.5);
    case 17: return 0.5 * (1 - Math.cos(Math.PI * t));
    case 18: return t === 0 ? 0 : 2 ** (10 * (t - 1));
    case 19: return t === 1 ? 1 : 1 - 2 ** (-10 * t);
    case 20:
      if (t === 0 || t === 1) return t;
      return t < 0.5 ? 0.5 * 2 ** (20 * t - 10) : 1 - 0.5 * 2 ** (-20 * t + 10);
    case 21: return 1 - Math.sqrt(1 - t * t);
    case 22: return Math.sqrt(1 - (t - 1) * (t - 1));
    case 23:
      return t < 0.5
        ? 0.5 * (1 - Math.sqrt(1 - 4 * t * t))
        : 0.5 * (Math.sqrt(1 - (2 * t - 2) ** 2) + 1);
    case 24: {                                                    // InElastic
      if (t === 0 || t === 1) return t;
      const s = t - 1;
      return -(2 ** (10 * s)) * Math.sin((s - ELASTIC_CONST2) * ELASTIC_CONST);
    }
    case 25:                                                      // OutElastic
      if (t === 0 || t === 1) return t;
      return 2 ** (-10 * t) * Math.sin((t - ELASTIC_CONST2) * ELASTIC_CONST) + 1;
    case 26:                                                      // OutElasticHalf
      if (t === 0 || t === 1) return t;
      return 2 ** (-10 * t) * Math.sin((0.5 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1;
    case 27:                                                      // OutElasticQuarter
      if (t === 0 || t === 1) return t;
      return 2 ** (-10 * t) * Math.sin((0.25 * t - ELASTIC_CONST2) * ELASTIC_CONST) + 1;
    case 28: {                                                    // InOutElastic
      if (t === 0 || t === 1) return t;
      const s = 2 * t - 1;
      return s < 0
        ? -0.5 * 2 ** (10 * s) * Math.sin((s - ELASTIC_CONST2) * ELASTIC_CONST)
        : 0.5 * 2 ** (-10 * s) * Math.sin((s - ELASTIC_CONST2) * ELASTIC_CONST) + 1;
    }
    case 29: return t * t * ((BACK_CONST + 1) * t - BACK_CONST);  // InBack
    case 30: {                                                    // OutBack
      const s = t - 1;
      return s * s * ((BACK_CONST + 1) * s + BACK_CONST) + 1;
    }
    case 31: {                                                    // InOutBack
      const s = t * 2;
      if (s < 1) return 0.5 * s * s * ((BACK_CONST2 + 1) * s - BACK_CONST2);
      const u = s - 2;
      return 0.5 * (u * u * ((BACK_CONST2 + 1) * u + BACK_CONST2) + 2);
    }
    case 32: return inBounce(t);
    case 33: return outBounce(t);
    case 34: return t < 0.5 ? 0.5 * inBounce(2 * t) : 0.5 * outBounce(2 * t - 1) + 0.5;
    default: return t;
  }
}

// ---- compiled form -------------------------------------------------------------------

/** One tween on one property's timeline, in absolute milliseconds. */
interface Seg {
  readonly startTime: number;
  readonly endTime: number;
  readonly easing: number;
  /** Component values; length matches the track's arity. */
  readonly start: readonly number[];
  readonly end: readonly number[];
}

interface ParamSpan {
  readonly param: SbParam;
  readonly startTime: number;
  readonly endTime: number;
  /**
   * osu!: a parameter command with no duration applies for the rest of the sprite's life,
   * rather than for an instant. Both forms are common (`P,0,0,1700,H` vs `P,0,10005,,A`).
   */
  readonly untilEnd: boolean;
}

export interface CompiledDrawable {
  readonly source: SbDrawable;
  /** Absolute ms; drawables are not drawn outside this. */
  readonly startTime: number;
  readonly endTime: number;
  readonly alpha: readonly Seg[];
  readonly x: readonly Seg[];
  readonly y: readonly Seg[];
  readonly scale: readonly Seg[];
  readonly rotation: readonly Seg[];
  readonly colour: readonly Seg[];
  readonly params: readonly ParamSpan[];
  /** Trigger commands found but not fired — see `compileDrawable`. */
  readonly skippedTriggers: number;
  /** Set when the loop-expansion budget was hit and repetitions were dropped. */
  readonly truncated: boolean;
}

export interface SbSpriteState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  /** Radians. */
  rotation: number;
  /** 0–255 each. */
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  alpha: number;
  flipH: boolean;
  flipV: boolean;
  additive: boolean;
  /** 0 for plain sprites. */
  frameIndex: number;
}

/**
 * Cap on segments produced per drawable by loop expansion. Real storyboards are nowhere
 * near it — the three surveyed expand to 670 segments in total across all their loops — but
 * a hand-written `L` with a six-figure count would otherwise allocate without bound.
 */
const SEGMENT_BUDGET = 20_000;

/** Relative end of a loop body, used as its period. */
function bodyDuration(commands: readonly SbCommand[]): number {
  let end = 0;
  for (const c of commands) {
    switch (c.kind) {
      case 'tween':
      case 'param':
      case 'trigger':
        end = Math.max(end, c.endTime);
        break;
      case 'loop':
        end = Math.max(end, c.startTime + bodyDuration(c.commands) * c.loopCount);
        break;
    }
  }
  return end;
}

interface Tracks {
  alpha: Seg[];
  x: Seg[];
  y: Seg[];
  scale: Seg[];
  rotation: Seg[];
  colour: Seg[];
  params: ParamSpan[];
}

/** Splits one tween command onto the property tracks it writes. */
function pushTween(tracks: Tracks, c: SbTweenCommand, offset: number): void {
  const seg = (start: readonly number[], end: readonly number[]): Seg => ({
    startTime: c.startTime + offset,
    endTime: c.endTime + offset,
    easing: c.easing,
    start,
    end,
  });
  switch (c.type) {
    case 'F': tracks.alpha.push(seg(c.start, c.end)); break;
    case 'R': tracks.rotation.push(seg(c.start, c.end)); break;
    case 'C': tracks.colour.push(seg(c.start, c.end)); break;
    // S is uniform, V is per-axis, but both write the same scale vector — keep them on one
    // track so whichever command is current wins, as osu! does.
    case 'S': tracks.scale.push(seg([c.start[0]!, c.start[0]!], [c.end[0]!, c.end[0]!])); break;
    case 'V': tracks.scale.push(seg(c.start, c.end)); break;
    // M writes both axes; MX/MY write one. Separate tracks keep that faithful when the
    // forms are interleaved.
    case 'M':
      tracks.x.push(seg([c.start[0]!], [c.end[0]!]));
      tracks.y.push(seg([c.start[1]!], [c.end[1]!]));
      break;
    case 'MX': tracks.x.push(seg(c.start, c.end)); break;
    case 'MY': tracks.y.push(seg(c.start, c.end)); break;
  }
}

interface CollectState {
  segments: number;
  triggers: number;
  truncated: boolean;
}

function collect(
  tracks: Tracks,
  commands: readonly SbCommand[],
  offset: number,
  state: CollectState,
  depth: number,
): void {
  for (const c of commands) {
    if (state.segments >= SEGMENT_BUDGET) {
      state.truncated = true;
      return;
    }
    switch (c.kind) {
      case 'tween':
        pushTween(tracks, c, offset);
        state.segments++;
        break;
      case 'param':
        tracks.params.push({
          param: c.param,
          startTime: c.startTime + offset,
          endTime: c.endTime + offset,
          untilEnd: c.endTime <= c.startTime,
        });
        state.segments++;
        break;
      case 'trigger':
        // Trigger bodies fire on gameplay events (HitSound*, Passing, Failing). Nothing
        // feeds those in yet, so the body is skipped and counted rather than mis-fired.
        state.triggers++;
        break;
      case 'loop': {
        // The format does not nest loops; the depth guard is only there so a malformed
        // file cannot recurse without end.
        if (depth > 4) break;
        const period = bodyDuration(c.commands);
        const base = offset + c.startTime;
        if (period <= 0) {
          // A zero-length body would repeat in place; play it once.
          collect(tracks, c.commands, base, state, depth + 1);
          break;
        }
        for (let i = 0; i < c.loopCount; i++) {
          if (state.segments >= SEGMENT_BUDGET) {
            state.truncated = true;
            return;
          }
          collect(tracks, c.commands, base + period * i, state, depth + 1);
        }
        break;
      }
    }
  }
}

function byStart(a: Seg, b: Seg): number {
  return a.startTime - b.startTime || a.endTime - b.endTime;
}

/**
 * Flattens a drawable's commands into per-property timelines. Cache the result: it is
 * independent of time, and recomputing it per frame would dominate the render cost.
 */
export function compileDrawable(drawable: SbDrawable): CompiledDrawable {
  const tracks: Tracks = { alpha: [], x: [], y: [], scale: [], rotation: [], colour: [], params: [] };
  const state: CollectState = { segments: 0, triggers: 0, truncated: false };
  collect(tracks, drawable.commands, 0, state, 0);

  tracks.alpha.sort(byStart);
  tracks.x.sort(byStart);
  tracks.y.sort(byStart);
  tracks.scale.sort(byStart);
  tracks.rotation.sort(byStart);
  tracks.colour.sort(byStart);

  // Recompute the span from the flattened segments: the parser's span is command-tree based
  // and a truncated expansion would otherwise claim a longer life than it has.
  let startTime = Infinity;
  let endTime = -Infinity;
  for (const track of [tracks.alpha, tracks.x, tracks.y, tracks.scale, tracks.rotation, tracks.colour]) {
    for (const seg of track) {
      startTime = Math.min(startTime, seg.startTime);
      endTime = Math.max(endTime, seg.endTime);
    }
  }
  for (const p of tracks.params) {
    startTime = Math.min(startTime, p.startTime);
    endTime = Math.max(endTime, p.endTime);
  }

  return {
    source: drawable,
    startTime,
    endTime,
    alpha: tracks.alpha,
    x: tracks.x,
    y: tracks.y,
    scale: tracks.scale,
    rotation: tracks.rotation,
    colour: tracks.colour,
    params: tracks.params,
    skippedTriggers: state.triggers,
    truncated: state.truncated,
  };
}

/**
 * Samples one track at `t` into `out`. Before the first segment the first start value holds;
 * after the last, its end value; in a gap, the previous end value.
 *
 * Overlapping segments resolve to the latest one that has started, which matches osu!
 * applying commands in order and letting the most recent win.
 */
function sampleTrack(track: readonly Seg[], t: number, out: number[], arity: number): boolean {
  if (track.length === 0) return false;

  const first = track[0]!;
  if (t <= first.startTime) {
    for (let i = 0; i < arity; i++) out[i] = first.start[i] ?? 0;
    return true;
  }

  // Linear scan backwards from the end: sprites are sampled in increasing time and tracks
  // are short (tens of segments), so this beats a binary search's bookkeeping in practice.
  let active: Seg | null = null;
  for (let i = track.length - 1; i >= 0; i--) {
    if (track[i]!.startTime <= t) { active = track[i]!; break; }
  }
  if (active === null) {
    for (let i = 0; i < arity; i++) out[i] = first.start[i] ?? 0;
    return true;
  }

  if (t >= active.endTime) {
    for (let i = 0; i < arity; i++) out[i] = active.end[i] ?? 0;
    return true;
  }

  const span = active.endTime - active.startTime;
  const p = span <= 0 ? 1 : applyEasing(active.easing, (t - active.startTime) / span);
  for (let i = 0; i < arity; i++) {
    const a = active.start[i] ?? 0;
    const b = active.end[i] ?? 0;
    out[i] = a + (b - a) * p;
  }
  return true;
}

const scratch1 = [0];
const scratch2 = [0, 0];
const scratch3 = [0, 0, 0];

/** Which animation frame is showing at `t`, given the animation starts at its first command. */
export function animationFrame(
  compiled: CompiledDrawable,
  t: number,
): number {
  const d = compiled.source;
  if (d.kind !== 'animation' || d.frameCount <= 1) return 0;
  if (d.frameDelay <= 0) return 0;
  const elapsed = t - compiled.startTime;
  if (elapsed <= 0) return 0;
  const raw = Math.floor(elapsed / d.frameDelay);
  if (d.loopType === 'LoopOnce') return Math.min(raw, d.frameCount - 1);
  return ((raw % d.frameCount) + d.frameCount) % d.frameCount;
}

/**
 * Sprite state at `timeMs`, or `null` when the drawable is not live then (outside its span,
 * or fully transparent) so the renderer can skip it without allocating.
 *
 * `out` is written in place and returned; pass a reused object to keep the frame loop free
 * of garbage.
 */
export function evaluateSprite(
  compiled: CompiledDrawable,
  timeMs: number,
  out: SbSpriteState,
): SbSpriteState | null {
  if (!(timeMs >= compiled.startTime && timeMs <= compiled.endTime)) return null;

  // No F command at all means "visible for its whole life" — only an explicit fade can
  // make a sprite transparent.
  if (sampleTrack(compiled.alpha, timeMs, scratch1, 1)) out.alpha = scratch1[0]!;
  else out.alpha = 1;
  if (out.alpha <= 0) return null;
  if (out.alpha > 1) out.alpha = 1;

  const d = compiled.source;
  out.x = sampleTrack(compiled.x, timeMs, scratch1, 1) ? scratch1[0]! : d.x;
  out.y = sampleTrack(compiled.y, timeMs, scratch1, 1) ? scratch1[0]! : d.y;

  if (sampleTrack(compiled.scale, timeMs, scratch2, 2)) {
    out.scaleX = scratch2[0]!;
    out.scaleY = scratch2[1]!;
  } else {
    out.scaleX = 1;
    out.scaleY = 1;
  }

  out.rotation = sampleTrack(compiled.rotation, timeMs, scratch1, 1) ? scratch1[0]! : 0;

  if (sampleTrack(compiled.colour, timeMs, scratch3, 3)) {
    out.r = scratch3[0]!;
    out.g = scratch3[1]!;
    out.b = scratch3[2]!;
  } else {
    out.r = 255;
    out.g = 255;
    out.b = 255;
  }

  out.flipH = false;
  out.flipV = false;
  out.additive = false;
  for (const p of compiled.params) {
    const active = p.untilEnd
      ? timeMs >= p.startTime
      : timeMs >= p.startTime && timeMs <= p.endTime;
    if (!active) continue;
    if (p.param === 'H') out.flipH = true;
    else if (p.param === 'V') out.flipV = true;
    else out.additive = true;
  }

  out.frameIndex = animationFrame(compiled, timeMs);
  return out;
}

/** A zeroed state object to reuse across frames. */
export function createSpriteState(): SbSpriteState {
  return {
    x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0,
    r: 255, g: 255, b: 255, alpha: 1,
    flipH: false, flipV: false, additive: false, frameIndex: 0,
  };
}
