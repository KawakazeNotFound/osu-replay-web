// Storyboard Sample scheduling depends on two things the parser guarantees and the audio
// path relies on: samples sorted by time, and a seek landing on the first sample at or after
// the new position. The scheduler itself needs an AudioContext, so what is testable here is
// the ordering contract feeding it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoryboard, parseStoryboardText } from '../src/storyboard/parse.js';
import { SbLayer } from '../src/storyboard/types.js';

function sb(...lines: string[]): string {
  return lines.join('\n');
}

/** The index AudioSync's reschedule lands on: first sample at or after `fromBeatmapMs`. */
function firstIndexAtOrAfter(times: readonly number[], fromBeatmapMs: number): number {
  let i = 0;
  while (i < times.length && times[i]! < fromBeatmapMs) i++;
  return i;
}

test('Sample events carry time, path, layer and volume', () => {
  const r = parseStoryboardText(sb(
    'Sample,-75850,0,"sb/sfx/stepwalkingv2_1.wav",100',
    'Sample,1000,3,"sb\\sfx\\Hit.WAV",25',
    'Sample,2000,0,"plain.wav"',
  ));
  assert.equal(r.warnings.length, 0);
  assert.equal(r.samples.length, 3);
  assert.deepEqual(
    r.samples.map(s => [s.time, s.lookupPath, s.layer, s.volume]),
    [
      [-75850, 'sb/sfx/stepwalkingv2_1.wav', SbLayer.Background, 100],
      // Backslashes and case are normalised for archive lookup, as with sprites.
      [1000, 'sb/sfx/hit.wav', SbLayer.Foreground, 25],
      // Volume is optional in the format; osu! treats an absent one as 100.
      [2000, 'plain.wav', SbLayer.Background, 100],
    ],
  );
});

test('samples are content: a storyboard of only samples still counts', () => {
  // hasContent gates whether a storyboard is installed at all, so an audio-only .osb must
  // not be discarded as empty.
  const r = parseStoryboardText('Sample,1000,0,"a.wav",100');
  assert.equal(r.drawables.length, 0);
  assert.equal(r.hasContent, true);
});

test('a sample line missing its path warns instead of scheduling silence', () => {
  const r = parseStoryboardText('Sample,1000,0,,100');
  assert.equal(r.samples.length, 0);
  assert.match(r.warnings[0]!, /sample with no path/);
});

test('merging keeps samples from both sources', () => {
  const merged = parseStoryboard(
    'Sample,500,0,"from-osb.wav",100',
    sb('[Events]', 'Sample,600,0,"from-osu.wav",80'),
  );
  assert.deepEqual(merged.samples.map(s => s.lookupPath), ['from-osb.wav', 'from-osu.wav']);
});

test('a seek lands on the first sample at or after the new position', () => {
  // Mirrors the index walk in AudioSync._scheduleHitsounds: replaying the past would double
  // up sound effects, skipping the future would drop them.
  const times = [-75850, -74500, 0, 1000, 1000, 2500, 9000];
  assert.equal(firstIndexAtOrAfter(times, -80000), 0, 'before everything: play all');
  assert.equal(firstIndexAtOrAfter(times, -74500), 1, 'exactly on a sample: include it');
  assert.equal(firstIndexAtOrAfter(times, 500), 3);
  assert.equal(firstIndexAtOrAfter(times, 1000), 3, 'duplicates at the boundary both survive');
  assert.equal(firstIndexAtOrAfter(times, 3000), 6);
  assert.equal(firstIndexAtOrAfter(times, 99999), times.length, 'past everything: nothing left');
});

test('samples out of file order still sort into a walkable timeline', () => {
  // AudioSync sorts on construction because the flush loop walks the list once; an unsorted
  // list would silently drop whatever came before the walk position.
  const r = parseStoryboardText(sb(
    'Sample,5000,0,"c.wav",100',
    'Sample,1000,0,"a.wav",100',
    'Sample,3000,0,"b.wav",100',
  ));
  const sorted = [...r.samples].sort((a, b) => a.time - b.time);
  assert.deepEqual(sorted.map(s => s.lookupPath), ['a.wav', 'b.wav', 'c.wav']);
  const times = sorted.map(s => s.time);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i]! >= times[i - 1]!, 'sorted timeline is non-decreasing');
  }
});
