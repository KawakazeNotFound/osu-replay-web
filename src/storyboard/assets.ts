/**
 * Lazy image store for storyboard sprites.
 *
 * A storyboard can reference many hundreds of images (one surveyed map: 525), so decoding
 * them all when the session builds would cost seconds of main-thread time and hold hundreds
 * of megabytes of bitmaps — most of them for sprites that appear once, briefly, or never.
 *
 * Instead the archive's raw bytes are kept and each image is decoded the first time it is
 * asked for. `request` is synchronous and returns null until a decode finishes, which suits
 * the render loop: a sprite whose texture is not ready yet is simply skipped for that frame.
 * `prefetch` warms images shortly before they are due so that skip is rarely visible.
 */

export interface StoryboardAssetStats {
  readonly total: number;
  readonly decoded: number;
  readonly pending: number;
  readonly failed: number;
}

/** Concurrent decodes. Enough to keep ahead of playback without monopolising the thread. */
const MAX_IN_FLIGHT = 6;

export class StoryboardAssets {
  private readonly _raw: Map<string, Uint8Array>;
  private readonly _decoded = new Map<string, ImageBitmap>();
  private readonly _failed = new Set<string>();
  private readonly _inFlight = new Set<string>();
  private readonly _queue: string[] = [];
  private _destroyed = false;

  constructor(images: Map<string, Uint8Array>) {
    this._raw = images;
  }

  /**
   * The bitmap for `path` (lowercased, `/`-separated), or null when it is not decoded yet,
   * missing from the archive, or undecodable. Schedules a decode on a miss, so a sprite that
   * was never prefetched still appears a frame or two later rather than never.
   */
  request(path: string): ImageBitmap | null {
    const hit = this._decoded.get(path);
    if (hit !== undefined) return hit;
    this._schedule(path);
    return null;
  }

  /** Warms a batch without needing the result now. */
  prefetch(paths: Iterable<string>): void {
    for (const path of paths) this._schedule(path);
  }

  private _schedule(path: string): void {
    if (this._destroyed) return;
    if (this._decoded.has(path) || this._failed.has(path) || this._inFlight.has(path)) return;
    if (!this._raw.has(path)) {
      // Record misses so a sprite pointing at a file the archive lacks is not retried every
      // frame for the whole song.
      this._failed.add(path);
      return;
    }
    if (this._queue.includes(path)) return;
    this._queue.push(path);
    this._pump();
  }

  private _pump(): void {
    while (this._inFlight.size < MAX_IN_FLIGHT && this._queue.length > 0) {
      const path = this._queue.shift()!;
      void this._decode(path);
    }
  }

  private async _decode(path: string): Promise<void> {
    const bytes = this._raw.get(path);
    if (bytes === undefined) { this._failed.add(path); return; }
    this._inFlight.add(path);
    try {
      const isJpeg = path.endsWith('.jpg') || path.endsWith('.jpeg');
      // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
        type: isJpeg ? 'image/jpeg' : 'image/png',
      });
      const bitmap = await createImageBitmap(blob);
      if (this._destroyed) { bitmap.close(); return; }
      this._decoded.set(path, bitmap);
    } catch {
      this._failed.add(path);
    } finally {
      this._inFlight.delete(path);
      if (!this._destroyed) this._pump();
    }
  }

  stats(): StoryboardAssetStats {
    return {
      total: this._raw.size,
      decoded: this._decoded.size,
      pending: this._inFlight.size + this._queue.length,
      failed: this._failed.size,
    };
  }

  /** Releases every decoded bitmap. The store is unusable afterwards. */
  destroy(): void {
    this._destroyed = true;
    this._queue.length = 0;
    for (const bitmap of this._decoded.values()) bitmap.close();
    this._decoded.clear();
  }
}
