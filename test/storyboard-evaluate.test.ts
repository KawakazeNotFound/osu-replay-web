// Evaluation is where osu!'s quieter rules live — hold-before/hold-after, instant `P`
// commands lasting for the sprite's life, S vs V sharing one scale vector — so each gets a
// test rather than being trusted to the renderer looking about right.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoryboardText } from '../src/storyboard/parse.js';
import {
  applyEasing, compileDrawable, createSpriteState, evaluateSprite,
} from '../src/storyboard/evaluate.js';

function sb(...lines: string[]): string {
  return lines.join('\n');
}

/** Compiles the first drawable of a storyboard snippet. */
function compileFirst(text: string) {
  const parsed = parseStoryboardText(text);
  assert.equal(parsed.warnings.length, 0, `unexpected warnings: ${parsed.warnings.join('; ')}`);
  assert.ok(parsed.drawables.length > 0, 'expected at least one drawable');
  return compileDrawable(parsed.drawables[0]!);
}

function stateAt(text: string, t: number) {
  return evaluateSprite(compileFirst(text), t, createSpriteState());
}

const NEAR = 1e-9;

test('easing 0 is linear and clamps outside 0–1', () => {
  assert.equal(applyEasing(0, 0.25), 0.25);
  assert.equal(applyEasing(0, -1), 0);
  assert.equal(applyEasing(0, 2), 1);
});

test('legacy easing aliases match their quadratic curves', () => {
  // 1 = Out is OutQuad, 2 = In is InQuad; both are heavily used in real storyboards.
  assert.equal(applyEasing(1, 0.5), applyEasing(4, 0.5));
  assert.equal(applyEasing(2, 0.5), applyEasing(3, 0.5));
  assert.equal(applyEasing(2, 0.5), 0.25);
  assert.equal(applyEasing(1, 0.5), 0.75);
});

test('easing curves hit their endpoints exactly', () => {
  // An easing that misses 0 or 1 shows up as a visible pop at a command boundary.
  for (let id = 0; id <= 34; id++) {
    assert.ok(Math.abs(applyEasing(id, 0) - 0) < 1e-9, `easing ${id} at p=0`);
    assert.ok(Math.abs(applyEasing(id, 1) - 1) < 1e-9, `easing ${id} at p=1`);
  }
});

test('sine and expo easings match their closed forms midway', () => {
  assert.ok(Math.abs(applyEasing(15, 0.5) - (1 - Math.cos(Math.PI / 4))) < NEAR);
  assert.ok(Math.abs(applyEasing(16, 0.5) - Math.sin(Math.PI / 4)) < NEAR);
  assert.ok(Math.abs(applyEasing(19, 0.5) - (1 - 2 ** -5)) < NEAR);
});

test('a fade interpolates, then holds its end value', () => {
  const text = sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,1000,2000,0,1');
  // At exactly 1000 the fade is still at 0, i.e. nothing to draw — null, not a zero-alpha
  // state, so the renderer skips it without a wasted transform.
  assert.equal(stateAt(text, 1000), null);
  assert.equal(stateAt(text, 1500)!.alpha, 0.5);
  assert.equal(stateAt(text, 2000)!.alpha, 1);
});

test('before the first command the first start value holds', () => {
  const text = sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,1000,2000,0.25,1', ' S,0,1000,2000,2,3');
  // t = 1000 is the span start; scale should read its start value, not the default 1.
  assert.equal(stateAt(text, 1000)!.scaleX, 2);
});

test('in a gap between commands the previous end value holds', () => {
  const text = sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' F,0,0,100,0,1',
    ' M,0,0,100,10,10,20,20',
    ' M,0,500,600,50,50,60,60',
  );
  const gap = stateAt(text, 300)!;
  assert.equal(gap.x, 20, 'holds the first move’s end through the gap');
  assert.equal(gap.y, 20);
  const after = stateAt(text, 5000);
  assert.equal(after, null, 'past the sprite’s span it is not drawn at all');
});

test('a sprite with no fade command is fully visible for its life', () => {
  const text = sb('Sprite,Background,Centre,"x.png",0,0', ' M,0,0,100,10,10,20,20');
  assert.equal(stateAt(text, 50)!.alpha, 1);
});

test('a fully transparent sprite evaluates to null', () => {
  const text = sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,0,1000,0,0');
  assert.equal(stateAt(text, 500), null);
});

test('position falls back to the header x/y when nothing moves it', () => {
  const text = sb('Sprite,Background,Centre,"x.png",123,456', ' F,0,0,100,0,1');
  const s = stateAt(text, 50)!;
  assert.deepEqual([s.x, s.y], [123, 456]);
});

test('MX and MY write only their own axis', () => {
  const text = sb(
    'Sprite,Background,Centre,"x.png",100,200',
    ' F,0,0,1000,1,1',
    ' MX,0,0,1000,0,50',
    ' MY,0,0,1000,0,80',
  );
  const s = stateAt(text, 1000)!;
  assert.deepEqual([s.x, s.y], [50, 80]);
});

test('M and MX interleave on the x axis without losing the y from M', () => {
  const text = sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' F,0,0,2000,1,1',
    ' M,0,0,1000,0,10,100,90',
    ' MX,0,1000,2000,100,300',
  );
  const s = stateAt(text, 2000)!;
  assert.equal(s.x, 300, 'the later MX drives x');
  assert.equal(s.y, 90, 'y still holds the M command’s end');
});

