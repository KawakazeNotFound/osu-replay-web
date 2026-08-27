/**
 * Draws storyboard sprites onto the gameplay canvas.
 *
 * Coordinate space: storyboards are authored in a 640×480 virtual screen whose vertical
 * extent always fills the view, so the scale is `LOGICAL_H / 480` and x is measured outward
 * from the centre (x = 320). A 4:3 storyboard therefore occupies a 960-wide box centred in
 * our 1280-wide logical space and is clipped to it, matching osu!'s pillarboxing; a
 * widescreen one is authored for 854×480 and spans essentially the whole width.
 *
 * Layer order follows osu!: Background, Fail, Pass and Foreground sit under the playfield,
 * Overlay sits above it. The caller therefore draws in two passes, before and after
 * gameplay, rather than in one.
 */

import { SbLayer } from '../storyboard/types.js';
import { normalisePath } from '../storyboard/parse.js';
import {
  createSpriteState, evaluateSprite,
  type CompiledDrawable, type SbSpriteState,
} from '../storyboard/evaluate.js';
import type { StoryboardAssets } from '../storyboard/assets.js';

/** Storyboard authoring space. */
const SB_HEIGHT = 480;
const SB_CENTRE_X = 320;
const SB_WIDTH_4_3 = 640;
const SB_WIDTH_WIDE = 854;

export interface StoryboardView {
  /** Logical canvas size the storyboard is mapped into. */
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  /** From the beatmap's `WidescreenStoryboard` flag. */
  readonly widescreen: boolean;
}

export interface StoryboardDrawOptions {
  /**
   * Matches the background dim so the storyboard darkens with it — otherwise a dimmed
   * background sits behind sprites at full brightness and the playfield looks washed out.
   */
  readonly dim: number;
  /**
   * How far ahead to warm textures, in milliseconds of storyboard time. Sprites entering
   * within this window are queued for decode so they are ready when they appear.
   */
  readonly prefetchMs: number;
}

/**
 * Pre-sorted, pre-compiled storyboard ready to draw. Build once per session with
 * `prepareStoryboard`; compiling on the fly would redo loop expansion every frame.
 */
export interface PreparedStoryboard {
  /** Layers below the playfield, already in draw order. */
  readonly under: readonly CompiledDrawable[];
  /** The Overlay layer, drawn above the playfield. */
  readonly over: readonly CompiledDrawable[];
  readonly assets: StoryboardAssets;
  readonly view: StoryboardView;
  /** Earliest and latest activity, for callers that want to know the storyboard's extent. */
  readonly startTime: number;
  readonly endTime: number;
  /**
   * True when the storyboard draws the beatmap's *own* background image itself, as a sprite on
   * its Background layer. osu! then hides the static background instead of stacking the two —
   * the storyboard is animating that image, and a second undimmed copy underneath would show
   * through wherever the sprite is moved, scaled or faded.
   *
   * Narrow on purpose: this is a match on the path, not on the layer merely being occupied.
   * Nearly every storyboard puts decoration on the Background layer, so the looser test hides
   * the beatmap background for almost every storyboarded map and leaves black behind it.
   */
  readonly replacesBackground: boolean;
}

/**
 * Splits compiled drawables into the two passes and drops ones that can never draw (no
 * commands at all — real storyboards contain these).
 *
 * Input order matters and is preserved within each layer: osu! draws same-layer sprites in
 * declaration order, and `parseStoryboard` already puts the `.osb`'s before the `.osu`'s.
 *
 * `backgroundPath` is the beatmap's own background filename (`Storyboard.backgroundPath`) and
 * only decides {@link PreparedStoryboard.replacesBackground}; omit it to keep the static
 * background always drawn.
 */
