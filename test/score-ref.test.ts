// A locally opened .osr can only show a real pp figure by asking osu! for the score it was
// submitted as — pp is not in the file and this engine has no difficulty calculator. So the id
// extraction has to be right about three things: lazer keeps the id somewhere different from
// stable, "never submitted" is spelled with two different non-positive values, and legacy ids
// need a ruleset segment that lazer ids must not get.

import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreRefFromReplay } from '../app/player/osuApi.js';
import type { ReplayData } from '../src/index.js';

/** Only the fields scoreRefFromReplay reads; the rest of a ReplayData is irrelevant here. */
function replay(fields: {
  mode?: number;
  replayId?: bigint;
  onlineId?: number | undefined;
  lazerBlock?: boolean;
}): ReplayData {
  const lazerBlock = fields.lazerBlock ?? fields.onlineId !== undefined;
  return {
    mode: fields.mode ?? 0,
    replayId: fields.replayId ?? 0n,
    ...(lazerBlock ? { scoreInfo: { mods: [], online_id: fields.onlineId } } : {}),
  } as unknown as ReplayData;
}

test('a lazer replay is identified by its score block, not the legacy field', () => {
  // Exactly what parsing solo-replay-osu_5129766_7322413578.osr yields: the legacy field is -1
  // and the real id is in the trailing block.
  const ref = scoreRefFromReplay(replay({ replayId: -1n, onlineId: 7322413578 }));
  assert.deepEqual(ref, { id: '7322413578', ruleset: null });
});

test('a lazer id is not given a ruleset segment', () => {
  // The mode is the ruleset it was *played* in; on a convert that is not the beatmap's, and a
  // segment would turn a working solo id into a 404.
  const ref = scoreRefFromReplay(replay({ mode: 1, replayId: -1n, onlineId: 7322413578 }));
  assert.equal(ref?.ruleset, null);
});

test('a stable replay uses the legacy field with its ruleset segment', () => {
  assert.deepEqual(
    scoreRefFromReplay(replay({ mode: 0, replayId: 4213515151n })),
    { id: '4213515151', ruleset: 'osu' },
  );
  assert.deepEqual(
    scoreRefFromReplay(replay({ mode: 3, replayId: 99n })),
    { id: '99', ruleset: 'mania' },
  );
});

test('an unsubmitted replay yields no reference', () => {
  assert.equal(scoreRefFromReplay(replay({})), null, 'stable writes 0');
  assert.equal(scoreRefFromReplay(replay({ replayId: -1n })), null, 'lazer writes -1');
  assert.equal(
    scoreRefFromReplay(replay({ replayId: -1n, onlineId: -1 })), null,
    'lazer writes -1 in the block too when the score never reached the server',
  );
  assert.equal(
    scoreRefFromReplay(replay({ replayId: -1n, lazerBlock: true })), null,
    'a score block that carries no online_id at all',
  );
});

test('a lazer block on an otherwise submitted stable id does not mask the legacy field', () => {
  // Defensive: if a block exists but has no usable id, the legacy field is still the answer.
  assert.deepEqual(
    scoreRefFromReplay(replay({ mode: 2, replayId: 777n, lazerBlock: true })),
    { id: '777', ruleset: 'fruits' },
  );
});

test('an unknown mode falls back to a bare id rather than an invented segment', () => {
  assert.deepEqual(
    scoreRefFromReplay(replay({ mode: 9, replayId: 5n })),
    { id: '5', ruleset: null },
  );
});
