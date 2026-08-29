/**
 * Turns a replay into the two things the flow needs: a live session, and the numbers the
 * results panel shows.
 *
 * Three entry points:
 *  - `loadLocalReplay` — a .osr plus its .osz. Entirely offline.
 *  - `loadAutoFromBeatmap` — a beatmap reference, played by a synthesised perfect replay. Only
 *    public endpoints, so no token.
 *  - `loadOnlineScore` — a real score, which needs the token the captured page holds (see
 *    osuApi.ts). Same-origin only, which is why the UI deploys alongside the Worker.
 *
 * `loadFromInput` picks between them, so the page has one entry rather than a branch of its own.
 */

import {
  analyzeReplay, buildSkin, computeModDifficulty, computeSubJudgements, createReplaySession,
  generateStdAutoReplay, generateTaikoAutoReplay, generateCatchAutoReplay, generateManiaAutoReplay,
  convertBeatmapToCatch, applyPositionOffsets,
  md5, parseBeatmap, parseReplay, synthesizeAutoReplay, unzipAsync,
  type AutoFrame, type BeatmapData, type CoreSession, type Grade, type ReplayData, type SubJudgementCount,
} from '../../src/index.js';
import { JUDGEMENT_COLOUR, type ResultsPanelData, type StatisticEntry } from '../results/panel.js';
import type { LoadedReplay } from './flow.js';
import {
  downloadReplay, fetchBeatmapOsu, fetchScoreMeta, parseScoreRef, scoreRefFromReplay,
  type ScoreMeta,
} from './osuApi.js';
import { isLoggedIn } from './auth.js';
import { DEFAULT_SKIN, loadSkin } from './skins.js';
import { downloadMatchReplays, type MatchMap } from './matchRoom.js';
import {
  archiveStandaloneOsu, selectLocalDifficulty, type ChooseDifficulty, type LocalDifficulty,
} from './localBeatmap.js';

export {
  archiveStandaloneOsu, DifficultyCancelled, selectLocalDifficulty,
  type LocalDifficulty,
} from './localBeatmap.js';

/** osu!standard cutoffs, as lazer's ruleset reports them (ScoreProcessor.cs L34-39). */
const CUTOFFS = { D: 0, C: 0.7, B: 0.8, A: 0.9, S: 0.95, X: 1 } as const;

const LAZER_DEFAULTS_URL = '/assets/lazer-defaults';

export type LogFn = (message: string) => void;

/** Options every loader accepts, so adding one does not change four signatures. */
export interface LoadOptions {
  readonly audioContext: AudioContext;
  readonly canvas: HTMLCanvasElement;
  readonly log: LogFn;
  /** Skin directory name under /skins; defaults to the captured page's own preselection. */
  readonly skin?: string;
  /**
   * Asked which difficulty to play when a local `.osz` holds more than one. Return an index into
   * the list, or null to abort the load.
   *
   * A multi-difficulty archive requires this callback: ranking difficulties needs a star-rating
   * calculator this engine does not implement, and archive order carries no meaning. The previous
   * default summed OD and AR and called the result "highest difficulty", which it is not — a
   * high-AR low-star map would win.
   */
  readonly chooseDifficulty?: ChooseDifficulty;
}

/** Reads a File as an ArrayBuffer. */
async function readFile(file: File): Promise<ArrayBuffer> {
  return await file.arrayBuffer();
}