export function prepareStoryboard(
  compiled: readonly CompiledDrawable[],
  assets: StoryboardAssets,
  view: StoryboardView,
  backgroundPath: string | null = null,
): PreparedStoryboard {
  const live = compiled.filter(c => Number.isFinite(c.startTime) && Number.isFinite(c.endTime));

  // A stable sort by layer keeps declaration order inside each layer.
  const under = live
    .filter(c => c.source.layer !== SbLayer.Overlay)
    .sort((a, b) => a.source.layer - b.source.layer);
  const over = live.filter(c => c.source.layer === SbLayer.Overlay);

  let startTime = Infinity;
  let endTime = -Infinity;
  for (const c of live) {
    startTime = Math.min(startTime, c.startTime);
    endTime = Math.max(endTime, c.endTime);
  }

  // Mirrors lazer's DrawableStoryboard.ReplacesBackground: no background file named, no
  // replacement. Only a live Background-layer sprite of that exact file stands in for it —
  // one with no commands never draws, so it cannot.
  const bgLookup = backgroundPath === null ? '' : normalisePath(backgroundPath);
  const replacesBackground = bgLookup !== '' && under.some(
    c => c.source.layer === SbLayer.Background && c.source.lookupPath === bgLookup,
  );

  return { under, over, assets, view, startTime, endTime, replacesBackground };
}

/** Fraction of the sprite's width/height that sits left of / above its anchor. */
function originFactors(origin: number): { fx: number; fy: number } {
  switch (origin) {
    case 1: return { fx: 0.5, fy: 0.5 };   // Centre
    case 2: return { fx: 0, fy: 0.5 };     // CentreLeft
    case 3: return { fx: 1, fy: 0 };       // TopRight
    case 4: return { fx: 0.5, fy: 1 };     // BottomCentre
    case 5: return { fx: 0.5, fy: 0 };     // TopCentre
    case 7: return { fx: 1, fy: 0.5 };     // CentreRight
    case 8: return { fx: 0, fy: 1 };       // BottomLeft
    case 9: return { fx: 1, fy: 1 };       // BottomRight
    // TopLeft, and Custom which osu! treats as TopLeft.
    default: return { fx: 0, fy: 0 };
  }
}

/** Reused across frames and sprites so the draw loop allocates nothing. */
const state: SbSpriteState = createSpriteState();

/**
 * Scratch surface for colour-tinted sprites. Canvas2D cannot multiply a colour through
 * `drawImage`, and doing it on the main context with `globalCompositeOperation = 'multiply'`
 * is wrong: blend modes composite source-over, so an opaque fill over the sprite's
 * transparent pixels yields opaque colour — every sprite becomes a solid rectangle. Tinting
 * therefore happens off to the side, where `destination-in` can restore the alpha mask.
 *
 * Grown on demand and kept for reuse; a per-sprite canvas would thrash allocation.
 */
let tintCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let tintCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;

function tinted(
  bitmap: ImageBitmap,
  r: number,
  g: number,
  b: number,
): HTMLCanvasElement | OffscreenCanvas | null {
  const w = bitmap.width;
  const h = bitmap.height;
  if (w === 0 || h === 0) return null;

  if (tintCanvas === null || tintCanvas.width < w || tintCanvas.height < h) {
    const width = Math.max(w, tintCanvas?.width ?? 0);
    const height = Math.max(h, tintCanvas?.height ?? 0);
    tintCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    tintCtx = tintCanvas.getContext('2d') as CanvasRenderingContext2D | null;
  }
  if (tintCtx === null) return null;

  const c = tintCtx;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, w, h);
  c.drawImage(bitmap, 0, 0);
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = `rgb(${r},${g},${b})`;
  c.fillRect(0, 0, w, h);
  // Restores the sprite's own alpha, which the opaque fill above flattened.
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(bitmap, 0, 0);
  c.restore();
  return tintCanvas;
}

