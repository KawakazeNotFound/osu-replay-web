/**
 * Entry point for the engine bundle that replaces upstream's engine chunk in site/.
 *
 * Why this exists: the captured site runs upstream's *compiled* copy of the engine
 * (chunk-<hash>.js, ~573 KB), not our dist/. Without this swap, anything we implement in
 * src/ — storyboards, fixes — never reaches the deployed page. app-<hash>.js imports 21
 * named symbols from that chunk; this module must export all 21 so it is a drop-in.
 *
 * Comparing upstream's chunk sourcemap (62 sources) against src/ shows the two engines are
 * the same code except for two files upstream holds back: app/pp.ts and app/ppOverlay.ts,
 * the pp counter. Everything else our engine covers natively.
 *
 * Built by scripts/capture-upstream.mjs, which overwrites the engine chunk in place.
 */

export * from '../src/index.js';

// ---- pp counter shim ----------------------------------------------------------------
// The public engine does not ship the pp algorithm, so we cannot compute real numbers and
// will not invent any. The three functions upstream exports are stubbed to keep their
// contract: the enabled flag round-trips (so the UI checkbox reflects what the user did)
// but no `hudOverlay` is installed, so nothing is drawn. Consequence: the "pp counter"
// option in the deployed UI is inert. Documented in SELF_HOSTING.md.

// Keyed by renderer so multiple concurrent sessions (dual view, match view) stay separate;
// weak so a destroyed session's entry goes away with it.
const ppEnabled = new WeakMap<object, boolean>();

/** Upstream signature: (renderer, beatmap, replay, modDiff). Only the renderer is used. */
export function wirePPCounter(
  renderer: object,
  _beatmap?: unknown,
  _replay?: unknown,
  _modDiff?: unknown,
): void {
  ppEnabled.set(renderer, true);
}

export function setPPCounterEnabled(renderer: object, on: boolean): void {
  ppEnabled.set(renderer, on);
}

export function isPPCounterEnabled(renderer: object): boolean {
  return ppEnabled.get(renderer) ?? false;
}
