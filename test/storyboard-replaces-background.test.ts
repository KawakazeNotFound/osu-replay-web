// osu! hides the beatmap's static background when the storyboard draws that same image itself,
// on its Background layer. The rule is a *path* match — lazer's DrawableStoryboard
// .ReplacesBackground compares the Background layer's element paths against the beatmap's
// BackgroundFile. Testing "does the Background layer have anything on it" instead hides the
// background for nearly every storyboarded map (they almost all decorate that layer) and leaves
// black behind the storyboard, which is exactly the regression these tests exist to prevent.

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoryboardText } from '../src/storyboard/parse.js';
import { compileDrawable } from '../src/storyboard/evaluate.js';
import { StoryboardAssets } from '../src/storyboard/assets.js';
import { prepareStoryboard } from '../src/renderer/StoryboardRenderer.js';

const VIEW = { logicalWidth: 1280, logicalHeight: 720, widescreen: true };

/** Runs the real pipeline: parse → compile → prepare, as the renderer does. */
function prepare(...lines: string[]) {
  const parsed = parseStoryboardText(lines.join('\n'));
  return prepareStoryboard(
    parsed.drawables.map(compileDrawable),
    new StoryboardAssets(new Map()),
    VIEW,
    parsed.backgroundPath,
  );
}

test('a Background-layer sprite of the beatmap background replaces it', () => {
  const prepared = prepare(
    '[Events]',
    '0,0,"bg.jpg"',
    'Sprite,Background,Centre,"bg.jpg",320,240',
    ' F,0,0,1000,0,1',
  );
  assert.equal(prepared.replacesBackground, true);
});

test('decoration on the Background layer does not replace the beatmap background', () => {
  const prepared = prepare(
    '[Events]',
    '0,0,"bg.jpg"',
    'Sprite,Background,Centre,"sb/asset/ribbon.png",320,240',
    ' F,0,0,1000,0,1',
    'Sprite,Background,Centre,"sb/asset/heart.png",320,240',
    ' F,0,0,1000,0,1',
  );
  assert.equal(
    prepared.replacesBackground, false,
    'the layer is occupied, but not by the beatmap background — it must still draw',
  );
});

test('the match survives Windows separators and case', () => {
  const prepared = prepare(
    '[Events]',
    '0,0,"SB\\BG.JPG"',
    'Sprite,Background,Centre,"sb\\bg.jpg",320,240',
    ' F,0,0,1000,0,1',
  );
  assert.equal(prepared.replacesBackground, true);
});

test('the same image on another layer does not replace the background', () => {
  const prepared = prepare(
    '[Events]',
    '0,0,"bg.jpg"',
    'Sprite,Foreground,Centre,"bg.jpg",320,240',
    ' F,0,0,1000,0,1',
  );
  assert.equal(prepared.replacesBackground, false, 'only the Background layer stands in');
});

test('no background event named means nothing to replace', () => {
  const lines = [
    '[Events]',
    'Sprite,Background,Centre,"bg.jpg",320,240',
    ' F,0,0,1000,0,1',
  ];
  assert.equal(parseStoryboardText(lines.join('\n')).backgroundPath, null);
  assert.equal(prepare(...lines).replacesBackground, false);
});

test('a commandless sprite cannot stand in for the background', () => {
  const prepared = prepare(
    '[Events]',
    '0,0,"bg.jpg"',
    'Sprite,Background,Centre,"bg.jpg",320,240',
  );
  assert.equal(prepared.under.length, 0, 'it never draws, so it is not in the draw list');
  assert.equal(prepared.replacesBackground, false);
});

test('prepareStoryboard without a background path keeps the static background', () => {
  const parsed = parseStoryboardText([
    '[Events]',
    '0,0,"bg.jpg"',
    'Sprite,Background,Centre,"bg.jpg",320,240',
    ' F,0,0,1000,0,1',
  ].join('\n'));
  const prepared = prepareStoryboard(
    parsed.drawables.map(compileDrawable),
    new StoryboardAssets(new Map()),
    VIEW,
  );
  assert.equal(prepared.replacesBackground, false, 'the argument is opt-in');
});
