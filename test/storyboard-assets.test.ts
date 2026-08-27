// A storyboard survived being built and then vanished, because the renderer's `stop()` used to
// *destroy* its asset store. Stopping is not teardown — the app's flow stops playback on every
// return to the results panel, and once before the first frame is even drawn — so the store has
// to stay usable afterwards. These tests pin that split: `releaseDecoded` frees the bitmaps and
// keeps the store alive; `destroy` ends it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { StoryboardAssets } from '../src/storyboard/assets.js';

/** Minimal ImageBitmap stand-in — the store only ever reads size and calls close(). */
function stubDecoder(): { closed: boolean }[] {
  const created: { closed: boolean }[] = [];
  (globalThis as any).createImageBitmap = async () => {
    const bitmap = { width: 4, height: 4, closed: false, close(): void { this.closed = true; } };
    created.push(bitmap);
    return bitmap;
  };
  return created;
}

function rawStore(): Map<string, Uint8Array> {
  return new Map([['sb/a.png', new Uint8Array([1, 2, 3])]]);
}

/** One macrotask, which is long enough for a stubbed decode's microtasks to settle. */
const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

test('a decode is scheduled on the first request and available on the next turn', async () => {
  stubDecoder();
  const assets = new StoryboardAssets(rawStore());

  assert.equal(assets.request('sb/a.png'), null, 'the first request only schedules');
  await settle();
  assert.notEqual(assets.request('sb/a.png'), null);
  assert.equal(assets.stats().decoded, 1);
});

test('releaseDecoded frees the bitmaps but leaves the store able to decode again', async () => {
  const created = stubDecoder();
  const assets = new StoryboardAssets(rawStore());

  assets.request('sb/a.png');
  await settle();
  assert.notEqual(assets.request('sb/a.png'), null);

  assets.releaseDecoded();
  assert.equal(created[0]!.closed, true, 'the bitmap was closed, not leaked');
  assert.equal(assets.stats().decoded, 0);

  // The regression itself: after a stop, the sprite has to come back.
  assert.equal(assets.request('sb/a.png'), null);
  await settle();
  assert.notEqual(assets.request('sb/a.png'), null, 're-decoded after release');
  assert.equal(assets.stats().failed, 0, 'a released path is not remembered as a failure');
});

test('destroy is final — the store never decodes again', async () => {
  stubDecoder();
  const assets = new StoryboardAssets(rawStore());

  assets.request('sb/a.png');
  await settle();
  assets.destroy();

  assert.equal(assets.request('sb/a.png'), null);
  await settle();
  assert.equal(assets.request('sb/a.png'), null);
  assert.equal(assets.stats().decoded, 0);
});

test('a path the archive lacks is recorded as failed rather than retried forever', async () => {
  stubDecoder();
  const assets = new StoryboardAssets(rawStore());

  assert.equal(assets.request('sb/missing.png'), null);
  assert.equal(assets.stats().failed, 1);
  assert.equal(assets.stats().pending, 0);
});
