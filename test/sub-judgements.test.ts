// The sub-judgement breakdown duplicates the score processor's private slider classification, so
// the two are pinned against each other here — if either drifts, the results screen and the score
// beside it would disagree about the same play.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBeatmap } from '../src/parsers/BeatmapParser.js';
import { computeModDifficulty } from '../src/utils/modDifficulty.js';
import { computeHitResults } from '../src/utils/hitJudge.js';
import { computeSubJudgements, sliderSubJudgementsFromResults } from '../src/utils/subJudgements.js';
import { synthesizeAutoReplay } from '../src/utils/autoReplay.js';
import { generateStdAutoReplay } from '../src/rulesets/std/autoGenerator.js';
import type { BeatmapData } from '../src/types/index.js';

/**
 * A minimal .osu with one slider (two slides, so it has a repeat arrow) and one spinner.
 * Written as text rather than assembled as objects so the parser's own derivations apply.
 */
function fixture(options: { slides?: number; spinnerMs?: number; od?: number } = {}): BeatmapData {
  const slides = options.slides ?? 2;
  const spinnerMs = options.spinnerMs ?? 4000;
  const od = options.od ?? 5;
  return parseBeatmap([
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: a.mp3',
    'Mode: 0',
    '',
    '[Difficulty]',
    'HPDrainRate:5',
    'CircleSize:4',
    `OverallDifficulty:${od}`,
    'ApproachRate:9',
    'SliderMultiplier:1.4',
    'SliderTickRate:1',
    '',
    '[TimingPoints]',
    '0,500,4,2,0,60,1,0',
    '',
    '[HitObjects]',
    // x,y,time,type(2=slider),hitSound,curve,slides,length
    `100,100,1000,2,0,L|300:100,${slides},200`,
    // x,y,time,type(8=spinner),hitSound,endTime
    `256,192,6000,8,0,${6000 + spinnerMs}`,
  ].join('\n'));
}

/** An auto replay for a beatmap, which hits everything it can. */
function autoFor(beatmap: BeatmapData) {
  const stub = synthesizeAutoReplay(beatmap, 'hash', [], 0);
  const modDiff = computeModDifficulty(beatmap, stub);
  return synthesizeAutoReplay(beatmap, 'hash', generateStdAutoReplay(beatmap, modDiff), 0);
}

test('a slider contributes one tail plus its ticks and repeats', () => {
  const beatmap = fixture({ slides: 2 });
  const replay = autoFor(beatmap);
  const breakdown = computeSubJudgements(beatmap, replay);

  assert.equal(breakdown.sliderEnd.max, 1, 'one slider, one tail');
  assert.ok(breakdown.sliderTick.max >= 1, 'two slides means at least the repeat arrow');
  // A repeat arrow is a tick-class event in lazer's grouping, not an end.
  assert.ok(
    breakdown.sliderTick.max > breakdown.sliderEnd.max,
    `ticks ${breakdown.sliderTick.max} should exceed ends ${breakdown.sliderEnd.max}`,
  );
});

test('a single-slide slider has no repeat arrow', () => {
  const one = computeSubJudgements(fixture({ slides: 1 }), autoFor(fixture({ slides: 1 })));
  const two = computeSubJudgements(fixture({ slides: 2 }), autoFor(fixture({ slides: 2 })));
  assert.ok(
    two.sliderTick.max > one.sliderTick.max,
    `slides=2 (${two.sliderTick.max}) should offer more ticks than slides=1 (${one.sliderTick.max})`,
  );
  assert.equal(one.sliderEnd.max, 1);
  assert.equal(two.sliderEnd.max, 1, 'slides do not multiply the tail');
});

test('an auto replay achieves every slider sub-judgement it is offered', () => {
  // Auto tracks perfectly, so anything short of full here means the classification is misaligned
  // with the judge's emission order.
  const beatmap = fixture();
  const breakdown = computeSubJudgements(beatmap, autoFor(beatmap));
  assert.equal(breakdown.sliderTick.count, breakdown.sliderTick.max, 'all ticks hit');
  assert.equal(breakdown.sliderEnd.count, breakdown.sliderEnd.max, 'all ends hit');
});

test('counts never exceed their maxima', () => {
  for (const spinnerMs of [1000, 4000, 12000]) {
    const beatmap = fixture({ spinnerMs });
    const b = computeSubJudgements(beatmap, autoFor(beatmap));
    for (const [name, cell] of Object.entries(b)) {
      assert.ok(cell.count <= cell.max, `${name} at ${spinnerMs}ms: ${cell.count}/${cell.max}`);
      assert.ok(cell.count >= 0, `${name} is not negative`);
      assert.ok(Number.isInteger(cell.count) && Number.isInteger(cell.max), `${name} is integral`);
    }
  }
});

test('a longer spinner offers more spins and more bonus', () => {
  const short = computeSubJudgements(fixture({ spinnerMs: 2000 }), autoFor(fixture({ spinnerMs: 2000 })));
  const long = computeSubJudgements(fixture({ spinnerMs: 10000 }), autoFor(fixture({ spinnerMs: 10000 })));
  assert.ok(long.spinnerSpin.max > short.spinnerSpin.max, 'requirement scales with duration');
  assert.ok(long.spinnerBonus.max > short.spinnerBonus.max, 'bonus cap scales with duration');
});

test('a beatmap with no sliders or spinners reports zero, not NaN', () => {
  const bare = parseBeatmap([
    'osu file format v14',
    '[General]', 'Mode: 0',
    '[Difficulty]', 'OverallDifficulty:5', 'ApproachRate:9', 'CircleSize:4',
    'SliderMultiplier:1.4', 'SliderTickRate:1',
    '[TimingPoints]', '0,500,4,2,0,60,1,0',
    '[HitObjects]', '100,100,1000,1,0,0:0:0:0:',
  ].join('\n'));
  const b = computeSubJudgements(bare, autoFor(bare));
  for (const [name, cell] of Object.entries(b)) {
    assert.equal(cell.count, 0, `${name} count`);
    assert.equal(cell.max, 0, `${name} max`);
  }
});

test('the results-only helper agrees with the full computation on sliders', () => {
  // Same classification, two entry points: one re-judges, one takes a stream. A disagreement here
  // is the duplication in subJudgements.ts drifting from itself.
  const beatmap = fixture();
  const replay = autoFor(beatmap);
  const modDiff = computeModDifficulty(beatmap, replay);
  const { results } = computeHitResults(beatmap, replay, modDiff);

  const full = computeSubJudgements(beatmap, replay, modDiff);
  const fromResults = sliderSubJudgementsFromResults(beatmap, results, modDiff.isLazer);
  assert.deepEqual(fromResults.sliderTick, full.sliderTick);
  assert.deepEqual(fromResults.sliderEnd, full.sliderEnd);
});

test('the slider classification covers exactly the judge’s sub-results', () => {
  // The score processor walks sub-results per object against the same ordered list. If the list
  // were shorter than the emitted stream, scoring would silently mis-price the overflow — so the
  // two counts must match exactly.
  const beatmap = fixture();
  const replay = autoFor(beatmap);
  const modDiff = computeModDifficulty(beatmap, replay);
  const { results } = computeHitResults(beatmap, replay, modDiff);

  const emitted = results.filter(r => r.isSliderSub === true).length;
  const b = computeSubJudgements(beatmap, replay, modDiff);
  assert.equal(
    emitted,
    b.sliderTick.max + b.sliderEnd.max,
    'every emitted sub-result has a slot, and every slot is emitted',
  );
});
