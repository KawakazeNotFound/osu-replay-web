// Match-mode helpers that are pure enough to test without a browser: URL parsing, and the
// standings ordering a scoreboard depends on.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoomRef } from '../app/player/matchRoom.js';
import { matchDurationMs } from '../app/player/match.js';

test('parseRoomRef accepts every shape osu! uses for a match', () => {
  assert.equal(parseRoomRef('3255235'), 3255235);
  assert.equal(parseRoomRef('https://osu.ppy.sh/multiplayer/rooms/3255235'), 3255235);
  // The legacy community-matches path is still what older links use.
  assert.equal(parseRoomRef('https://osu.ppy.sh/community/matches/3255235'), 3255235);
  assert.equal(parseRoomRef('  3255235  '), 3255235, 'whitespace is stripped');
});

test('parseRoomRef rejects anything that is not a room', () => {
  assert.equal(parseRoomRef(''), null);
  assert.equal(parseRoomRef('nonsense'), null);
  // A score URL must not be mistaken for a room; they are different endpoints entirely.
  assert.equal(parseRoomRef('https://osu.ppy.sh/scores/1234567'), null);
  assert.equal(parseRoomRef('https://osu.ppy.sh/beatmapsets/123#osu/456'), null);
});

test('parseRoomRef survives the invisible characters pasted URLs carry', () => {
  // Zero-width and BOM marks come through copy-paste and break a bare digit test.
  assert.equal(parseRoomRef('​3255235﻿'), 3255235);
});

/**
 * The ordering `MatchHandle.standings` applies. Reimplemented here rather than imported because
 * the real one needs live sessions; what is worth pinning is the rule, which a scoreboard's
 * correctness depends on.
 */
function rank<T extends { score: number }>(rows: readonly T[]): (T & { position: number })[] {
  return [...rows]
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, position: index + 1 }));
}

test('standings are ordered by score, highest first', () => {
  const ranked = rank([
    { name: 'a', score: 100 },
    { name: 'c', score: 300 },
    { name: 'b', score: 200 },
  ]);
  assert.deepEqual(ranked.map(r => r.name), ['c', 'b', 'a']);
  assert.deepEqual(ranked.map(r => r.position), [1, 2, 3]);
});

test('tied scores keep the order they came in', () => {
  // Reordering equal scores on every refresh would make a live scoreboard flicker between them.
  const ranked = rank([
    { name: 'first', score: 500 },
    { name: 'second', score: 500 },
  ]);
  assert.deepEqual(ranked.map(r => r.name), ['first', 'second']);
});

test('a match runs as long as its longest replay', () => {
  // The audible slot is index 0 and owns the audio, but its replay length is not the match's:
  // taking the duration from it cut the match off while the other player was still going.
  assert.equal(matchDurationMs([84_000, 96_000]), 96_000);
  assert.equal(matchDurationMs([96_000, 84_000]), 96_000, 'order must not matter');
});

test('one replay, or none, still yields a sane duration', () => {
  assert.equal(matchDurationMs([84_000]), 84_000);
  assert.equal(matchDurationMs([]), 0, 'zero rather than -Infinity, which would break the scrubber');
});

test('an early quit does not shorten the match', () => {
  // The case the audibleIndex docs warn about: a slot that quit after 20s alongside a full play.
  assert.equal(matchDurationMs([20_000, 174_000, 174_000]), 174_000);
});
