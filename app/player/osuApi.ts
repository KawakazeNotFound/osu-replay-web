/**
 * osu! API calls this page makes, all through our own Worker proxy.
 *
 * Session handling lives in auth.ts, which owns the shared token and its refresh; this module
 * only consumes it. Keeping the two apart means a request path cannot accidentally mutate the
 * session, and auth.ts stays the single place that knows the storage contract with the captured
 * page.
 */

import { accessToken } from './auth.js';
import type { ReplayData } from '../../src/index.js';

/** Thrown when a request needs a session there is none for. */
export class NotLoggedInError extends Error {
  constructor() {
    super('not signed in — press "Login with osu!" first');
    this.name = 'NotLoggedInError';
  }
}

/** A score reference: the numeric id, plus the ruleset when the URL carried one. */
export interface ScoreRef {
  readonly id: string;
  /** Legacy stable scores 404 without the mode prefix, so it is kept when present. */
  readonly ruleset: 'osu' | 'taiko' | 'fruits' | 'mania' | null;
}

/** Parses a score id or an osu! score URL. */
export function parseScoreRef(input: string): ScoreRef | null {
  // Zero-width and BOM marks survive partial edits of pasted URLs and break a bare digit test.
  const s = input.replace(/[\s​-‏﻿]/g, '');
  if (s === '') return null;
  if (/^\d+$/.test(s)) return { id: s, ruleset: null };
  const bare = /^(osu|taiko|fruits|mania)\/(\d+)$/i.exec(s);
  if (bare !== null) {
    return { id: bare[2]!, ruleset: bare[1]!.toLowerCase() as ScoreRef['ruleset'] };
  }
  const url = /\/scores\/(?:(osu|taiko|fruits|mania)\/)?(\d+)/i.exec(s);
  if (url === null) return null;
  return {
    id: url[2]!,
    ruleset: url[1] !== undefined ? url[1].toLowerCase() as ScoreRef['ruleset'] : null,
  };
}

/** Ruleset path segment by `ReplayData.mode`, in osu!'s own order. */
const RULESET_BY_MODE = ['osu', 'taiko', 'fruits', 'mania'] as const;

/**
 * The online score a `.osr` was submitted as, or null when it was never submitted.
 *
 * This is what lets a locally opened replay show a real pp figure: pp is not in the file, and
 * deriving it needs a difficulty calculator this engine does not implement, so the number has to
 * come from the score osu! already recorded. Anything downloaded from osu! — or exported after
 * submitting — carries the id.
 *
 * The two clients write it in different places. lazer puts it in the trailing score block's
 * `online_id` and leaves the legacy header field at -1; stable writes the legacy field and has no
 * block at all. Both are signed, and non-positive when there is no online score, so a plain
 * `> 0` is the test for "was this submitted" in either.
 *
 * Legacy stable ids 404 on `/api/v2/scores/{id}` without the ruleset segment, so it is derived
 * from the replay's own mode. lazer's solo ids resolve bare and are left that way — the replay's
 * mode is the ruleset it was *played* in, which for a convert is not the beatmap's, and guessing
 * a segment there would turn a working id into a 404.
 */
export function scoreRefFromReplay(replay: ReplayData): ScoreRef | null {
  const lazerId = replay.scoreInfo?.online_id;
  if (lazerId !== undefined && lazerId > 0) return { id: String(lazerId), ruleset: null };

  if (replay.replayId > 0n) {
    return { id: replay.replayId.toString(), ruleset: RULESET_BY_MODE[replay.mode] ?? null };
  }
  return null;
}

/**
 * Distinguishes a real auth failure from osu! being unavailable, the same way the captured page
 * does: a genuine 401/403 carries a JSON body, while Cloudflare's block page is HTML. Treating
 * the latter as expiry would tell the user to re-log for no reason.
 */
function describeFailure(response: Response): Error {
  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  if ((response.status === 401 || response.status === 403) && isJson) {
    return new NotLoggedInError();
  }
  if (response.status === 429) {
    // scores_download is 10/min per token; worth naming so it is not mistaken for a bug.
    return new Error('osu! rate limit reached (replay downloads are 10/min) — wait a moment');
  }
  if (response.status === 404) return new Error('no replay available for that score');
  if (response.status >= 500 || !isJson) {
    return new Error(`osu! appears to be having issues (HTTP ${response.status})`);
  }
  return new Error(`request failed (HTTP ${response.status})`);
}

/** Raw `.osr` bytes for a score. Needs only `public` scope. */
export async function downloadReplay(ref: ScoreRef): Promise<ArrayBuffer> {
  const token = await accessToken();
  if (token === null) throw new NotLoggedInError();
  const path = ref.ruleset !== null ? `${ref.ruleset}/${ref.id}` : ref.id;
  const response = await fetch(`/osu-proxy/api/v2/scores/${path}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw describeFailure(response);
  return await response.arrayBuffer();
}

export interface ScoreMeta {
  readonly beatmapId: number;
  readonly beatmapsetId: number;
  readonly userId: number | null;
  readonly username: string | null;
  readonly avatarUrl: string | null;
  readonly pp: number | null;
  readonly starRating: number | null;
  /** ISO timestamp as osu! reports it, or null. */
  readonly endedAt: string | null;
}

/**
 * Score metadata: what the panel shows but a `.osr` does not carry — pp, star rating, the
 * player's avatar, and when it was set.
 *
 * Every field is optional in the result rather than assumed present. A score's `pp` is null for
 * unranked maps and loved maps, and lazer dims the display in that case instead of printing a
 * zero; the panel does the same.
 */
export async function fetchScoreMeta(ref: ScoreRef): Promise<ScoreMeta> {
  const token = await accessToken();
  if (token === null) throw new NotLoggedInError();
  const path = ref.ruleset !== null ? `${ref.ruleset}/${ref.id}` : ref.id;
  const response = await fetch(`/osu-proxy/api/v2/scores/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) throw describeFailure(response);
  const data = await response.json() as Record<string, unknown>;

  const beatmap = (data['beatmap'] ?? {}) as Record<string, unknown>;
  const user = (data['user'] ?? {}) as Record<string, unknown>;
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  const beatmapId = num(beatmap['id']) ?? num(data['beatmap_id']);
  if (beatmapId === null) throw new Error('score response carried no beatmap id');

  return {
    beatmapId,
    beatmapsetId: num(beatmap['beatmapset_id']) ?? 0,
    userId: num(data['user_id']),
    username: str(user['username']),
    avatarUrl: str(user['avatar_url']),
    pp: num(data['pp']),
    // `difficulty_rating` is the *nomod* rating; osu! does not return a mod-adjusted one here,
    // and computing one needs the difficulty calculator this engine does not implement. Shown as
    // is, which is what the beatmap page shows too.
    starRating: num(beatmap['difficulty_rating']),
    endedAt: str(data['ended_at']) ?? str(data['created_at']),
  };
}

/** The canonical `.osu` for a beatmap, via our own proxy. Public — no token needed. */
export async function fetchBeatmapOsu(beatmapId: number): Promise<Uint8Array> {
  const response = await fetch(`/osu-proxy/osu/${beatmapId}`, {
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) throw new Error(`.osu fetch failed (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
