import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import {
  archiveStandaloneOsu, DifficultyCancelled, selectLocalDifficulty,
  type LocalDifficulty,
} from '../app/player/localBeatmap.js';

const choices: readonly LocalDifficulty[] = [
  {
    entry: 'high-ar-low-star.osu', title: 'Song', artist: 'Artist', version: 'Fast sightread',
    mode: 0, approachRate: 10, overallDifficulty: 9, circleSize: 4, objectCount: 40,
  },
  {
    entry: 'lower-ar-real-choice.osu', title: 'Song', artist: 'Artist', version: 'Dense patterns',
    mode: 0, approachRate: 8, overallDifficulty: 8, circleSize: 4, objectCount: 500,
  },
];

test('standalone .osu bytes are wrapped in a valid one-entry archive', async () => {
  const source = new TextEncoder().encode('osu file format v14\n[General]\nMode:0\n');
  const archive = await archiveStandaloneOsu('fixture.osu', source);
  const files = unzipSync(new Uint8Array(archive));

  assert.deepEqual(Object.keys(files), ['fixture.osu']);
  assert.deepEqual(files['fixture.osu'], source);
});

test('multiple difficulties use the picker result rather than an OD/AR heuristic', async () => {
  let offered: readonly LocalDifficulty[] = [];
  const selected = await selectLocalDifficulty(choices, received => {
    offered = received;
    return 1;
  }, 'fixture.osz');

  assert.equal(selected, 1);
  assert.equal(offered, choices);
});

test('multiple difficulties never silently fall back to archive order', async () => {
  await assert.rejects(
    selectLocalDifficulty(choices, undefined, 'fixture.osz'),
    /difficulty picker is required/,
  );
});

test('cancelling the difficulty picker aborts the load without choosing a map', async () => {
  await assert.rejects(
    selectLocalDifficulty(choices, () => null, 'fixture.osz'),
    DifficultyCancelled,
  );
});
