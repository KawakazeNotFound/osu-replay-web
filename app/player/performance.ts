/**
 * Local difficulty and pp, from rosu-pp compiled to WebAssembly.
 *
 * Everything else here reads pp off the score osu! already recorded, which leaves it blank for
 * every case that has no such score: an Auto replay, an unsubmitted play, a map that was never
 * uploaded. rosu-pp ports osu!'s own difficulty and performance algorithms, so it answers those
 * from the `.osu` alone — and it gives a *mod-adjusted* star rating, which neither the API nor
 * the mirrors do (both report the nomod figure, as `fetchScoreMeta` notes).
 *
 * Loaded on demand, and once: ~100 KB of glue over an ~800 KB `.wasm`, which most sessions never
 * need, so nothing here is fetched until a figure is actually asked for.
 *
 * Why a vendored copy rather than the npm package: `rosu-pp-js` on npm ships the *Node* build —
 * it `require`s `fs`/`path`/`util` and reads the binary off disk, so it cannot run in a browser at
 * all. The browser build is a separate release artifact, kept in `vendor/rosu-pp-js/`. The npm
 * package stays a devDependency for the tests, where being Node-only is exactly what is wanted.
 *
 * These numbers are computed, not authoritative: rosu-pp tracks osu!'s algorithms but osu! reworks
 * them, so a locally computed figure can differ from what the website shows for the same play.
 * Callers mark it as computed rather than presenting it as osu!'s own.
 */

import type { LazerStatistics, ReplayData } from '../../src/index.js';

/** Served as a plain asset by `build-app.mjs`; absolute, so both `/` and `/app/dev` reach it. */
const WASM_URL = '/rosu-pp/rosu_pp_js_bg.wasm';

type RosuModule = typeof import('../../vendor/rosu-pp-js/rosu_pp_js.js');

/** Resolved once and reused; a failed load is remembered as null rather than retried per replay. */
let loading: Promise<RosuModule | null> | null = null;

async function rosu(): Promise<RosuModule | null> {
  loading ??= (async (): Promise<RosuModule | null> => {
    try {
      const module = await import('../../vendor/rosu-pp-js/rosu_pp_js.js');
      await module.default({ module_or_path: WASM_URL });
      return module;
    } catch (err) {
      // No pp is the pre-existing behaviour, so a missing or blocked .wasm degrades to that
      // rather than failing the load around it.
      console.warn('local pp unavailable (rosu-pp could not be initialised):', err);
      return null;
    }
  })();
  return await loading;
}

export interface LocalPerformance {
  /** Performance points for the play as it was performed. */
  readonly pp: number;
  /** Star rating *with the play's mods applied* — unlike the API and mirror figures. */
  readonly stars: number;
}

/** True when the replay came from lazer, which changes both scoring and the mod encoding. */
function isLazer(replay: ReplayData): boolean {
  return replay.gameVersion >= 30000000;
}

/**
 * Mods in whichever form describes this replay best.
 *
 * A lazer replay's trailing block lists them as `{ acronym, settings }`, which rosu-pp accepts
 * directly and which the legacy bitmask cannot express — it has no room for lazer-only mods or for
 * a custom speed change. Stable replays only have the bitmask, which rosu-pp also accepts.
 */
function modsFor(replay: ReplayData): object | number {
  const lazerMods = replay.scoreInfo?.mods;
  if (lazerMods !== undefined && lazerMods.length > 0) return lazerMods;
  return replay.mods;
}

/**
 * Hit counts as rosu-pp names them.
 *
 * The `.osr` count fields already mean different things per ruleset, in the same way rosu-pp's
 * arguments do — `countGeki` is mania's 320s and `countKatu` its 200s, while in catch `countKatu`
 * is tiny-droplet misses. So the mapping is per mode rather than one set of names.
 *
 * `nGeki`/`nKatu` are deliberately omitted for osu! and taiko: there they are the 300+/100+
 * variants, which are *already inside* count300/count100, and rosu-pp ignores them for those
 * modes anyway.
 */
