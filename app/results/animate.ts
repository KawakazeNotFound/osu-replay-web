/**
 * Tweening for the results reveal, with osu!framework's easing curves.
 *
 * lazer's reveal is a timed sequence, not a CSS transition: the ring fills over 3 s with
 * `Easing.OutPow10`, the score rolls up alongside it, and the statistics stagger in 200 ms
 * apart. CSS cannot express OutPow10, and the sequence needs a shared clock so a re-reveal can
 * cancel a running one — hence a small rAF tween runner rather than `transition`.
 */

/** `Easing.OutQuint` */
export function outQuint(t: number): number {
  return 1 - (1 - t) ** 5;
}

/** `Easing.OutPow10` — the accuracy circle's fill curve. Very front-loaded. */
export function outPow10(t: number): number {
  return 1 - (1 - t) ** 10;
}

/** `Easing.OutQuad` — the accuracy counter's roll-up. */
export function outQuad(t: number): number {
  return 1 - (1 - t) ** 2;
}

/** `Easing.OutQuint` on the way in, used for panel appearance. */
export type EasingFn = (t: number) => number;

export interface TweenOptions {
  readonly durationMs: number;
  readonly delayMs?: number;
  readonly easing?: EasingFn;
  /** Called with eased 0–1 progress, then exactly once more with 1 at the end. */
  readonly onUpdate: (progress: number) => void;
  readonly onComplete?: () => void;
}

/** A running tween or sequence; cancel to stop it mid-flight. */
export interface Cancellable {
  cancel(): void;
}

/**
 * Runs one tween on rAF. Guarantees a final `onUpdate(1)` so a value never ends a frame short
 * of its target — otherwise a score counter can stop on 26,464,745.
 */
export function tween(options: TweenOptions): Cancellable {
  const { durationMs, delayMs = 0, easing = outQuint, onUpdate, onComplete } = options;
  let raf = 0;
  let cancelled = false;
  let start: number | null = null;

  const step = (now: number): void => {
    if (cancelled) return;
    if (start === null) start = now;
    const elapsed = now - start - delayMs;
    if (elapsed < 0) { raf = requestAnimationFrame(step); return; }
    if (durationMs <= 0) {
      onUpdate(1);
      onComplete?.();
      return;
    }
    const t = Math.min(1, elapsed / durationMs);
    onUpdate(easing(t));
    if (t < 1) { raf = requestAnimationFrame(step); return; }
    onUpdate(1);
    onComplete?.();
  };

  raf = requestAnimationFrame(step);
  return {
    cancel(): void {
      cancelled = true;
      cancelAnimationFrame(raf);
    },
  };
}

/** Runs a callback once after a delay, cancellable alongside the rest of a sequence. */
export function after(delayMs: number, fn: () => void): Cancellable {
  const id = setTimeout(fn, delayMs);
  return { cancel: () => clearTimeout(id) };
}

/** Groups cancellables so one `cancel()` stops the whole reveal. */
export function group(...parts: readonly Cancellable[]): Cancellable {
  const items = [...parts];
  return {
    cancel(): void {
      for (const item of items) item.cancel();
    },
  };
}

/**
 * Interpolates an integer counter. lazer rolls the score and accuracy up rather than snapping,
 * which is most of why the reveal reads as a reveal.
 */
export function counter(
  from: number,
  to: number,
  progress: number,
): number {
  return from + (to - from) * progress;
}
