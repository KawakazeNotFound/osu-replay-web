/**
 * osu! multiplayer match data: turning a match link into the replays a Match view can play.
 *
 * The room-events route is osu!'s *web* route rather than api/v2 (`/api/v2/rooms/{id}/events`
 * 403s) and needs no token at all; our Worker proxies it only to add CORS. Score *replays*,
 * though, do need a token — so a match can always be listed and only sometimes watched.
 *
 * Note what this response does *not* carry: a beatmap checksum. Its beatmap entries hold only
 * beatmapset_id, difficulty_rating, id, lazer_only, mode, status, total_length, user_id and
 * version. That is fine for playback — each `.osr` carries the MD5 of the exact difficulty it was
 * set on, and `createReplaySession` matches on that — but it means a caller cannot verify the map
 * from the room data alone.
 */

import { downloadReplay, type ScoreRef } from './osuApi.js';
import { isLoggedIn } from './auth.js';

/** A room id out of a bare number or any of osu!'s match URL shapes. */
export function parseRoomRef(input: string): number | null {
  const s = input.replace(/[\s​-‏﻿]/g, '');
  if (s === '') return null;
  if (/^\d+$/.test(s)) return Number(s);
  // Both the lazer multiplayer path and the legacy community-matches path.
  const room = /\/multiplayer\/rooms\/(\d+)/i.exec(s);
  if (room !== null) return Number(room[1]);
  const legacy = /\/community\/matches\/(\d+)/i.exec(s);
  if (legacy !== null) return Number(legacy[1]);
  return null;
}

export type TeamColour = 'red' | 'blue';

/** One player's score on one map of the match. */
export interface MatchScore {
  /** Score id, usable with the replay download. */
  readonly scoreRef: ScoreRef;
  readonly userId: number;
  readonly username: string;
  readonly avatarUrl: string | null;
  /** 0–1. */
  readonly accuracy: number;
  readonly maxCombo: number;
  /** Total score as osu! reports it for this score's own scoring version. */
  readonly totalScore: number;
  readonly rank: string;
  readonly mods: readonly string[];
  /**
   * False when osu! holds no replay for this score — most often an old score whose replay was
   * never stored. Such a player cannot be shown, so the UI should grey them out rather than
   * offering a slot that fails on click.
   */
  readonly hasReplay: boolean;
  readonly team: TeamColour | null;
}

/** One map played during the match. */
export interface MatchMap {
  readonly playlistItemId: number;
  readonly beatmapId: number;
  readonly beatmapsetId: number;
  readonly title: string;
  readonly artist: string;
  readonly version: string;
  readonly coverUrl: string | null;
  /** Scores in the order osu! returned them. */
  readonly scores: readonly MatchScore[];
}

