// Covers the format rules that the real .osb files pulled from live beatmaps do NOT
// exercise — sequential shorthand, triggers, underscore indentation, numeric event forms —
// plus the shorthands they lean on heavily, so a regression there is caught here rather
// than by staring at a wrong-looking storyboard.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoryboard, parseStoryboardText, normalisePath } from '../src/storyboard/parse.js';
import { SbLayer, SbOrigin, type SbLoopCommand, type SbTweenCommand } from '../src/storyboard/types.js';

/** Indented with real spaces, as the files are. */
function sb(...lines: string[]): string {
  return lines.join('\n');
}

test('sprite header and its commands', () => {
  const r = parseStoryboardText(sb(
    'Sprite,Foreground,TopRight,"a\\b.png",100,200',
    ' F,0,1000,2000,0,1',
  ));
  assert.equal(r.warnings.length, 0);
  assert.equal(r.drawables.length, 1);
  const d = r.drawables[0]!;
  assert.equal(d.kind, 'sprite');
  assert.equal(d.layer, SbLayer.Foreground);
  assert.equal(d.origin, SbOrigin.TopRight);
  assert.equal(d.path, 'a\\b.png');
  assert.equal(d.lookupPath, 'a/b.png');
  assert.deepEqual([d.x, d.y], [100, 200]);
  assert.deepEqual([d.startTime, d.endTime], [1000, 2000]);
});

test('empty end time means an instant command', () => {
  // Very common in the wild: `C,0,13346,,0,0,0`.
  const r = parseStoryboardText(sb('Sprite,Background,Centre,"x.png",0,0', ' C,0,13346,,0,0,0'));
  const c = r.drawables[0]!.commands[0] as SbTweenCommand;
  assert.equal(c.startTime, 13346);
  assert.equal(c.endTime, 13346);
  assert.deepEqual(c.start, [0, 0, 0]);
  assert.deepEqual(c.end, [0, 0, 0], 'omitted end values hold the start values');
});

test('single value group holds rather than tweens', () => {
  const r = parseStoryboardText(sb('Sprite,Background,Centre,"x.png",0,0', ' S,0,43188,,0.47'));
  const c = r.drawables[0]!.commands[0] as SbTweenCommand;
  assert.deepEqual(c.start, [0.47]);
  assert.deepEqual(c.end, [0.47]);
});

test('sequential shorthand expands into consecutive tweens of equal duration', () => {
  // Three groups on one M: 0→500 (10,10 → 20,20) then 500→1000 (20,20 → 30,30).
  const r = parseStoryboardText(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' M,0,0,500,10,10,20,20,30,30',
  ));
  const cs = r.drawables[0]!.commands as SbTweenCommand[];
  assert.equal(cs.length, 2);
  assert.deepEqual([cs[0]!.startTime, cs[0]!.endTime], [0, 500]);
  assert.deepEqual([cs[0]!.start, cs[0]!.end], [[10, 10], [20, 20]]);
  assert.deepEqual([cs[1]!.startTime, cs[1]!.endTime], [500, 1000]);
  assert.deepEqual([cs[1]!.start, cs[1]!.end], [[20, 20], [30, 30]]);
  assert.deepEqual([r.drawables[0]!.startTime, r.drawables[0]!.endTime], [0, 1000]);
});

test('loop bodies nest, keep relative times, and extend the sprite span', () => {
  const r = parseStoryboardText(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' L,1000,3',
    '  F,0,0,50,0,1',
    '  S,0,0,100,1,2',
    ' M,0,5000,6000,0,0,10,10',
  ));
  assert.equal(r.warnings.length, 0);
  const cs = r.drawables[0]!.commands;
  assert.equal(cs.length, 2, 'loop plus the depth-1 command that follows it');
  const loop = cs[0] as SbLoopCommand;
  assert.equal(loop.kind, 'loop');
  assert.equal(loop.loopCount, 3);
  assert.equal(loop.commands.length, 2, 'both depth-2 lines land in the loop body');
  assert.equal((loop.commands[0] as SbTweenCommand).startTime, 0, 'body times stay relative');
  assert.equal(cs[1]!.kind, 'tween', 'depth-1 line closes the loop');
  // Loop span: 1000 + 100ms body × 3 = 1300; the later M ends at 6000.
  assert.equal(r.drawables[0]!.endTime, 6000);
});

test('loop span expands by loop count', () => {
  const r = parseStoryboardText(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' L,1000,4',
    '  F,0,0,250,0,1',
  ));
  assert.equal(r.drawables[0]!.endTime, 1000 + 250 * 4);
});

test('underscore indentation is equivalent to spaces', () => {
  const r = parseStoryboardText(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    '_L,0,2',
    '__F,0,0,10,0,1',
  ));
  assert.equal(r.warnings.length, 0);
  const loop = r.drawables[0]!.commands[0] as SbLoopCommand;
  assert.equal(loop.kind, 'loop');
  assert.equal(loop.commands.length, 1);
});

test('numeric event, layer and origin forms', () => {
  // 4 = Sprite, 6 = Animation, 5 = Sample; layer 3 = Foreground, origin 1 = Centre.
  const r = parseStoryboardText(sb(
    '4,3,1,"s.png",1,2',
    ' F,0,0,1,0,1',
    '6,0,0,"a.png",3,4,3,80,LoopOnce',
    ' F,0,0,1,0,1',
    '5,7000,0,"hit.wav",70',
  ));
  assert.equal(r.warnings.length, 0);
  assert.equal(r.drawables.length, 2);
  assert.equal(r.drawables[0]!.layer, SbLayer.Foreground);
  assert.equal(r.drawables[0]!.origin, SbOrigin.Centre);
  assert.equal(r.drawables[1]!.kind, 'animation');
  assert.equal(r.samples.length, 1);
  assert.deepEqual(
    { time: r.samples[0]!.time, volume: r.samples[0]!.volume, path: r.samples[0]!.lookupPath },
    { time: 7000, volume: 70, path: 'hit.wav' },
  );
});

