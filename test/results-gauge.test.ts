// The gauge's corrections are exactly where a "looks about right" port drifts from lazer, so
// each one is pinned here: notch avoidance, the virtual SS region, the visual offset, and the
// badge placements that deliberately do not sit on their own cutoffs.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GRADE_SPACING_PERCENTAGE, VIRTUAL_SS_PERCENTAGE, VISUAL_ALIGNMENT_OFFSET,
  failedSProgress, gaugeProgress, isFailedS, rankBadges,
  type RankCutoffs,
} from '../app/results/accuracyGauge.js';
import { gradedArcs } from '../app/results/accuracyCircle.js';

/** osu!standard cutoffs, injected the way lazer reads them from its ruleset. */
const CUTOFFS: RankCutoffs = { D: 0, C: 0.7, B: 0.8, A: 0.9, S: 0.95, X: 1 };

const HALF = GRADE_SPACING_PERCENTAGE / 2;
const NEAR = 1e-12;

test('a mid-grade accuracy fills to itself, less the visual offset', () => {
  const p = gaugeProgress(0.8844, false, CUTOFFS);
  assert.ok(Math.abs(p - (0.8844 - VISUAL_ALIGNMENT_OFFSET)) < NEAR);
});

test('an accuracy sitting on a grade notch is nudged clear of it', () => {
  // Exactly on the S cutoff: lazer tips it up by half the grade spacing so the fill does not
  // end under the notch.
  const p = gaugeProgress(0.95, false, CUTOFFS);
  assert.ok(Math.abs(p - (0.95 + HALF - VISUAL_ALIGNMENT_OFFSET)) < NEAR, `got ${p}`);
});

test('the nudge direction follows which side of the notch the score is on', () => {
  const below = gaugeProgress(0.95 - HALF / 2, false, CUTOFFS);
  assert.ok(Math.abs(below - (0.95 - HALF - VISUAL_ALIGNMENT_OFFSET)) < NEAR, `got ${below}`);
  const above = gaugeProgress(0.95 + HALF / 2, false, CUTOFFS);
  assert.ok(Math.abs(above - (0.95 + HALF - VISUAL_ALIGNMENT_OFFSET)) < NEAR, `got ${above}`);
});

test('only S/A/B/C are notches — D and SS are not nudged around', () => {
  // lazer's notchPercentages list is [S, A, B, C]; the D cutoff is the ring's origin and SS
  // is handled by its own clamp.
  const atD = gaugeProgress(0, false, CUTOFFS);
  assert.equal(atD, 0, 'zero accuracy stays at zero, no offset applied');
});

test('a non-SS score can never reach into the virtual SS region', () => {
  // 100% accuracy that is not ranked SS — lazer stops it below the SS arc rather than
  // filling the ring and implying a grade the score did not get.
  const p = gaugeProgress(1, false, CUTOFFS);
  const ceiling = CUTOFFS.X - VIRTUAL_SS_PERCENTAGE - HALF;
  assert.ok(Math.abs(p - (ceiling - VISUAL_ALIGNMENT_OFFSET)) < NEAR, `got ${p}`);
  assert.ok(p < 1 - VIRTUAL_SS_PERCENTAGE, 'stays out of the SS region');
});

test('an SS fills the ring completely', () => {
  assert.equal(gaugeProgress(1, true, CUTOFFS), 1);
  // Rank, not accuracy, decides: lazer keys this off ScoreRank.X/XH.
  assert.equal(gaugeProgress(0.9999, true, CUTOFFS), 1);
});

test('the visual offset is skipped when it would push progress negative', () => {
  const tiny = gaugeProgress(VISUAL_ALIGNMENT_OFFSET / 2, false, CUTOFFS);
  assert.equal(tiny, VISUAL_ALIGNMENT_OFFSET / 2, 'left alone below the offset threshold');
});

test('badges sit partway toward the next grade, not on their own cutoff', () => {
  const badges = rankBadges(CUTOFFS);
  assert.deepEqual(badges.map(b => b.rank), ['D', 'C', 'B', 'A', 'S', 'X']);

  const by = (rank: string) => badges.find(b => b.rank === rank)!;
  // Halfway for D/C/B.
  assert.ok(Math.abs(by('D').position - 0.35) < NEAR);
  assert.ok(Math.abs(by('C').position - 0.75) < NEAR);
  assert.ok(Math.abs(by('B').position - 0.85) < NEAR);
  // A and S use 0.25 to avoid colliding with the SS badge.
  assert.ok(Math.abs(by('A').position - (0.9 + (0.95 - 0.9) * 0.25)) < NEAR);
  assert.ok(
    Math.abs(by('S').position - (0.95 + (1 - VIRTUAL_SS_PERCENTAGE - 0.95) * 0.25)) < NEAR,
    `got ${by('S').position}`,
  );
  // SS is the exception: exactly on its cutoff.
  assert.equal(by('X').position, 1);
});