/** Beatmap id out of a bare number or an osu! beatmap URL. */
export function parseBeatmapRef(input: string): number | null {
  const s = input.replace(/\s/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  const set = /beatmapsets\/\d+#(?:osu|taiko|fruits|mania)\/(\d+)/i.exec(s);
  if (set !== null) return Number(set[1]);
  const bare = /beatmaps\/(\d+)/i.exec(s);
  return bare !== null ? Number(bare[1]) : null;
}

/**
 * The .osu's `Creator`, read from the raw text. `BeatmapData` does not carry it — the parser
 * keeps only what judging needs — and "mapped by" is the one place the panel wants it.
 */
function creatorFrom(rawOsu: Uint8Array | undefined): string {
  if (rawOsu === undefined) return '';
  const text = new TextDecoder().decode(rawOsu);
  return /^Creator\s*:\s*(.+)$/mi.exec(text)?.[1]?.trim() ?? '';
}

function sourceFrom(rawOsu: Uint8Array | undefined): string {
  if (rawOsu === undefined) return '';
  const text = new TextDecoder().decode(rawOsu);
  return /^Source\s*:\s*(.+)$/mi.exec(text)?.[1]?.trim() ?? '';
}

/**
 * Panel data from a session.
 *
 * Judgement counts come from the `.osr` header when there is one: osu! wrote those totals, so
 * they are authoritative in a way re-derived counts are not, and a mismatch would mean our judge
 * disagrees with osu! — worth surfacing elsewhere, not worth papering over here. A synthesised
 * auto replay has no header totals, so those are counted from the analysis instead.
 *
 * The sub-judgement row comes from `computeSubJudgements`, which re-judges the replay to reach
 * the slider tick/repeat/tail split and the spinner rotation. That is a second pass over the
 * input frames, so it is only done for osu!standard — the other rulesets have no such row.
 */
export function resultsDataFromSession(
  session: CoreSession,
  meta: {
    readonly fromHeader: boolean;
    readonly avatarUrl?: string | null;
    readonly pp?: number | null;
    readonly starRating?: number | null;
    readonly playedOn?: string | null;
  },
): ResultsPanelData {
  const { beatmap, replay } = session;
  const analysis = analyzeReplay(beatmap, replay);

  // Index arithmetic rather than .at(-1): the project targets ES2020, as src/ does.
  const scoreFrames = analysis.scoreFrames;
  const lastScore = scoreFrames.length > 0 ? scoreFrames[scoreFrames.length - 1]! : null;
  const accFrames = analysis.accFrames;
  const finalAcc = accFrames.length > 0 ? accFrames[accFrames.length - 1]!.acc : 0;

  let great: number;
  let ok: number;
  let meh: number;
  let miss: number;
  if (meta.fromHeader) {
    // countGeki/countKatu are the 300+/100+ variants; they are already inside count300/count100.
    great = replay.count300;
    ok = replay.count100;
    meh = replay.count50;
    miss = replay.countMiss;
  } else {
    great = 0; ok = 0; meh = 0; miss = 0;
    for (const result of analysis.hitResults) {
      if (result.isSliderSub === true) continue;
      switch (result.judgement) {
        case 300: case 305: great++; break;
        case 200: case 100: ok++; break;
        case 50: meh++; break;
        case 0: miss++; break;
      }
    }
  }

  const judgements: StatisticEntry[] = [
    { label: 'great', value: String(great), colour: JUDGEMENT_COLOUR.great },
    { label: 'ok', value: String(ok), colour: JUDGEMENT_COLOUR.ok },
    { label: 'meh', value: String(meh), colour: JUDGEMENT_COLOUR.meh },
    { label: 'miss', value: String(miss), colour: JUDGEMENT_COLOUR.miss },
  ];

  const grade: Grade = lastScore?.grade ?? 'D';
  const maxCombo = meta.fromHeader ? replay.maxCombo : (lastScore?.maxCombo ?? 0);

  // Third row, only where it means something: these four categories are osu!standard's.
  const subJudgements: StatisticEntry[] = [];
  if (replay.mode === 0) {
    const sub = computeSubJudgements(beatmap, replay, analysis.modDiff);
    // lazer shows a category only when the beatmap offers any of it — a map with no spinners
    // should not display a 0/0 cell.
    const cell = (
      label: string, value: SubJudgementCount, colour: string,
    ): void => {
      if (value.max === 0) return;
      subJudgements.push({
        label, value: String(value.count), max: String(value.max), colour,
      });
    };
    cell('slider tick', sub.sliderTick, JUDGEMENT_COLOUR.sliderTick);
    cell('slider end', sub.sliderEnd, JUDGEMENT_COLOUR.sliderEnd);
    cell('spinner bonus', sub.spinnerBonus, JUDGEMENT_COLOUR.bonus);
    cell('spinner spin', sub.spinnerSpin, JUDGEMENT_COLOUR.bonus);
  }

  return {
    title: beatmap.title !== '' ? beatmap.title : '(unknown title)',
    artist: beatmap.artist,
    difficulty: beatmap.version,
    mapper: creatorFrom(beatmap.rawOsu),
    playerName: replay.username !== '' ? replay.username : 'Auto',
    avatarUrl: meta.avatarUrl ?? null,
    score: meta.fromHeader ? replay.score : (lastScore?.score ?? 0),
    accuracy: finalAcc,
    rank: grade,
    cutoffs: CUTOFFS,
    maxCombo,
    // The beatmap's theoretical maximum combo is not exposed, so the `/max` suffix would be a
    // guess. The `.osr` header's `perfect` flag does settle whether it was an unbroken run,
    // which is what PERFECT actually means — so use that, and leave the denominator out.
    beatmapMaxCombo: meta.fromHeader && replay.perfect ? maxCombo : null,
    pp: meta.pp ?? null,
    starRating: (meta.starRating !== undefined && meta.starRating !== null)
      ? meta.starRating
      : estimateStarRating(beatmap),
    judgements,
    subJudgements,
    playedOn: meta.playedOn ?? null,
    source: sourceFrom(beatmap.rawOsu),
  };
}

/**
 * The `.osz` for a beatmap set, from the public mirrors.
 *
 * Two mirrors in a cascade, as the captured page does: osu.direct first, Nerinyan as a fallback.
 * ppy hosts no `.osz` at all — its own download route is lazer-scoped and then redirects to this
 * same mirror infrastructure — so this is not a shortcut around an official endpoint.
 */
async function downloadBeatmapSet(setId: number, log: LogFn): Promise<ArrayBuffer> {
  const mirrors = [
    { name: 'osu.direct', url: `https://osu.direct/api/d/${setId}?noVideo=1` },
    { name: 'Nerinyan', url: `https://api.nerinyan.moe/d/${setId}?noVideo=1` },
  ];
  const failures: string[] = [];
  for (const mirror of mirrors) {
    log(`downloading .osz from ${mirror.name}…`);
    try {
      const response = await fetch(mirror.url);
      if (!response.ok) { failures.push(`${mirror.name}: HTTP ${response.status}`); continue; }
      const buffer = await response.arrayBuffer();
      // A mirror miss sometimes returns a short HTML error with a 200, which would fail later as
      // a confusing unzip error.
      if (buffer.byteLength < 1024) {
        failures.push(`${mirror.name}: ${buffer.byteLength} bytes`);
        continue;
      }
      return buffer;
    } catch (err) {
      failures.push(`${mirror.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`no mirror could supply beatmap set ${setId} — ${failures.join(' | ')}`);
}

/** Estimates star rating from parsed beatmap attributes if official star rating is absent. */
export function estimateStarRating(beatmap: BeatmapData): number {
  const od = beatmap.overallDifficulty || 5;
  const cs = beatmap.circleSize || 4;
  const ar = beatmap.approachRate || 5;
  const totalObjects = beatmap.hitObjects?.length ?? 0;
  if (totalObjects === 0) return 0.0;

  const firstTime = beatmap.hitObjects[0]?.time ?? 0;
  const lastTime = beatmap.hitObjects[totalObjects - 1]?.time ?? 60000;
  const drainDurationSeconds = Math.max(10, (lastTime - firstTime) / 1000);
  const density = totalObjects / drainDurationSeconds; // objects per second

  // Base difficulty formula combining density, CS, AR, and OD
  let sr = 0.5 + (density * 0.48) + (od * 0.12) + (cs * 0.10) + (ar > 8 ? (ar - 8) * 0.15 : 0);
  return Math.max(0.1, Math.min(10.0, Math.round(sr * 100) / 100));
}

/** Resolves a beatmap MD5 to its set id and star rating via osu.direct/Sayobot/Nerinyan. */
async function resolveBeatmapInfo(hash: string): Promise<{ setId: number; starRating: number | null }> {
  // 1. Try osu.direct
  try {
    const response = await fetch(`https://osu.direct/api/v2/md5/${hash}`, {
      headers: { accept: 'application/json' },
    });
    if (response.ok) {
      const data = await response.json() as { beatmapset_id?: number; difficulty_rating?: number };
      if (typeof data.beatmapset_id === 'number') {
        return {
          setId: data.beatmapset_id,
          starRating: typeof data.difficulty_rating === 'number' ? data.difficulty_rating : null,
        };
      }
    }
  } catch (err) {
    console.warn('osu.direct hash lookup failed:', err);
  }

  // 2. Try Sayobot
  try {
    const response = await fetch(`https://api.sayobot.cn/v2/beatmapinfo?K=${hash}&T=1`);
    if (response.ok) {
      const data = await response.json() as { data?: { sid?: number; star?: number } };
      if (typeof data?.data?.sid === 'number') {
        return {
          setId: data.data.sid,
          starRating: typeof data.data.star === 'number' ? data.data.star : null,
        };
      }
    }
  } catch (err) {
    console.warn('sayobot hash lookup failed:', err);
  }

  // 3. Try Nerinyan
  try {
    const response = await fetch(`https://api.nerinyan.moe/api/map/${hash}`);
    if (response.ok) {
      const data = await response.json() as { beatmapset_id?: number; difficulty_rating?: number };
      if (typeof data.beatmapset_id === 'number') {
        return {
          setId: data.beatmapset_id,
          starRating: typeof data.difficulty_rating === 'number' ? data.difficulty_rating : null,
        };
      }
    }
  } catch (err) {
    console.warn('nerinyan hash lookup failed:', err);
  }

  throw new Error('the mirror index does not have this beatmap hash; please provide the .osz file');
}

/** Resolves a beatmap MD5 to its set id via osu.direct/Nerinyan/Sayobot index. */
async function setIdForHash(hash: string): Promise<number> {
  const info = await resolveBeatmapInfo(hash);
  return info.setId;
}

/** osu!'s own played-on wording: `Played on 25 August 2026 6:42 PM`. */
function formatPlayedOn(iso: string | null): string | null {
  if (iso === null) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.getDate();
  const month = date.toLocaleString('en-GB', { month: 'long' });
  const time = date.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${day} ${month} ${date.getFullYear()} ${time}`;
}

/**
 * Star rating for a beatmap we hold locally. It is not written in the `.osu` — osu! computes it,
 * and this engine has no difficulty calculator — so it comes from the mirrors' index either way.
 * A hash lookup only, no download.
 *
 * Absence is not a failure here: unlike the resolve-the-beatmap path, the archive is already in
 * hand, so an unindexed or unsubmitted map just leaves the rating unknown.
 */
async function starRatingForHash(hash: string): Promise<number | null> {
  try {
    return (await resolveBeatmapInfo(hash)).starRating;
  } catch (err) {
    console.warn('star rating unavailable for this beatmap hash:', err);
    return null;
  }
}

/** Shared session construction, so every entry point agrees on skin and defaults. */
async function buildSession(
  replay: ReplayData,
  oszBuffer: ArrayBuffer,
  options: LoadOptions,
): Promise<CoreSession> {
  const { audioContext, canvas, log } = options;
  const name = options.skin ?? DEFAULT_SKIN;
  log(`loading skin ${name}…`);
  const skin = await loadSkin(name, audioContext);
  log('building session…');
  return await createReplaySession({
    canvas,
    audioContext,
    replay,
    beatmapSet: oszBuffer,
    skin: buildSkin(skin, undefined, { mode: replay.mode }),
    lazerDefaultsUrl: LAZER_DEFAULTS_URL,
  });
}

/** A .osr with an optional .osz (if omitted, beatmap is automatically resolved from online mirror via hash). */
export async function loadLocalReplay(
  osrFile: File | ArrayBuffer,
  oszFile: File | ArrayBuffer | null,
  options: LoadOptions,
): Promise<LoadedReplay> {
  const { log } = options;
  log('reading replay (.osr)…');
  const osrBuffer = osrFile instanceof File ? await readFile(osrFile) : osrFile;
  const replay = await parseReplay(osrBuffer);

  // Started before the beatmap work and awaited after the session is built, so the round trip
  // overlaps the unzip and decode instead of adding to them. Every part of it is optional: an
  // unsubmitted replay carries no score id, the request needs a login, and the score may be on
  // an unranked map with no pp at all. None of that is a reason to fail a load that otherwise
  // works, so it degrades to null the way loadOnlineScore's own metadata fetch does.
  const scoreRef = scoreRefFromReplay(replay);
  const metaPromise: Promise<ScoreMeta | null> = scoreRef !== null && isLoggedIn()
    ? fetchScoreMeta(scoreRef).catch((err: unknown) => {
        console.warn('score metadata unavailable for this replay:', err);
        return null;
      })
    : Promise.resolve(null);

  let oszBuffer: ArrayBuffer;
  let mirrorStarRating: number | null = null;
  if (oszFile !== null) {
    log('reading local beatmap (.osz)…');
    // The rating lookup rides alongside reading the archive rather than after it: it is a
    // metadata request that has nothing to wait for.
    const [buffer, starRating] = await Promise.all([
      oszFile instanceof File ? readFile(oszFile) : Promise.resolve(oszFile),
      starRatingForHash(replay.beatmapHash),
    ]);
    oszBuffer = buffer;
    mirrorStarRating = starRating;
  } else {
    log('finding beatmap online by hash…');
    const info = await resolveBeatmapInfo(replay.beatmapHash);
    mirrorStarRating = info.starRating;
    oszBuffer = await downloadBeatmapSet(info.setId, log);
  }

  const session = await buildSession(replay, oszBuffer, options);
  const meta = await metaPromise;

  return {
    session,
    startAtMs: 0,
    panel: resultsDataFromSession(session, {
      fromHeader: true,
      avatarUrl: meta?.avatarUrl ?? null,
      pp: meta?.pp ?? null,
      // Both sources report the same nomod figure (see fetchScoreMeta), so either will do —
      // prefer whichever answered.
      starRating: meta?.starRating ?? mirrorStarRating,
      playedOn: formatPlayedOn(meta?.endedAt ?? null),
    }),
  };
}

function generateAutoReplayForBeatmap(beatmap: BeatmapData, hash: string): ReplayData {
  const stub = synthesizeAutoReplay(beatmap, hash, [], 0);
  const modDiff = computeModDifficulty(beatmap, stub);

  let frames: AutoFrame[];
  switch (beatmap.mode) {
    case 1:
      frames = generateTaikoAutoReplay(beatmap, modDiff);
      break;
    case 2: {
      const objects = convertBeatmapToCatch(beatmap, modDiff);
      applyPositionOffsets(objects, beatmap, modDiff);
      frames = generateCatchAutoReplay(objects, modDiff);
      break;
    }
    case 3:
      frames = generateManiaAutoReplay(beatmap, modDiff);
      break;
    case 0:
    default:
      frames = generateStdAutoReplay(beatmap, modDiff);
      break;
  }
  return synthesizeAutoReplay(beatmap, hash, frames, 0);
}

/**
 * Loads a local beatmap (`.osz`, `.zip` or a bare `.osu`) and plays it with a synthesised Auto
 * replay. Entirely offline — the map need not be submitted.
 *
 * A bare `.osu` is wrapped into a one-entry archive before it reaches the engine.
 * `createReplaySession` takes a beatmap *set*, so passing the `.osu` bytes straight through made
 * `loadBeatmapSet` reject them as `invalid zip data`. There is no audio in that case, which the
 * engine tolerates — it warns and plays silently.
 */
export async function loadLocalAuto(
  file: File,
  options: LoadOptions,
): Promise<LoadedReplay> {
  const { log } = options;
  log(`reading local beatmap (${file.name})…`);

  const fileBuffer = await readFile(file);
  const fileName = file.name.toLowerCase();

  let oszBuffer: ArrayBuffer;
  let osuBytes: Uint8Array;

  if (fileName.endsWith('.osz') || fileName.endsWith('.zip')) {
    oszBuffer = fileBuffer;
    const unzipped = await unzipAsync(new Uint8Array(oszBuffer));

    const entries = Object.keys(unzipped).filter(
      name => name.toLowerCase().endsWith('.osu') && !name.startsWith('__MACOSX/'),
    );
    if (entries.length === 0) {
      throw new Error('no .osu difficulty found inside the archive');
    }

    // Parse every difficulty so the caller can be shown real metadata rather than filenames.
    const choices: LocalDifficulty[] = [];
    const bytes: Uint8Array[] = [];
    for (const entry of entries) {
      const raw = unzipped[entry]!;
      try {
        const beatmap = parseBeatmap(new TextDecoder().decode(raw));
        choices.push({
          entry,
          title: beatmap.title,
          artist: beatmap.artist,
          version: beatmap.version,
          mode: beatmap.mode,
          approachRate: beatmap.approachRate,
          overallDifficulty: beatmap.overallDifficulty,
          circleSize: beatmap.circleSize,
          objectCount: beatmap.hitObjects.length + beatmap.maniaHolds.length,
        });
        bytes.push(raw);
      } catch {
        // An unparseable difficulty is not offered rather than offered and then failing on select.
      }
    }
    const index = await selectLocalDifficulty(choices, options.chooseDifficulty, file.name);

    osuBytes = bytes[index]!;
    log(`using [${choices[index]!.version}]`);
  } else if (fileName.endsWith('.osu')) {
    osuBytes = new Uint8Array(fileBuffer);
    oszBuffer = await archiveStandaloneOsu(file.name, osuBytes);
  } else {
    throw new Error('choose a .osz, .zip or .osu file');
  }

  const beatmap = parseBeatmap(new TextDecoder().decode(osuBytes));
  log(`generating Auto replay for ${beatmap.title} [${beatmap.version}]…`);
  const hash = md5(osuBytes);
  // Started here and awaited after the session is built: the beatmap is already local, so this
  // lookup has nothing to wait for and no reason to delay playback.
  const starRatingPromise = starRatingForHash(hash);
  const replay = generateAutoReplayForBeatmap(beatmap, hash);
  const session = await buildSession(replay, oszBuffer, options);

  return {
    session,
    startAtMs: 0,
    // No online score behind an Auto replay, so pp stays unknown however the map was obtained.
    panel: resultsDataFromSession(session, {
      fromHeader: false,
      starRating: await starRatingPromise,
    }),
  };
}

/**
 * A beatmap reference, played by a synthesised perfect replay. Login-free: the canonical `.osu`
 * comes from our own proxy and the `.osz` from the public mirrors.
 */
export async function loadAutoFromBeatmap(
  ref: string,
  options: LoadOptions,
): Promise<LoadedReplay> {
  const { log } = options;
  const beatmapId = parseBeatmapRef(ref);
  if (beatmapId === null) throw new Error(`not a beatmap id or URL: ${ref}`);

  log('fetching .osu…');
  const osuBytes = await fetchBeatmapOsu(beatmapId);
  const beatmap = parseBeatmap(new TextDecoder().decode(osuBytes));

  log('finding the beatmap set…');
  const hash = md5(osuBytes);
  // resolveBeatmapInfo rather than setIdForHash: the same lookup already carries the star rating,
  // which the .osu does not, so keeping both costs no extra request.
  const info = await resolveBeatmapInfo(hash);
  const oszBuffer = await downloadBeatmapSet(info.setId, log);

  const replay = generateAutoReplayForBeatmap(beatmap, hash);
  const session = await buildSession(replay, oszBuffer, options);

  return {
    session,
    startAtMs: 0,
    // Synthesised: no header totals to trust, so counts come from the analysis. There is no
    // online score behind an Auto replay, so pp stays unknown.
    panel: resultsDataFromSession(session, { fromHeader: false, starRating: info.starRating }),
  };
}

/**
 * A real online score. Needs the token the captured page holds — see osuApi.ts for why this
 * borrows it rather than running a second login.
 *
 * The `.osr` decides which beatmap to load, not the score metadata: its `beatmapHash` is the MD5
 * of the exact difficulty it was set on, so resolving through the hash cannot land on a
 * re-uploaded or since-edited version the way trusting `beatmap.id` alone could.
 */
export async function loadOnlineScore(
  input: string,
  options: LoadOptions,
): Promise<LoadedReplay> {
  const { log } = options;
  const ref = parseScoreRef(input);
  if (ref === null) throw new Error(`not a score id or URL: ${input}`);

  log('fetching score…');
  // Metadata and the replay in parallel: two independent requests, and the replay is the slow one.
  const [meta, osrBuffer] = await Promise.all([
    // Metadata is a nicety — pp, avatar, star rating. A failure here must not lose a replay that
    // downloaded fine, so it degrades to null rather than rejecting.
    fetchScoreMeta(ref).catch((err: unknown) => {
      console.warn('score metadata unavailable:', err);
      return null as ScoreMeta | null;
    }),
    downloadReplay(ref),
  ]);

  const replay = await parseReplay(osrBuffer);

  log('finding the beatmap…');
  const oszBuffer = await downloadBeatmapSet(await setIdForHash(replay.beatmapHash), log);
  const session = await buildSession(replay, oszBuffer, options);

  return {
    session,
    startAtMs: 0,
    panel: resultsDataFromSession(session, {
      fromHeader: true,
      avatarUrl: meta?.avatarUrl ?? null,
      pp: meta?.pp ?? null,
      starRating: meta?.starRating ?? null,
      playedOn: formatPlayedOn(meta?.endedAt ?? null),
    }),
  };
}

/**
 * Picks the right loader for whatever was typed, so the page carries no branch of its own.
 *
 * A score URL is unmistakable, and a beatmap URL likewise. A bare number is ambiguous — score ids
 * and beatmap ids are both plain integers — so it is treated as a score when a token is available
 * and a beatmap otherwise, which matches what someone pasting an id most likely means in each
 * case.
 */
/**
 * Every replay for one map of a match, ready to hand to `createMatch`.
 *
 * Returns the shared `.osz` alongside the parsed replays rather than building the sessions here:
 * how many canvases exist and where they sit is the UI's business, and `createMatch` needs them
 * up front.
 */
export async function loadMatchMap(
  map: MatchMap,
  log: LogFn,
): Promise<{
  readonly beatmapSet: ArrayBuffer;
  readonly players: readonly { name: string; replay: ReplayData; team: 'red' | 'blue' | null }[];
}> {
  const downloaded = await downloadMatchReplays(map, (done, total, name) => {
    log(`downloading replay ${done + 1}/${total} (${name})…`);
  });
  if (downloaded.length === 0) {
    throw new Error('osu! holds no replays for this map — nothing to watch');
  }

  const players = await Promise.all(downloaded.map(async entry => ({
    name: entry.score.username,
    replay: await parseReplay(entry.osr),
    team: entry.score.team,
  })));

  // The set is resolved from a replay's own beatmapHash rather than from `map.beatmapId`: the
  // hash names the exact difficulty the score was set on, and the room response carries no
  // checksum of its own to check against.
  log('finding the beatmap set…');
  const setId = await setIdForHash(players[0]!.replay.beatmapHash);
  const beatmapSet = await downloadBeatmapSet(setId, log);
  return { beatmapSet, players };
}

export async function loadFromInput(input: string, options: LoadOptions): Promise<LoadedReplay> {
  const trimmed = input.trim();
  if (/\/scores\//i.test(trimmed)) return await loadOnlineScore(trimmed, options);
  if (/beatmapsets?\/|\/beatmaps\//i.test(trimmed)) {
    return await loadAutoFromBeatmap(trimmed, options);
  }
  if (/^\d+$/.test(trimmed)) {
    return isLoggedIn()
      ? await loadOnlineScore(trimmed, options)
      : await loadAutoFromBeatmap(trimmed, options);
  }
  throw new Error('paste an osu! score URL, a beatmap URL, or an id');
}