test('S is uniform while V is per-axis, sharing one scale vector', () => {
  const uniform = stateAt(sb(
    'Sprite,Background,Centre,"x.png",0,0', ' F,0,0,100,1,1', ' S,0,0,100,1,4',
  ), 100)!;
  assert.deepEqual([uniform.scaleX, uniform.scaleY], [4, 4]);

  const vector = stateAt(sb(
    'Sprite,Background,Centre,"x.png",0,0', ' F,0,0,100,1,1', ' V,0,0,100,1,1,2,5',
  ), 100)!;
  assert.deepEqual([vector.scaleX, vector.scaleY], [2, 5]);

  // A later V overrides an earlier S on both axes.
  const both = stateAt(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' F,0,0,300,1,1',
    ' S,0,0,100,1,3',
    ' V,0,100,200,3,3,1,7',
  ), 200)!;
  assert.deepEqual([both.scaleX, both.scaleY], [1, 7]);
});

test('colour defaults to white and tweens per channel', () => {
  const plain = stateAt(sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,0,100,1,1'), 50)!;
  assert.deepEqual([plain.r, plain.g, plain.b], [255, 255, 255]);

  const tinted = stateAt(sb(
    'Sprite,Background,Centre,"x.png",0,0', ' F,0,0,100,1,1', ' C,0,0,100,0,0,0,255,128,0',
  ), 50)!;
  assert.deepEqual([tinted.r, tinted.g, tinted.b], [127.5, 64, 0]);
});

test('a P command with a duration applies only within it', () => {
  const text = sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,0,3000,1,1', ' P,0,1000,2000,H');
  assert.equal(stateAt(text, 500)!.flipH, false);
  assert.equal(stateAt(text, 1500)!.flipH, true);
  assert.equal(stateAt(text, 2500)!.flipH, false, 'reverts once the command ends');
});

test('an instant P command applies for the rest of the sprite’s life', () => {
  // `P,0,10005,,A` — the form real storyboards use for additive blending.
  const text = sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,0,20000,1,1', ' P,0,10005,,A');
  assert.equal(stateAt(text, 9000)!.additive, false);
  assert.equal(stateAt(text, 10005)!.additive, true);
  assert.equal(stateAt(text, 19000)!.additive, true, 'no duration means it never reverts');
});

test('loops expand to absolute times and repeat the body', () => {
  const compiled = compileFirst(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' L,1000,3',
    '  F,0,0,100,0,1',
  ));
  assert.equal(compiled.alpha.length, 3, 'one segment per repetition');
  assert.deepEqual(compiled.alpha.map(s => s.startTime), [1000, 1100, 1200]);
  assert.equal(compiled.endTime, 1300);

  const out = createSpriteState();
  assert.equal(evaluateSprite(compiled, 1050, out)!.alpha, 0.5);
  assert.equal(evaluateSprite(compiled, 1150, out)!.alpha, 0.5, 'second repetition repeats the fade');
});

test('a loop period covers the whole body, not just one command', () => {
  const compiled = compileFirst(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' L,0,2',
    '  F,0,0,100,0,1',
    '  M,0,0,400,0,0,50,50',
  ));
  // Body length is 400 (the M), so the second repetition starts there, not at 100.
  assert.deepEqual(compiled.alpha.map(s => s.startTime), [0, 400]);
  assert.equal(compiled.endTime, 800);
});

test('animation frames advance and loop', () => {
  const compiled = compileFirst(sb(
    'Animation,Background,Centre,"a.png",0,0,4,100,LoopForever',
    ' F,0,0,1000,1,1',
  ));
  const out = createSpriteState();
  assert.equal(evaluateSprite(compiled, 0, out)!.frameIndex, 0);
  assert.equal(evaluateSprite(compiled, 250, out)!.frameIndex, 2);
  assert.equal(evaluateSprite(compiled, 450, out)!.frameIndex, 0, 'wraps after the last frame');
});

test('LoopOnce animations stop on the final frame', () => {
  const compiled = compileFirst(sb(
    'Animation,Background,Centre,"a.png",0,0,3,100,LoopOnce',
    ' F,0,0,5000,1,1',
  ));
  const out = createSpriteState();
  assert.equal(evaluateSprite(compiled, 250, out)!.frameIndex, 2);
  assert.equal(evaluateSprite(compiled, 4000, out)!.frameIndex, 2, 'holds the last frame');
});

test('triggers are counted rather than fired', () => {
  const compiled = compileFirst(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' F,0,0,100,0,1',
    ' T,HitSoundClap,0,1000',
    '  S,0,0,100,1,2',
  ));
  assert.equal(compiled.skippedTriggers, 1);
  assert.equal(compiled.scale.length, 0, 'the trigger body does not leak into the timeline');
});

test('a sprite with no commands compiles to an empty, never-drawn span', () => {
  const compiled = compileFirst('Sprite,Background,Centre,"x.png",0,0');
  assert.equal(compiled.startTime, Infinity);
  assert.equal(evaluateSprite(compiled, 0, createSpriteState()), null);
});

test('runaway loop expansion is truncated rather than allocating without bound', () => {
  const compiled = compileFirst(sb(
    'Sprite,Background,Centre,"x.png",0,0',
    ' L,0,500000',
    '  F,0,0,10,0,1',
  ));
  assert.equal(compiled.truncated, true);
  assert.ok(compiled.alpha.length <= 20_000, `kept ${compiled.alpha.length} segments`);
});

test('evaluateSprite writes into the passed state and returns it', () => {
  const compiled = compileFirst(sb('Sprite,Background,Centre,"x.png",0,0', ' F,0,0,100,0,1'));
  const out = createSpriteState();
  assert.equal(evaluateSprite(compiled, 50, out), out, 'no per-frame allocation');
});
