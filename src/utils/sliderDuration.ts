import type { BeatmapData, Slider } from '../types/index.js';

// Slider duration depends only on (beatmap, slider), both stable after parsing.
// Memoized per-slider so per-frame callers stop re-scanning timingPoints linearly.
const _durationCache = new WeakMap<Slider, number>();

/**
 * Duration of ONE slide of a slider in beatmap ms:
 * `length / (100 * sliderMultiplier * SV / baseBeatLength)`, using the timing
 * point active at the slider's start. Total active duration = this × `slides`.
 */
export function slideDurationMs(beatmap: BeatmapData, slider: Slider): number {
  const cached = _durationCache.get(slider);
  if (cached !== undefined) return cached;

  let baseBeatLength = 500; // fallback: 120 BPM
  let svMultiplier = 1;

  for (const tp of beatmap.timingPoints) {
    if (tp.time > slider.time) break;
    if (!tp.inherited) {
      baseBeatLength = tp.beatLength;
      // Red (uninherited) points reset SV to 1.0, matching osu!'s velocity model.
      svMultiplier = 1;
    } else {
      svMultiplier = Math.max(0.1, Math.min(10, -100 / tp.beatLength));
    }
  }

  const velocity = (100 * beatmap.sliderMultiplier * svMultiplier) / baseBeatLength;
  const duration = velocity > 0 ? slider.length / velocity : 1000;
  _durationCache.set(slider, duration);
  return duration;
}