function drawPass(
  ctx: CanvasRenderingContext2D,
  drawables: readonly CompiledDrawable[],
  prepared: PreparedStoryboard,
  timeMs: number,
  options: StoryboardDrawOptions,
): void {
  const { assets, view } = prepared;
  const scale = view.logicalHeight / SB_HEIGHT;
  const centreX = view.logicalWidth / 2;
  const dim = Math.max(0, Math.min(1, options.dim));
  // Uniform darkening goes through a filter rather than a colour multiply: it costs one
  // state change instead of an off-screen round trip, and preserves alpha.
  const dimFilter = dim > 0 ? `brightness(${1 - dim})` : 'none';

  for (const compiled of drawables) {
    // Cheap span test first: most sprites are inactive at any given moment.
    if (timeMs < compiled.startTime) {
      if (timeMs >= compiled.startTime - options.prefetchMs) {
        const d = compiled.source;
        assets.prefetch(d.kind === 'animation' ? d.framePaths : [d.lookupPath]);
      }
      continue;
    }
    if (timeMs > compiled.endTime) continue;

    const s = evaluateSprite(compiled, timeMs, state);
    if (s === null) continue;

    const d = compiled.source;
    const path = d.kind === 'animation'
      ? (d.framePaths[s.frameIndex] ?? d.framePaths[0])
      : d.lookupPath;
    if (path === undefined) continue;
    const bitmap = assets.request(path);
    // Not decoded yet (or absent): skip this frame rather than stalling the render loop.
    if (bitmap === null) continue;

    const { fx, fy } = originFactors(d.origin);
    const w = bitmap.width;
    const h = bitmap.height;
    if (w === 0 || h === 0) continue;

    const white = s.r === 255 && s.g === 255 && s.b === 255;
    // A tinted sprite folds the dim into its colour so it does not pay for both paths.
    const source = white ? bitmap : tinted(
      bitmap,
      Math.round(s.r * (1 - dim)),
      Math.round(s.g * (1 - dim)),
      Math.round(s.b * (1 - dim)),
    );
    if (source === null) continue;

    ctx.save();
    ctx.globalAlpha = s.alpha;
    if (white && dim > 0) ctx.filter = dimFilter;
    // osu!'s additive parameter maps onto 'lighter'; everything else is normal compositing.
    if (s.additive) ctx.globalCompositeOperation = 'lighter';

    ctx.translate(centreX + (s.x - SB_CENTRE_X) * scale, s.y * scale);
    if (s.rotation !== 0) ctx.rotate(s.rotation);
    // Flips are sign changes on the scale, applied around the anchor.
    ctx.scale(
      s.scaleX * scale * (s.flipH ? -1 : 1),
      s.scaleY * scale * (s.flipV ? -1 : 1),
    );
    // The tint surface may be larger than the sprite (it is reused at the largest size seen),
    // so blit only the sprite's own rectangle out of it.
    ctx.drawImage(source, 0, 0, w, h, -w * fx, -h * fy, w, h);
    ctx.restore();
  }
}

/**
 * Draws the layers that sit under the playfield. Clipped to the authored width so a 4:3
 * storyboard cannot bleed into the pillarbox areas.
 */
export function drawStoryboardUnder(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedStoryboard,
  timeMs: number,
  options: StoryboardDrawOptions,
): void {
  const { view } = prepared;
  const scale = view.logicalHeight / SB_HEIGHT;
  const authoredWidth = (view.widescreen ? SB_WIDTH_WIDE : SB_WIDTH_4_3) * scale;
  ctx.save();
  if (authoredWidth < view.logicalWidth) {
    ctx.beginPath();
    ctx.rect((view.logicalWidth - authoredWidth) / 2, 0, authoredWidth, view.logicalHeight);
    ctx.clip();
  }
  drawPass(ctx, prepared.under, prepared, timeMs, options);
  ctx.restore();
}

/** Draws the Overlay layer, which sits above the playfield. */
export function drawStoryboardOver(
  ctx: CanvasRenderingContext2D,
  prepared: PreparedStoryboard,
  timeMs: number,
  options: StoryboardDrawOptions,
): void {
  if (prepared.over.length === 0) return;
  const { view } = prepared;
  const scale = view.logicalHeight / SB_HEIGHT;
  const authoredWidth = (view.widescreen ? SB_WIDTH_WIDE : SB_WIDTH_4_3) * scale;
  ctx.save();
  if (authoredWidth < view.logicalWidth) {
    ctx.beginPath();
    ctx.rect((view.logicalWidth - authoredWidth) / 2, 0, authoredWidth, view.logicalHeight);
    ctx.clip();
  }
  drawPass(ctx, prepared.over, prepared, timeMs, options);
  ctx.restore();
}