test('each badge keeps its own cutoff as its accuracy, separate from its position', () => {
  // lazer uses badge.Accuracy for appearance timing and the position only for placement;
  // conflating them would make badges pop at the wrong moment.
  for (const b of rankBadges(CUTOFFS)) {
    assert.equal(b.accuracy, CUTOFFS[b.rank], `${b.rank} accuracy`);
    if (b.rank !== 'X') assert.notEqual(b.accuracy, b.position, `${b.rank} position differs`);
  }
});

test('failed S snaps back below the S notch', () => {
  const p = failedSProgress(CUTOFFS);
  assert.ok(p < 0.95, 'lands under the S cutoff');
  assert.ok(Math.abs(p - (0.95 - HALF - VISUAL_ALIGNMENT_OFFSET)) < NEAR);
});

test('failed S is detected by S-level accuracy with an A rank', () => {
  assert.equal(isFailedS(0.96, 'A', CUTOFFS), true);
  assert.equal(isFailedS(0.96, 'S', CUTOFFS), false, 'an actual S is not the failed case');
  assert.equal(isFailedS(0.94, 'A', CUTOFFS), false, 'below S accuracy is just an A');
});

test('graded arcs match GradedCircles.cs span by span', () => {
  // Oracle values computed from GradedCircles.cs's spans inset by GRADE_SPACING_PERCENTAGE/2
  // at both ends. Checked to 6 decimals because the insets are what create the notch gaps —
  // getting them wrong makes the ring look continuous, or leaves visible slivers.
  const arcs = gradedArcs(CUTOFFS);
  assert.deepEqual(arcs.map(a => a.rank), ['D', 'C', 'B', 'A', 'S', 'X']);

  const expected = [
    { rank: 'D', from: 0.002778, to: 0.697222 },
    { rank: 'C', from: 0.702778, to: 0.797222 },
    { rank: 'B', from: 0.802778, to: 0.897222 },
    { rank: 'A', from: 0.902778, to: 0.947222 },
    { rank: 'S', from: 0.952778, to: 0.987222 },
    { rank: 'X', from: 0.992778, to: 0.997222 },
  ];
  for (const [i, want] of expected.entries()) {
    const got = arcs[i]!;
    assert.equal(got.rank, want.rank);
    assert.ok(Math.abs(got.from - want.from) < 1e-6, `${want.rank} from: got ${got.from}`);
    assert.ok(Math.abs(got.to - want.to) < 1e-6, `${want.rank} to: got ${got.to}`);
  }
});

test('the SS arc is exactly the last 1% of the ring', () => {
  // VIRTUAL_SS_PERCENTAGE exists so SS is visible at all; if this span drifted, an SS would
  // either vanish or eat into the S arc.
  const ss = gradedArcs(CUTOFFS).find(a => a.rank === 'X')!;
  assert.ok(ss.from > 1 - VIRTUAL_SS_PERCENTAGE, 'starts inside the final 1%');
  assert.ok(ss.to < 1);
  assert.ok(Math.abs((ss.to - ss.from) - (VIRTUAL_SS_PERCENTAGE - HALF * 2)) < 1e-9);
});

test('every gap between adjacent arcs is exactly the grade spacing', () => {
  const arcs = gradedArcs(CUTOFFS);
  for (let i = 1; i < arcs.length; i++) {
    const gap = arcs[i]!.from - arcs[i - 1]!.to;
    assert.ok(
      Math.abs(gap - GRADE_SPACING_PERCENTAGE) < 1e-9,
      `gap before ${arcs[i]!.rank} was ${gap}`,
    );
  }
});

test('D–S badges land inside their own arc; SS sits at the apex', () => {
  const arcs = gradedArcs(CUTOFFS);
  for (const badge of rankBadges(CUTOFFS)) {
    const arc = arcs.find(a => a.rank === badge.rank)!;
    if (badge.rank === 'X') {
      // lazer places SS with `new RankBadge(accuracyX, accuracyX, …)` — at 1.0, the top of
      // the ring, deliberately outside its own inset arc. Asserting the same invariant as the
      // others here would be asserting something lazer does not do.
      assert.equal(badge.position, 1);
      assert.ok(badge.position > arc.to, 'above its arc, at the ring origin');
      continue;
    }
    assert.ok(
      badge.position >= arc.from && badge.position <= arc.to,
      `${badge.rank} badge at ${badge.position} is outside [${arc.from}, ${arc.to}]`,
    );
  }
});
