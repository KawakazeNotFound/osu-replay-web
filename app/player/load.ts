/**
 * Turns a replay into the two things the flow needs: a live session, and the numbers the
 * results panel shows.
 *
 * Two entry points for now:
 *  - `loadLocalReplay` — a .osr plus its .osz. Entirely offline, so it works before any OAuth
 *    plumbing exists.
 *  - `loadAutoFromBeatmap` — a beatmap reference, played by a synthesised perfect replay. Uses
 *    only the *public* endpoints (our proxy's `/osu/{id}` and the beatmap mirrors), so it also
 *    needs no token.
 *
 * Fetching a real online *score* needs a `public`-scope bearer token, which this dev page has
 * no way to obtain — the site's token lives in another origin's localStorage. That path lands
 * when this replaces the deployed page and the two share an origin.
 */

import {
  analyzeReplay, buildSkin, computeModDifficulty, createReplaySession, generateStdAutoReplay,
  loadSkinFromDir, md5, parseBeatmap, parseReplay, synthesizeAutoReplay,
  type CoreSession, type Grade, type ReplayData,
} from '../../src/index.js';
import { JUDGEMENT_COLOUR, type ResultsPanelData, type StatisticEntry } from '../results/panel.js';
import type { LoadedReplay } from './flow.js';

/** osu!standard cutoffs, as lazer's ruleset reports them (ScoreProcessor.cs L34-39). */
const CUTOFFS = { D: 0, C: 0.7, B: 0.8, A: 0.9, S: 0.95, X: 1 } as const;

/** Where the sample skin lives on the dev server. */
const SKIN_URL = '/assets/skin';
const LAZER_DEFAULTS_URL = '/assets/lazer-defaults';

export type LogFn = (message: string) => void;

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

/**
 * Panel data from a session.
 *
 * Judgement counts come from the `.osr` header when there is one: osu! wrote those totals, so
 * they are authoritative in a way re-derived counts are not, and a mismatch would mean our judge
 * disagrees with osu! — worth surfacing elsewhere, not worth papering over here. A synthesised
 * auto replay has no header totals, so those are counted from the analysis instead.
 *
 * The sub-judgement row (SLIDER TICK / SLIDER END / SPINNER BONUS / SPINNER SPIN) is left empty
 * on purpose. `HitResult` marks slider sub-judgements with `isSliderSub` but does not separate
 * tick from repeat from tail, and nothing exposes the per-category maxima; the engine computes
 * that split internally (`buildSliderSubKinds`) but keeps it private. Rather than print counts
 * derived from a guess, the row is omitted until the engine exports the classification — the
 * panel already handles an absent row.
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
    starRating: meta.starRating ?? null,
    judgements,
    subJudgements: [],
    playedOn: meta.playedOn ?? null,
  };
}

/** Shared session construction, so both entry points agree on skin and defaults. */
async function buildSession(
  replay: ReplayData,
  oszBuffer: ArrayBuffer,
  audioContext: AudioContext,
  canvas: HTMLCanvasElement,
  log: LogFn,
): Promise<CoreSession> {
  log('loading skin…');
  const skin = await loadSkinFromDir(SKIN_URL, audioContext);
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

/** A .osr with its .osz — no network at all. */
export async function loadLocalReplay(
  osrFile: File,
  oszFile: File | null,
  audioContext: AudioContext,
  canvas: HTMLCanvasElement,
  log: LogFn,
): Promise<LoadedReplay> {
  if (oszFile === null) {
    throw new Error('a .osz is required alongside the .osr in this dev page');
  }
  log('reading files…');
  const [osrBuffer, oszBuffer] = await Promise.all([readFile(osrFile), readFile(oszFile)]);
  const replay = await parseReplay(osrBuffer);
  const session = await buildSession(replay, oszBuffer, audioContext, canvas, log);

  return {
    session,
    startAtMs: 0,
    // A local replay carries no pp and no star rating, and the panel hides both rather than
    // inventing them.
    panel: resultsDataFromSession(session, { fromHeader: true }),
  };
}

/**
 * A beatmap reference, played by a synthesised perfect replay. Mirrors the deployed site's
 * login-free path: canonical `.osu` from our own proxy, `.osz` from the public mirrors.
 */
export async function loadAutoFromBeatmap(
  ref: string,
  audioContext: AudioContext,
  canvas: HTMLCanvasElement,
  log: LogFn,
): Promise<LoadedReplay> {
  const beatmapId = parseBeatmapRef(ref);
  if (beatmapId === null) {
    throw new Error('not a beatmap id or URL — a score URL needs a token this page cannot get');
  }

  log('fetching .osu…');
  const osuResponse = await fetch(`/osu-proxy/osu/${beatmapId}`, { headers: { Accept: 'text/plain' } });
  if (!osuResponse.ok) throw new Error(`.osu fetch failed (HTTP ${osuResponse.status})`);
  const osuBytes = new Uint8Array(await osuResponse.arrayBuffer());
  const osuText = new TextDecoder().decode(osuBytes);
  const beatmap = parseBeatmap(osuText);

  log('finding the beatmap set…');
  const hash = md5(osuBytes);
  const lookup = await fetch(`https://osu.direct/api/v2/md5/${hash}`, {
    headers: { accept: 'application/json' },
  });
  if (!lookup.ok) throw new Error(`md5 lookup failed (HTTP ${lookup.status})`);
  const setId = (await lookup.json() as { beatmapset_id?: number }).beatmapset_id;
  if (typeof setId !== 'number') throw new Error('the mirror does not index this beatmap');

  log('downloading .osz…');
  const oszResponse = await fetch(`https://osu.direct/api/d/${setId}?noVideo=1`);
  if (!oszResponse.ok) throw new Error(`.osz download failed (HTTP ${oszResponse.status})`);
  const oszBuffer = await oszResponse.arrayBuffer();

  // computeModDifficulty reads the *replay* for its mods and lazer-ness, and the generator needs
  // the difficulty — so a frameless stub breaks the cycle. Passing a bare mods number here type-
  // checks as nothing and silently degrades to nomod, which is how an earlier throwaway harness
  // got away with it.
  const stub = synthesizeAutoReplay(beatmap, hash, [], 0);
  const modDiff = computeModDifficulty(beatmap, stub);
  const replay = synthesizeAutoReplay(beatmap, hash, generateStdAutoReplay(beatmap, modDiff), 0);
  const session = await buildSession(replay, oszBuffer, audioContext, canvas, log);

  return {
    session,
    startAtMs: 0,
    // Synthesised: no header totals to trust, so counts come from the analysis.
    panel: resultsDataFromSession(session, { fromHeader: false }),
  };
}

/** Kept under the name the dev page uses, so the online path can grow into a real score fetch. */
export const loadOnlineScore = loadAutoFromBeatmap;