test('animation frame paths insert the index before the extension', () => {
  const r = parseStoryboardText(sb(
    'Animation,Background,Centre,"sb\\walk1_.png",0,0,3,50,LoopForever',
    ' F,0,0,1,0,1',
  ));
  const a = r.drawables[0]!;
  assert.equal(a.kind, 'animation');
  if (a.kind !== 'animation') return;
  assert.equal(a.frameCount, 3);
  assert.equal(a.frameDelay, 50);
  assert.equal(a.loopType, 'LoopForever');
  assert.deepEqual(a.framePaths, ['sb/walk1_0.png', 'sb/walk1_1.png', 'sb/walk1_2.png']);
});

test('animation path without an extension appends the index', () => {
  const r = parseStoryboardText(sb(
    'Animation,Background,Centre,"sb\\noext",0,0,2,50,LoopOnce',
    ' F,0,0,1,0,1',
  ));
  const a = r.drawables[0]!;
  if (a.kind !== 'animation') { assert.fail('expected animation'); return; }
  assert.deepEqual(a.framePaths, ['sb/noext0', 'sb/noext1']);
});

test('param and trigger commands', () => {
  const r = parseStoryboardText(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' P,0,1000,2000,A',
    ' T,HitSoundClap,3000,4000,1',
    '  F,0,0,100,0,1',
  ));
  assert.equal(r.warnings.length, 0);
  const [param, trigger] = r.drawables[0]!.commands;
  assert.equal(param!.kind, 'param');
  assert.equal(trigger!.kind, 'trigger');
  if (trigger!.kind !== 'trigger') return;
  assert.equal(trigger.trigger, 'HitSoundClap');
  assert.deepEqual([trigger.startTime, trigger.endTime, trigger.group], [3000, 4000, 1]);
  assert.equal(trigger.commands.length, 1, 'trigger body nests like a loop body');
});

test('background and video events, and breaks left to BeatmapParser', () => {
  const r = parseStoryboardText(sb(
    '0,0,"BG.jpg",0,0',
    'Video,-1500,"clip.mp4"',
    '2,1000,2000',
  ));
  assert.equal(r.backgroundPath, 'BG.jpg');
  assert.equal(r.videoPath, 'clip.mp4');
  assert.equal(r.hasContent, false, 'a background alone is not storyboard content');
  assert.equal(r.warnings.length, 0, 'break rows are skipped silently, not warned about');
});

test('inside a .osu only [Events] is read', () => {
  const r = parseStoryboardText(sb(
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: a.mp3',
    '[Events]',
    'Sprite,Background,Centre,"x.png",0,0',
    ' F,0,0,1,0,1',
    '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:',
  ));
  assert.equal(r.drawables.length, 1);
  // The version header sits before any section, where parsing starts enabled for .osb's
  // sake — it must not be mistaken for a malformed event.
  assert.equal(r.warnings.length, 0, `unexpected warnings: ${r.warnings.join('; ')}`);
});

test('unparseable lines are warned about, not fatal', () => {
  const r = parseStoryboardText(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' Q,0,0,1,5',
    ' F,0,0,1,0,1',
  ));
  assert.equal(r.drawables.length, 1);
  assert.equal(r.drawables[0]!.commands.length, 1, 'the good command still lands');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /unrecognised command/);
});

test('a command before any sprite warns instead of throwing', () => {
  const r = parseStoryboardText(' F,0,0,1,0,1');
  assert.equal(r.drawables.length, 0);
  assert.match(r.warnings[0]!, /no preceding sprite/);
});

test('a sprite with no commands has an empty span and is not dropped', () => {
  // Real files do this (one such sprite in beatmapset 2441621).
  const r = parseStoryboardText('Sprite,Background,Centre,"x.png",0,0');
  assert.equal(r.drawables.length, 1);
  assert.equal(r.drawables[0]!.startTime, Infinity);
  assert.equal(r.drawables[0]!.endTime, -Infinity);
});

test('merging .osb with .osu puts the difficulty-specific objects last', () => {
  const merged = parseStoryboard(
    sb('Sprite,Background,Centre,"from-osb.png",0,0', ' F,0,0,1,0,1'),
    sb('[Events]', '0,0,"diff-bg.jpg"', 'Sprite,Background,Centre,"from-osu.png",0,0', ' F,0,0,1,0,1'),
  );
  assert.deepEqual(merged.drawables.map(d => d.lookupPath), ['from-osb.png', 'from-osu.png']);
  assert.equal(merged.backgroundPath, 'diff-bg.jpg', "the .osu's own background wins");
  assert.equal(merged.warnings.length, 0);
});

test('merging tolerates either side being absent', () => {
  assert.equal(parseStoryboard(null, null).hasContent, false);
  assert.equal(parseStoryboard('Sprite,Background,Centre,"x.png",0,0', null).drawables.length, 1);
  assert.equal(parseStoryboard(null, sb('[Events]', 'Sprite,Background,Centre,"y.png",0,0')).drawables.length, 1);
});

test('negative times are kept — storyboards may start before the audio', () => {
  // beatmapset 2441621 starts at -76000 ms.
  const r = parseStoryboardText(sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,-76000,-75000,0,1'));
  assert.equal(r.drawables[0]!.startTime, -76000);
});

test('normalisePath maps separators and case', () => {
  assert.equal(normalisePath('SB\\Scene1\\A.PNG'), 'sb/scene1/a.png');
});