function hitCountsFor(replay: ReplayData): Record<string, number> {
  const { count300, count100, count50, countGeki, countKatu, countMiss } = replay;
  switch (replay.mode) {
    case 1: // taiko — no 50s exist
      return { n300: count300, n100: count100, misses: countMiss };
    case 2: // catch — fruits / droplets / tiny droplets, and tiny-droplet misses in katu
      return {
        n300: count300, n100: count100, n50: count50,
        nKatu: countKatu, misses: countMiss,
      };
    case 3: // mania — geki is 320, katu is 200
      return {
        nGeki: countGeki, n300: count300, nKatu: countKatu,
        n100: count100, n50: count50, misses: countMiss,
      };
    default: // osu!std
      return { n300: count300, n100: count100, n50: count50, misses: countMiss };
  }
}

/**
 * The lazer-only slider counts, which decide slider accuracy and so materially change osu!std pp.
 *
 * Only a lazer replay carries them, in its per-result statistics. Leaving them out of a lazer
 * calculation makes rosu-pp assume the best case, which quietly inflates pp on a play that dropped
 * slider ends.
 */
function sliderCountsFor(statistics: LazerStatistics): Record<string, number> {
  const counts: Record<string, number> = {};
  const largeTicks = statistics.large_tick_hit;
  const sliderEnds = statistics.slider_tail_hit;
  const smallTicks = statistics.small_tick_hit;
  if (largeTicks !== undefined) counts['largeTickHits'] = largeTicks;
  if (sliderEnds !== undefined) counts['sliderEndHits'] = sliderEnds;
  if (smallTicks !== undefined) counts['smallTickHits'] = smallTicks;
  return counts;
}

/**
 * The arguments rosu-pp needs to score `replay`, as a plain object.
 *
 * Split out from {@link computeLocalPerformance} so the mapping — which is where a mistake would
 * silently produce a plausible-but-wrong number — can be tested without the WASM.
 */
export function performanceArgsFor(replay: ReplayData): Record<string, unknown> {
  const lazer = isLazer(replay);
  const statistics = replay.scoreInfo?.statistics;
  return {
    mods: modsFor(replay),
    lazer,
    combo: replay.maxCombo,
    ...hitCountsFor(replay),
    ...(lazer && statistics !== undefined ? sliderCountsFor(statistics) : {}),
  };
}

/**
 * Difficulty and pp for `replay` on `rawOsu`, or null when they could not be computed.
 *
 * `rawOsu` is the exact `.osu` the session was built from — `BeatmapData.rawOsu`, which the engine
 * stashes for precisely this — so the numbers describe the difficulty that was actually played, not
 * a re-download that may have been edited since.
 *
 * Never throws. A map rosu-pp declines (`isSuspicious`, i.e. built to stress osu! rather than to be
 * played), a `.osu` it cannot decode, or a `.wasm` that would not load all return null, which the
 * panel already renders as "unknown".
 */
export async function computeLocalPerformance(
  rawOsu: Uint8Array,
  replay: ReplayData,
): Promise<LocalPerformance | null> {
  const module = await rosu();
  if (module === null) return null;

  let beatmap: InstanceType<RosuModule['Beatmap']> | null = null;
  try {
    beatmap = new module.Beatmap(rawOsu);
    // Maps written to test osu!'s limits rather than to be played; the library asks callers to
    // skip them because calculation can take pathologically long.
    if (beatmap.isSuspicious()) return null;

    // A replay's own ruleset wins over the beatmap's, so a converted play is scored as the mode it
    // was played in. convert() is a no-op-by-error when the modes already agree, hence the guard.
    if (replay.mode !== beatmap.mode) beatmap.convert(replay.mode, modsFor(replay));

    const attributes = new module.Performance(performanceArgsFor(replay)).calculate(beatmap);
    return { pp: attributes.pp, stars: attributes.difficulty.stars };
  } catch (err) {
    console.warn('local pp calculation failed:', err);
    return null;
  } finally {
    // WASM memory is not reclaimed with the JS wrapper, so the handle is released explicitly —
    // a session per replay would otherwise leak a parsed beatmap each time.
    beatmap?.free();
  }
}
