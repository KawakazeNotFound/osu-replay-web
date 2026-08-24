/**
 * Storyboard data model — the parsed shape of a `.osb` file (or a `.osu`'s `[Events]`
 * section), before any timeline evaluation or rendering.
 *
 * Deliberately faithful to the file format rather than convenient for drawing: loops and
 * triggers stay nested with their child times relative to the loop start, exactly as the
 * file states them. Flattening is not done here because trigger bodies fire on runtime hit
 * events (so they cannot be resolved ahead of time), and a long `L` with a high loop count
 * would explode into tens of thousands of commands. `evaluate` resolves both lazily.
 */

/** Draw order, low to high. `Fail`/`Pass` are shown depending on whether the play is alive. */
export const enum SbLayer {
  Background = 0,
  Fail = 1,
  Pass = 2,
  Foreground = 3,
  Overlay = 4,
}

/**
 * Anchor point within the sprite's own bounds that `x`/`y` and rotation refer to.
 * `Custom` is an alias osu! treats as `TopLeft`.
 */
export const enum SbOrigin {
  TopLeft = 0,
  Centre = 1,
  CentreLeft = 2,
  TopRight = 3,
  BottomCentre = 4,
  TopCentre = 5,
  Custom = 6,
  CentreRight = 7,
  BottomLeft = 8,
  BottomRight = 9,
}

/** How an `Animation` behaves once its frames run out. */
export type SbAnimationLoop = 'LoopForever' | 'LoopOnce';

/**
 * Commands that interpolate numeric values over time. `values` holds the tween endpoints
 * flattened: `[...start, ...end]`, each half `arity` long (see COMMAND_ARITY).
 */
export type SbTweenType = 'F' | 'S' | 'R' | 'MX' | 'MY' | 'M' | 'V' | 'C';

/** Numbers of tweened components per command type. */
export const COMMAND_ARITY: Readonly<Record<SbTweenType, number>> = {
  F: 1,   // opacity
  S: 1,   // uniform scale
  R: 1,   // rotation, radians
  MX: 1,  // x only
  MY: 1,  // y only
  M: 2,   // x, y
  V: 2,   // scale x, scale y
  C: 3,   // r, g, b (0–255)
};

export interface SbTweenCommand {
  readonly kind: 'tween';
  readonly type: SbTweenType;
  /** Raw osu! easing id; 0 is linear. Curves are applied at evaluation time. */
  readonly easing: number;
  readonly startTime: number;
  readonly endTime: number;
  readonly start: readonly number[];
  readonly end: readonly number[];
}

/** `P` — a flag that is on for the command's span rather than a value that tweens. */
export type SbParam = 'H' | 'V' | 'A';

export interface SbParamCommand {
  readonly kind: 'param';
  readonly easing: number;
  readonly startTime: number;
  readonly endTime: number;
  /** H = flip horizontally, V = flip vertically, A = additive blending. */
  readonly param: SbParam;
}

/** `L` — child times are relative to `startTime`, repeated `loopCount` times. */
export interface SbLoopCommand {
  readonly kind: 'loop';
  readonly startTime: number;
  readonly loopCount: number;
  readonly commands: readonly SbCommand[];
}

/**
 * `T` — child times are relative to the trigger firing, which depends on gameplay
 * (`HitSound*` variants, `Passing`, `Failing`). Kept for fidelity; whether the renderer
 * acts on it is a separate decision.
 */
export interface SbTriggerCommand {
  readonly kind: 'trigger';
  readonly trigger: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly group: number;
  readonly commands: readonly SbCommand[];
}

export type SbCommand = SbTweenCommand | SbParamCommand | SbLoopCommand | SbTriggerCommand;

interface SbDrawableBase {
  readonly layer: SbLayer;
  readonly origin: SbOrigin;
  /**
   * Path exactly as written in the file, which uses Windows separators (`sb\scene1\x.png`).
   * Use `lookupPath` to find the bytes in a `.osz`, whose entries use forward slashes.
   */
  readonly path: string;
  /** `path` with separators normalised to `/` and lowercased, for archive lookup. */
  readonly lookupPath: string;
  readonly x: number;
  readonly y: number;
  readonly commands: readonly SbCommand[];
  /** Earliest command start, absolute ms. `Infinity` when the sprite has no commands. */
  readonly startTime: number;
  /** Latest command end, absolute ms, loops expanded. `-Infinity` when there are none. */
  readonly endTime: number;
}

export interface SbSprite extends SbDrawableBase {
  readonly kind: 'sprite';
}

export interface SbAnimation extends SbDrawableBase {
  readonly kind: 'animation';
  readonly frameCount: number;
  /** Milliseconds per frame. */
  readonly frameDelay: number;
  readonly loopType: SbAnimationLoop;
  /**
   * Per-frame paths derived from `path` by inserting the frame index before the extension
   * (`walk1_.png` → `walk1_0.png`, `walk1_1.png`, …), normalised like `lookupPath`.
   */
  readonly framePaths: readonly string[];
}

export type SbDrawable = SbSprite | SbAnimation;

/** `Sample` — a one-shot audio hit on the storyboard timeline. */
export interface SbSample {
  readonly time: number;
  readonly layer: SbLayer;
  readonly path: string;
  readonly lookupPath: string;
  /** 0–100 as written; absent in the file means 100. */
  readonly volume: number;
}

export interface Storyboard {
  readonly drawables: readonly SbDrawable[];
  readonly samples: readonly SbSample[];
  /** Background filename from the `0,0,"bg.jpg"` event, `null` when absent. */
  readonly backgroundPath: string | null;
  /** Video filename from the `1,…` / `Video,…` event, `null` when absent. */
  readonly videoPath: string | null;
  /** `true` when any drawable or sample was found — i.e. there is something to draw. */
  readonly hasContent: boolean;
  /**
   * Lines the parser could not make sense of, with 1-based line numbers. Non-fatal: a
   * malformed command is skipped rather than failing the whole storyboard, but surfacing
   * them keeps format gaps visible instead of silently dropping visuals.
   */
  readonly warnings: readonly string[];
}
