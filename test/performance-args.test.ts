// The pp figure shown for a local replay is only as good as the arguments handed to rosu-pp, and a
// wrong argument does not fail — it silently returns a plausible number. So the mapping is pinned
// twice: the shape it produces per ruleset, and an end-to-end run through the real calculator to
// prove rosu-pp actually accepts those field names and that the mods reach it.
//
// The calculator here is the npm package, which is the Node build (it reads its .wasm off disk with
// `fs`). The browser gets the vendored web build instead — same version, different artifact.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { performanceArgsFor } from '../app/player/performance.js';
import type { ReplayData } from '../src/index.js';

// A CJS package: require() rather than a namespace import, whose named exports depend on the
// lexer recognising `module.exports.X = ...` assignments.
const rosu = createRequire(import.meta.url)('rosu-pp-js') as typeof import('rosu-pp-js');

/** Only the fields performanceArgsFor reads. */
function replay(fields: Partial<ReplayData> & { mode?: number }): ReplayData {
  return {
    mode: 0,
    gameVersion: 20240101,
    mods: 0,
    count300: 0, count100: 0, count50: 0, countGeki: 0, countKatu: 0, countMiss: 0,
    maxCombo: 0,
    ...fields,
  } as unknown as ReplayData;
}

test('osu!std maps the four counts and omits the 300+/100+ variants', () => {
  const args = performanceArgsFor(replay({
    mode: 0, count300: 400, count100: 20, count50: 3, countGeki: 90, countKatu: 12,
    countMiss: 1, maxCombo: 500,
  }));
  assert.deepEqual(args, {
    mods: 0, lazer: false, combo: 500, n300: 400, n100: 20, n50: 3, misses: 1,
  });
  // countGeki/countKatu are already inside count300/count100 for std — passing them would be
  // double counting even though rosu-pp ignores them for this mode.
  assert.ok(!('nGeki' in args) && !('nKatu' in args));
});

test('taiko has no 50s to report', () => {
  const args = performanceArgsFor(replay({
    mode: 1, count300: 300, count100: 10, count50: 7, countMiss: 2, maxCombo: 310,
  }));
  assert.deepEqual(args, { mods: 0, lazer: false, combo: 310, n300: 300, n100: 10, misses: 2 });
});

test('catch carries tiny-droplet misses in nKatu', () => {
  const args = performanceArgsFor(replay({
    mode: 2, count300: 200, count100: 30, count50: 400, countKatu: 5, countMiss: 1, maxCombo: 630,
  }));
  assert.deepEqual(args, {
    mods: 0, lazer: false, combo: 630, n300: 200, n100: 30, n50: 400, nKatu: 5, misses: 1,
  });
});

test('mania reads geki as 320 and katu as 200', () => {
  const args = performanceArgsFor(replay({
    mode: 3, countGeki: 1000, count300: 200, countKatu: 40, count100: 20, count50: 5,
    countMiss: 3, maxCombo: 1200,
  }));
  assert.deepEqual(args, {
    mods: 0, lazer: false, combo: 1200,
    nGeki: 1000, n300: 200, nKatu: 40, n100: 20, n50: 5, misses: 3,
  });
});

test('a lazer replay is flagged as lazer and uses its own mod list', () => {
  const args = performanceArgsFor(replay({
    gameVersion: 30000016,
    mods: 64,
    scoreInfo: { mods: [{ acronym: 'DT', settings: { speed_change: 1.4 } }] },
  } as Partial<ReplayData>));
  assert.equal(args['lazer'], true);
  // The acronym list, not the bitmask: the bitmask cannot express a custom speed change.
  assert.deepEqual(args['mods'], [{ acronym: 'DT', settings: { speed_change: 1.4 } }]);
});

test('a lazer replay contributes its slider counts, a stable one has none to give', () => {
  const statistics = { large_tick_hit: 120, slider_tail_hit: 60, small_tick_hit: 4 };
  const lazerArgs = performanceArgsFor(replay({
    gameVersion: 30000016,
    scoreInfo: { mods: [], statistics },
  } as Partial<ReplayData>));
  assert.equal(lazerArgs['largeTickHits'], 120);
  assert.equal(lazerArgs['sliderEndHits'], 60);
  assert.equal(lazerArgs['smallTickHits'], 4);

  // Without these, rosu-pp assumes the best case and inflates pp on a play that dropped slider
  // ends — but a stable replay genuinely has no such data, so they must stay absent.
  const stableArgs = performanceArgsFor(replay({ gameVersion: 20240101 }));
  assert.ok(!('largeTickHits' in stableArgs) && !('sliderEndHits' in stableArgs));
});

test('an empty lazer mod list falls back to the bitmask rather than sending nothing', () => {
  const args = performanceArgsFor(replay({
    gameVersion: 30000016, mods: 16, scoreInfo: { mods: [] },
  } as Partial<ReplayData>));
  assert.equal(args['mods'], 16);
});

/** A playable osu!std map: enough circles on a steady beat for a non-zero star rating. */
function fixtureOsu(objects = 60): string {
  const hitObjects: string[] = [];
  for (let i = 0; i < objects; i++) {
    // Alternating positions so there is real cursor movement to score aim on.
    const x = 100 + (i % 2) * 300;
    const y = 100 + (i % 3) * 120;
    hitObjects.push(`${x},${y},${1000 + i * 300},1,0,0:0:0:0:`);
  }
  return [
    'osu file format v14',
    '',
    '[General]',
    'Mode: 0',
    '',
    '[Difficulty]',
    'HPDrainRate:5',
    'CircleSize:4',
    'OverallDifficulty:8',
    'ApproachRate:9',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[TimingPoints]',
    '1000,300,4,2,0,100,1,0',
    '',
    '[HitObjects]',
    ...hitObjects,
    '',
  ].join('\n');
}

/** pp and stars from the real calculator for a replay of the fixture map. */
function calculate(fields: Partial<ReplayData> & { mode?: number }): { pp: number; stars: number } {
  const map = new rosu.Beatmap(fixtureOsu());
  try {
    const attrs = new rosu.Performance(performanceArgsFor(replay(fields))).calculate(map);
    return { pp: attrs.pp, stars: attrs.difficulty.stars };
  } finally {
    map.free();
  }
}

test('rosu-pp accepts the arguments and returns real numbers', () => {
  const { pp, stars } = calculate({ count300: 60, maxCombo: 60 });
  assert.ok(Number.isFinite(pp) && pp > 0, `pp should be a positive number, got ${pp}`);
  assert.ok(Number.isFinite(stars) && stars > 0, `stars should be positive, got ${stars}`);
});

test('mods reach the calculator — DT is worth more than nomod on the same play', () => {
  const nomod = calculate({ count300: 60, maxCombo: 60 });
  const doubleTime = calculate({ count300: 60, maxCombo: 60, mods: 64 });

  assert.ok(
    doubleTime.stars > nomod.stars,
    `DT should raise the star rating (${nomod.stars} -> ${doubleTime.stars})`,
  );
  assert.ok(
    doubleTime.pp > nomod.pp,
    `DT should raise pp (${nomod.pp} -> ${doubleTime.pp})`,
  );
});

test('misses cost pp — the counts reach the calculator too', () => {
  const clean = calculate({ count300: 60, maxCombo: 60 });
  const dropped = calculate({ count300: 55, countMiss: 5, maxCombo: 20 });

  assert.ok(
    dropped.pp < clean.pp,
    `a play with misses should be worth less (${clean.pp} vs ${dropped.pp})`,
  );
  assert.equal(
    dropped.stars, clean.stars,
    'star rating describes the map, not the play, so it must not move',
  );
});