export interface MatchRoom {
  readonly roomId: number;
  readonly name: string;
  /** `team_versus`, `head_to_head`, or whatever else osu! reports. */
  readonly roomType: string;
  /** In play order — osu! returns playlist items newest-first, and this reverses that. */
  readonly maps: readonly MatchMap[];
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Fetches a room and flattens it into maps with their scores.
 *
 * osu! returns the room's beatmaps, beatmapsets, users and playlist items as four parallel
 * lists keyed by id, so this joins them — a score carries only `user_id`, and a playlist item
 * only `beatmap_id`.
 */
export async function fetchMatchRoom(roomId: number): Promise<MatchRoom> {
  const response = await fetch(`/osu-proxy/multiplayer/rooms/${roomId}/events`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error(`no such match room: ${roomId}`);
    throw new Error(`could not read match ${roomId} (HTTP ${response.status})`);
  }
  const data = await response.json() as Record<string, unknown>;

  const room = obj(data['room']);
  const users = new Map<number, Record<string, unknown>>();
  for (const raw of Array.isArray(data['users']) ? data['users'] : []) {
    const user = obj(raw);
    const id = num(user['id']);
    if (id !== null) users.set(id, user);
  }
  const beatmaps = new Map<number, Record<string, unknown>>();
  for (const raw of Array.isArray(data['beatmaps']) ? data['beatmaps'] : []) {
    const beatmap = obj(raw);
    const id = num(beatmap['id']);
    if (id !== null) beatmaps.set(id, beatmap);
  }
  const sets = new Map<number, Record<string, unknown>>();
  for (const raw of Array.isArray(data['beatmapsets']) ? data['beatmapsets'] : []) {
    const set = obj(raw);
    const id = num(set['id']);
    if (id !== null) sets.set(id, set);
  }

  const maps: MatchMap[] = [];
  for (const raw of Array.isArray(data['playlist_items']) ? data['playlist_items'] : []) {
    const item = obj(raw);
    const beatmapId = num(item['beatmap_id']);
    if (beatmapId === null) continue;
    const beatmap = beatmaps.get(beatmapId);
    // A playlist item whose beatmap osu! did not include cannot be played; skipping it is better
    // than surfacing a row that fails on click.
    if (beatmap === undefined) continue;
    const setId = num(beatmap['beatmapset_id']) ?? 0;
    const set = sets.get(setId) ?? {};

    // `teams` is null rather than absent on non-team rooms.
    const details = obj(item['details']);
    const rawTeams = details['teams'];
    const teams = new Map<number, TeamColour>();
    if (rawTeams !== null && rawTeams !== undefined) {
      for (const [key, value] of Object.entries(obj(rawTeams))) {
        const uid = Number(key);
        if (!Number.isFinite(uid)) continue;
        if (value === 'red' || value === 'blue') teams.set(uid, value);
      }
    }

    const scores: MatchScore[] = [];
    for (const rawScore of Array.isArray(item['scores']) ? item['scores'] : []) {
      const score = obj(rawScore);
      // Lazer scores carry `solo_score_id`; legacy ones only `id`.
      const scoreId = num(score['solo_score_id']) ?? num(score['id']);
      const userId = num(score['user_id']);
      if (scoreId === null || userId === null) continue;
      const user = users.get(userId) ?? {};
      const mods = (Array.isArray(score['mods']) ? score['mods'] : [])
        .map(m => str(obj(m)['acronym']))
        .filter((m): m is string => m !== null);
      scores.push({
        // Ruleset left null: match scores are in the lazer namespace, which needs no prefix.
        scoreRef: { id: String(scoreId), ruleset: null },
        userId,
        username: str(user['username']) ?? `user ${userId}`,
        avatarUrl: str(user['avatar_url']),
        accuracy: num(score['accuracy']) ?? 0,
        maxCombo: num(score['max_combo']) ?? 0,
        totalScore: num(score['total_score']) ?? num(score['score']) ?? 0,
        rank: str(score['rank']) ?? 'D',
        mods,
        hasReplay: score['has_replay'] === true,
        team: teams.get(userId) ?? null,
      });
    }

    maps.push({
      playlistItemId: num(item['id']) ?? 0,
      beatmapId,
      beatmapsetId: setId,
      title: str(set['title']) ?? '',
      artist: str(set['artist']) ?? '',
      version: str(beatmap['version']) ?? '',
      coverUrl: str(obj(set['covers'])['cover@2x']) ?? str(obj(set['covers'])['cover']),
      scores,
    });
  }

  // osu! returns playlist items newest-first; the id is monotonic, so ascending is play order.
  maps.sort((a, b) => a.playlistItemId - b.playlistItemId);

  return {
    roomId: num(room['id']) ?? roomId,
    name: str(room['name']) ?? `room ${roomId}`,
    roomType: str(room['type']) ?? 'unknown',
    maps,
  };
}

/** How many of a map's scores could actually be watched right now. */
export function playableCount(map: MatchMap): number {
  if (!isLoggedIn()) return 0;
  return map.scores.filter(s => s.hasReplay).length;
}

/**
 * Downloads the replays for a map's scores.
 *
 * Sequential, not parallel: osu! allows ten replay downloads per minute per token, and a 4v4 map
 * is eight of them — firing those at once is the fastest way to spend the whole budget and get a
 * 429 for the rest of the minute. `onProgress` exists so a caller can say which one it is on.
 */
export async function downloadMatchReplays(
  map: MatchMap,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<readonly { score: MatchScore; osr: ArrayBuffer }[]> {
  const playable = map.scores.filter(s => s.hasReplay);
  const out: { score: MatchScore; osr: ArrayBuffer }[] = [];
  for (const [index, score] of playable.entries()) {
    onProgress?.(index, playable.length, score.username);
    out.push({ score, osr: await downloadReplay(score.scoreRef) });
  }
  return out;
}
