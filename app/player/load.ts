/**
 * Turns a replay into the two things the flow needs: a live session, and the numbers the
 * results panel shows.
 *
 * Three entry points:
 *  - `loadLocalReplay` — a .osr plus its .osz. Entirely offline.
 *  - `loadAutoFromBeatmap` — a beatmap reference, played by a synthesised perfect replay. Only
 *    public endpoints, so no token.
 *  - `loadOnlineScore` — a real score, which needs the token the captured page holds (see
 *    osuApi.ts). Same-origin only, which is why the new UI deploys to /app/.
 *
 * `loadFromInput` picks between them, so the page has one entry rather than a branch of its own.
 */

import {
  analyzeReplay, buildSkin, computeModDifficulty, createReplaySession, generateStdAutoReplay,
  loadSkinFromDir, md5, parseBeatmap, parseReplay, synthesizeAutoReplay,
  type CoreSession, type Grade, type ReplayData,
} from '../../src/index.js';
import { JUDGEMENT_COLOUR, type ResultsPanelData, type StatisticEntry } from '../results/panel.js';
import type { LoadedReplay } from './flow.js';
import {
  downloadReplay, fetchBeatmapOsu, fetchScoreMeta, hasToken, parseScoreRef,
  type ScoreMeta,
} from './osuApi.js';

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

/** Resolves a beatmap MD5 to its set id via osu.direct's public index. */
async function setIdForHash(hash: string): Promise<number> {
  const response = await fetch(`https://osu.direct/api/v2/md5/${hash}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`md5 lookup failed (HTTP ${response.status})`);
  const setId = (await response.json() as { beatmapset_id?: number }).beatmapset_id;
  if (typeof setId !== 'number') throw new Error('the mirror does not index this beatmap');
  return setId;
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
 * A beatmap reference, played by a synthesised perfect replay. Login-free: the canonical `.osu`
 * comes from our own proxy and the `.osz` from the public mirrors.
 */
export async function loadAutoFromBeatmap(
  ref: string,
  audioContext: AudioContext,
  canvas: HTMLCanvasElement,
  log: LogFn,
): Promise<LoadedReplay> {
  const beatmapId = parseBeatmapRef(ref);
  if (beatmapId === null) throw new Error(`not a beatmap id or URL: ${ref}`);

  log('fetching .osu…');
  const osuBytes = await fetchBeatmapOsu(beatmapId);
  const beatmap = parseBeatmap(new TextDecoder().decode(osuBytes));

  log('finding the beatmap set…');
  const hash = md5(osuBytes);
  const oszBuffer = await downloadBeatmapSet(await setIdForHash(hash), log);

  // computeModDifficulty reads the *replay* for its mods and lazer-ness, and the generator needs
  // the difficulty — so a frameless stub breaks the cycle.
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
  audioContext: AudioContext,
  canvas: HTMLCanvasElement,
  log: LogFn,
): Promise<LoadedReplay> {
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
  const session = await buildSession(replay, oszBuffer, audioContext, canvas, log);

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
export async function loadFromInput(
  input: string,
  audioContext: AudioContext,
  canvas: HTMLCanvasElement,
  log: LogFn,
): Promise<LoadedReplay> {
  const trimmed = input.trim();
  if (/\/scores\//i.test(trimmed)) {
    return await loadOnlineScore(trimmed, audioContext, canvas, log);
  }
  if (/beatmapsets?\/|\/beatmaps\//i.test(trimmed)) {
    return await loadAutoFromBeatmap(trimmed, audioContext, canvas, log);
  }
  if (/^\d+$/.test(trimmed)) {
    return hasToken()
      ? await loadOnlineScore(trimmed, audioContext, canvas, log)
      : await loadAutoFromBeatmap(trimmed, audioContext, canvas, log);
  }
  throw new Error('paste an osu! score URL, a beatmap URL, or an id');
}
