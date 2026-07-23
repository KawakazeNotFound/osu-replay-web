/**
 * Public entry point for the replay-engine library — import everything from here.
 *
 * Exports come in three tiers:
 * 1. **Parsing** — decode .osr replays, .osu beatmaps, .osz beatmap sets, and skins
 *    into the shared types (see `./types/index` for the canonical field reference).
 * 2. **Headless analysis** — judge a replay and compute score/acc/combo/UR timelines
 *    with no canvas, skin, or audio (`analyzeReplay` and the pieces it's built from).
 * 3. **Rendering + playback** — build a full canvas session (`createReplaySession`)
 *    with a Player/Renderer/AudioSync driving synchronized visuals and sound.
 */

// ---- Shared types (canonical field reference for replays/beatmaps/skins) ----
export * from './types/index';

// ---- Parsing ----
export { parseReplay } from './parsers/ReplayParser';
export { parseBeatmap } from './parsers/BeatmapParser';
export {
  loadBeatmapSet, extractBeatmapBackground, type BeatmapSetContents,
} from './parsers/BeatmapSetLoader';
export { loadSkin, loadSkinFromDir, mergeSkinAssets } from './parsers/SkinLoader';
export { md5 } from './utils/md5';

// ---- Headless analysis ----
export { computeModDifficulty, hasMod, Mod, type ModDifficulty } from './utils/modDifficulty';
export { applyStacking } from './utils/stacking';
export { analyzeReplay, type ReplayAnalysis } from './analyze';
export type { ScoreFrame, Grade } from './utils/scoreProcessor';
export type { AccFrame, ComboFrame } from './renderer/HUDRenderer';
export type { URTimeline, URHit, URZone } from './renderer/URBarRenderer';

// Ruleset conversions + scoring pieces consumers need alongside the analysis outputs
// (mania holds aren't in beatmap.hitObjects; catch judgement runs on converted objects).
export { convertBeatmapToMania } from './rulesets/mania/converter';
export type { ManiaHitObject, ManiaNote, ManiaHoldNote } from './rulesets/mania/types';
export { combineLN, type SubResults } from './rulesets/mania/scoreProcessor';
export { convertBeatmapToCatch } from './rulesets/catch/converter';
export { applyPositionOffsets } from './rulesets/catch/positions';
export type { CatchObject, CatchObjectType } from './rulesets/catch/types';

// ---- Auto replays (generate a perfect play for a beatmap, no .osr needed) ----
export { synthesizeAutoReplay, type AutoFrame } from './utils/autoReplay';
export { generateStdAutoReplay } from './rulesets/std/autoGenerator';
export { generateTaikoAutoReplay } from './rulesets/taiko/autoGenerator';
export { generateManiaAutoReplay } from './rulesets/mania/autoGenerator';
export { generateCatchAutoReplay } from './rulesets/catch/autoGenerator';

// ---- Rendering / playback ----
export {
  createReplaySession, buildSkin,
  type ReplaySessionInputs, type CoreSession, type BeatmapAssets,
} from './session';
export { Renderer, type RenderOptions, type ExportRenderBundle } from './renderer/Renderer';
export { Player } from './player/Player';
export { TimeMapper } from './player/TimeMapper';
export { AudioSync, type MixdownInputs } from './player/AudioSync';
export {
  computeHitsoundSchedule, resolveSample, lookupSkinSound,
  type PendingSound, type PendingSoundType, type HitsoundScheduleInputs, type SampleResolverDeps,
} from './player/hitsoundSchedule';
export { stretchAudioBuffer, stretchWorkerAvailable } from './player/stretchClient';
export {
  configureWorkers, workerUrl, workerAvailable, spawnWorker,
  type WorkerName, type WorkerManifest,
} from './player/workers';
