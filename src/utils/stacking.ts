import type { BeatmapData, HitCircle, Slider } from '../types/index.js';
import type { ModDifficulty } from './modDifficulty.js';
import { slideDurationMs } from './sliderDuration.js';
import { sampleSlider } from '../renderer/SliderGeometry.js';

// osu!'s note-stacking algorithm. Effective position = nominal -
// (stackHeight * stackOffset) on both axes, stackOffset = hitRadius / 10;
// without it, hit detection false-misses correctly-aimed notes.
// formatVersion >= 6 uses the backward-walk algorithm; < 6 the old forward walk.

const STACK_DISTANCE = 3;

function objectEndTime(beatmap: BeatmapData, obj: BeatmapData['hitObjects'][number]): number {
  if (obj.type === 'slider') {
    const dur = slideDurationMs(beatmap, obj as Slider);
    return obj.time + dur * (obj as Slider).slides;
  }
  if (obj.type === 'spinner') return (obj as { endTime: number }).endTime;
  return obj.time;
}

// Geometric slider endpoint (curve position at the end of the last span), matching
// danser/osu! stacking which keys the tail-stack distance check on GetEndPosition —
// NOT the last control point, which can sit tens of px off the real endpoint for
// arc/bezier curves (missing tail-stacks → wrong stackHeight → edge-of-radius misjudge).
// Even repeat counts return to the head. Cached: sampleSlider tessellates the curve.
const sliderEndCache = new WeakMap<Slider, { x: number; y: number }>();
function sliderEndPos(slider: Slider): { x: number; y: number } {
  if (slider.slides % 2 === 0) return { x: slider.x, y: slider.y };
  const cached = sliderEndCache.get(slider);
  if (cached) return cached;
  const path = sampleSlider(slider);
  const end = path.length > 0
    ? { x: path[path.length - 1]!.x, y: path[path.length - 1]!.y }
    : { x: slider.x, y: slider.y };
  sliderEndCache.set(slider, end);
  return end;
}

/**
 * Compute and mutate `stackHeight` on every circle/slider in place (spinners
 * untouched). 0 = base position; N shifts the note by -N*radius/10 on both
 * axes, with earlier notes in a stack getting higher values. Uses the time
 * threshold `preemptMs * stackLeniency` and dispatches on `formatVersion < 6`
 * to osu!'s old stacking algorithm. Call once after parsing, before judging
 * or rendering.
 */
export function applyStacking(beatmap: BeatmapData, modDiff: ModDifficulty): void {
  const objs = beatmap.hitObjects;
  if (objs.length === 0) return;

  for (const obj of objs) {
    if (obj.type !== 'spinner') obj.stackHeight = 0;
  }

  if (beatmap.formatVersion >= 6) applyNewStacking(beatmap, modDiff);
  else                            applyOldStacking(beatmap, modDiff);
}

// Modern (v6+) algorithm — the danser/lazer pass 2 only; pass 1's chain-endpoint
// scan is redundant for a full rebuild.
// Per-branch break thresholds: circle uses startI-endN, slider uses startI-startN.
function applyNewStacking(beatmap: BeatmapData, modDiff: ModDifficulty): void {
  const objs = beatmap.hitObjects;
  const n = objs.length;
  const stackThreshold = modDiff.preemptMs * beatmap.stackLeniency;

  for (let i = n - 1; i > 0; i--) {
    const objI = objs[i]!;
    if (objI.type === 'spinner') continue;
    if (objI.stackHeight !== 0) continue;

    if (objI.type === 'circle') {
      let curI = i;
      for (let j = curI - 1; j >= 0; j--) {
        const objJ = objs[j]!;
        if (objJ.type === 'spinner') continue;

        const endTimeJ = objectEndTime(beatmap, objJ);
        if (objs[curI]!.time - endTimeJ > stackThreshold) break;

        // Circle I lands on slider J's tail: bump every k in (j, i] sharing that tail.
        if (objJ.type === 'slider') {
          const tail = sliderEndPos(objJ as Slider);
          // curI only ever indexes a non-spinner (starts at i, moves to already-checked j).
          const cur = objs[curI] as HitCircle | Slider;
          const dx = tail.x - cur.x;
          const dy = tail.y - cur.y;
          if (dx * dx + dy * dy < STACK_DISTANCE * STACK_DISTANCE) {
            const offset = cur.stackHeight - (objJ as Slider).stackHeight + 1;
            for (let k = j + 1; k <= i; k++) {
              const objK = objs[k]!;
              if (objK.type === 'spinner') continue;
              const tdx = tail.x - objK.x;
              const tdy = tail.y - objK.y;
              if (tdx * tdx + tdy * tdy < STACK_DISTANCE * STACK_DISTANCE) {
                objK.stackHeight -= offset;
              }
            }
            break;
          }
        }

        const cur = objs[curI] as HitCircle | Slider;
        const dx = objJ.x - cur.x;
        const dy = objJ.y - cur.y;
        if (dx * dx + dy * dy < STACK_DISTANCE * STACK_DISTANCE) {
          objJ.stackHeight = cur.stackHeight + 1;
          curI = j;
        }
      }
    } else {
      let curI = i;
      for (let j = curI - 1; j >= 0; j--) {
        const objJ = objs[j]!;
        if (objJ.type === 'spinner') continue;

        if (objs[curI]!.time - objJ.time > stackThreshold) break;

        const endPosJ = objJ.type === 'slider'
          ? sliderEndPos(objJ as Slider)
          : { x: objJ.x, y: objJ.y };
        const cur = objs[curI] as HitCircle | Slider;
        const dx = endPosJ.x - cur.x;
        const dy = endPosJ.y - cur.y;
        if (dx * dx + dy * dy < STACK_DISTANCE * STACK_DISTANCE) {
          objJ.stackHeight = cur.stackHeight + 1;
          curI = j;
        }
      }
    }
  }
}

// Old (pre-v6) algorithm, stable's applyStacking2: forward walk; sliders are
// re-evaluated even when already stacked.
function applyOldStacking(beatmap: BeatmapData, modDiff: ModDifficulty): void {
  const objs = beatmap.hitObjects;
  const n = objs.length;
  const stackThreshold = modDiff.preemptMs * beatmap.stackLeniency;

  for (let i = 0; i < n; i++) {
    const objI = objs[i]!;
    if (objI.type === 'spinner') continue;
    if (objI.stackHeight !== 0 && objI.type !== 'slider') continue;

    let startTime = objectEndTime(beatmap, objI);
    let sliderStack = 0;

    const iEndPos = objI.type === 'slider'
      ? sliderEndPos(objI as Slider)
      : { x: objI.x, y: objI.y };

    for (let j = i + 1; j < n; j++) {
      const objJ = objs[j]!;
      if (objJ.type === 'spinner') continue;
      if (objJ.time - startTime > stackThreshold) break;

      const dxStart = objJ.x - objI.x;
      const dyStart = objJ.y - objI.y;
      if (dxStart * dxStart + dyStart * dyStart < STACK_DISTANCE * STACK_DISTANCE) {
        objI.stackHeight++;
        startTime = objectEndTime(beatmap, objJ);
        continue;
      }

      // J at slider I's tail: bump J down-right (negative stack).
      if (objI.type === 'slider') {
        const dxEnd = objJ.x - iEndPos.x;
        const dyEnd = objJ.y - iEndPos.y;
        if (dxEnd * dxEnd + dyEnd * dyEnd < STACK_DISTANCE * STACK_DISTANCE) {
          sliderStack++;
          objJ.stackHeight -= sliderStack;
          startTime = objectEndTime(beatmap, objJ);
        }
      }
    }
  }
}
