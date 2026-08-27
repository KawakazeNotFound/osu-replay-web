import { unzip, type Unzipped } from 'fflate';
import { md5 } from '../utils/md5.js';

/**
 * Asynchronous unzip via fflate's worker-backed API — keeps large (10–30 MB)
 * archive extraction off the main thread. Rejects on a corrupt archive.
 */
export function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, files) => { if (err) reject(err); else resolve(files); });
  });
}

/**
 * Decoded contents of a beatmap set (`.osz`): the matched `.osu` file's raw bytes,
 * its decoded song audio and background (null when missing or undecodable), and every
 * other decodable audio file (custom hitsounds) keyed by lowercased basename.
 */
export interface BeatmapSetContents {
  osuBytes: Uint8Array;
  audioBuffer: AudioBuffer | null;
  background: ImageBitmap | null;
  beatmapSounds: Map<string, AudioBuffer>;
  /** Text of the set's `.osb`, or null when it has none. */
  osbText: string | null;
  /**
   * Raw (undecoded) bytes of every image in the archive, keyed by lowercased full path with
   * `/` separators — the form storyboard references normalise to.
   *
   * Full path, not basename like `beatmapSounds`: storyboards organise assets into folders
   * (`sb/scene1/x.png`) where basenames collide. Left undecoded because a storyboard can
   * reference many hundreds of images — one surveyed map has 525 — and decoding them all up
   * front would cost seconds and hundreds of MB of bitmaps for sprites that may never appear.
   */
  storyboardImages: Map<string, Uint8Array>;
  /**
   * Decoded audio for storyboard `Sample` events, keyed by lowercased full path with `/`
   * separators. Shares its buffers with `beatmapSounds` — the same files under a key that
   * survives storyboard folders.
   */
  storyboardSamples: Map<string, AudioBuffer>;
}

function extractAudioFilename(osuText: string): string {
  for (const rawLine of osuText.split(/\r?\n/)) {
    const m = /^AudioFilename\s*:\s*(.+)$/i.exec(rawLine.trim());
    if (m) return m[1]!.trim();
  }
  return '';
}

function extractBackgroundFilename(osuText: string): string {
  let inEvents = false;
  for (const rawLine of osuText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.toLowerCase() === '[events]') { inEvents = true; continue; }
    if (line.startsWith('[')) { inEvents = false; continue; }
    if (!inEvents || line === '' || line.startsWith('//')) continue;
    // Standard osu! background line formats in [Events]:
    // 0,0,"bg.jpg",0,0  or  0,0,bg.jpg,0,0  or  Background,0,"bg.jpg"
    const m = /^(?:0|Background)\s*,\s*0\s*,\s*(?:"([^"]+)"|'([^']+)'|([^,\r\n]+))/i.exec(line);
    if (m) {
      const filename = (m[1] || m[2] || m[3] || '').trim();
      if (filename) return filename;
    }
  }
  return '';
}

function findBackgroundImageBytes(
  files: Record<string, Uint8Array>,
  bgFilename: string,
): { bytes: Uint8Array; mime: string } | null {
  const norm = (s: string) => s.toLowerCase().replace(/\\/g, '/');
  const base = (s: string) => norm(s).split('/').pop() ?? norm(s);

  const getMime = (name: string): string => {
    const lower = name.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'image/jpeg';
  };

  const cleanBg = bgFilename.trim().replace(/^["']|["']$/g, '');
  const targetNorm = norm(cleanBg);
  const targetBase = base(cleanBg);

  // 1. Exact normalized path match (e.g. "bg.jpg" or "folder/bg.jpg")
  if (targetNorm !== '') {
    for (const [path, bytes] of Object.entries(files)) {
      if (norm(path) === targetNorm) {
        return { bytes, mime: getMime(path) };
      }
    }
  }

  // 2. Basename match
  if (targetBase !== '') {
    for (const [path, bytes] of Object.entries(files)) {
      if (base(path) === targetBase) {
        return { bytes, mime: getMime(path) };
      }
    }
  }

  // 3. Fallback: standard background naming in archive (e.g. bg.jpg, background.png, cover.jpg)
  const stdPattern = /(?:^|\/)(?:bg|background|cover|banner)\.(?:jpe?g|png|webp)$/i;
  for (const [path, bytes] of Object.entries(files)) {
    if (stdPattern.test(path)) {
      return { bytes, mime: getMime(path) };
    }
  }

  // 4. Fallback: Find the largest image in the root directory (excluding skin elements)
  let bestCandidate: { bytes: Uint8Array; mime: string } | null = null;
  let maxBytes = 0;
  for (const [path, bytes] of Object.entries(files)) {
    const p = norm(path);
    if (!p.includes('/') && /\.(?:jpe?g|png|webp)$/i.test(p)) {
      if (/(?:hitcircle|approachcircle|cursor|default-|slider|comboburst|reversearrow|scorebar|star)/i.test(p)) {
        continue;
      }
      if (bytes.byteLength > maxBytes) {
        maxBytes = bytes.byteLength;
        bestCandidate = { bytes, mime: getMime(path) };
      }
    }
  }

  return bestCandidate;
}

/**
 * Unzips a `.osz` and returns the `.osu` whose MD5 matches `targetHash`, plus its decoded
 * song audio, background image, and custom hitsound samples. `targetHash === ''` accepts
 * the first `.osu` found (hash check skipped). `fetchOsuOverride` is an escape hatch for
 * stale archives (e.g. from a beatmap mirror) whose `.osu` no longer matches the replay
 * hash: it supplies a canonical `.osu` fetched elsewhere — only the `.osu` bytes are
 * replaced; audio/background/hitsounds still come from the archive. Throws when no
 * matching `.osu` can be found.
 */
export async function loadBeatmapSet(
  buffer: ArrayBuffer,
  targetHash: string,
  audioCtx: AudioContext,
  fetchOsuOverride?: () => Promise<Uint8Array>,
): Promise<BeatmapSetContents> {
  const files = await unzipAsync(new Uint8Array(buffer));

  const byName = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    const basename = (path.split('/').pop() ?? path).toLowerCase();
    byName.set(basename, bytes);
  }

  const osuEntries = Object.entries(files).filter(([p]) => p.toLowerCase().endsWith('.osu'));
  if (osuEntries.length === 0) {
    throw new Error('No .osu file found inside the .osz archive.');
  }

  let matchedBytes: Uint8Array | null = null;

  if (targetHash === '') {
    matchedBytes = osuEntries[0]![1];
    console.warn('BeatmapSetLoader: replay has no beatmap hash; using first .osu found.');
  } else {
    for (const [, bytes] of osuEntries) {
      if (md5(bytes) === targetHash) {
        matchedBytes = bytes;
        break;
      }
    }
    if (matchedBytes === null && fetchOsuOverride !== undefined) {
      try {
        const override = await fetchOsuOverride();
        if (md5(override) === targetHash) {
          matchedBytes = override;
          console.warn(
            `BeatmapSetLoader: no .osu in archive matched ${targetHash}; ` +
            `using canonical .osu fetched from osu! (mirror .osz is stale).`,
          );
        } else {
          console.warn('BeatmapSetLoader: override .osu did not match target hash either.');
        }
      } catch (err) {
        console.warn('BeatmapSetLoader: failed to fetch override .osu:', err);
      }
    }
    if (matchedBytes === null) {
      throw new Error(
        `No .osu in this archive matches the replay's beatmap hash (${targetHash}).\n` +
        `Make sure you are loading the correct beatmap set.`
      );
    }
  }

  const osuBytes = matchedBytes;
  const osuText  = new TextDecoder('utf-8').decode(osuBytes);

  const audioFilename = extractAudioFilename(osuText).toLowerCase();
  const bgFilename    = extractBackgroundFilename(osuText).toLowerCase();

  let audioBuffer: AudioBuffer | null = null;
  if (audioFilename !== '') {
    const audioBytes = byName.get(audioFilename);
    if (audioBytes !== undefined) {
      try {
        const copy = audioBytes.buffer.slice(
          audioBytes.byteOffset,
          audioBytes.byteOffset + audioBytes.byteLength,
        ) as ArrayBuffer;
        audioBuffer = await audioCtx.decodeAudioData(copy);
      } catch (err) {
        console.warn('BeatmapSetLoader: could not decode audio file:', err);
      }
    } else {
      console.warn(`BeatmapSetLoader: audio file "${audioFilename}" not found in archive.`);
    }
  }

  let background: ImageBitmap | null = null;
  const bgMatch = findBackgroundImageBytes(files as Record<string, Uint8Array>, bgFilename);
  if (bgMatch !== null) {
    try {
      const blob = new Blob([bgMatch.bytes as Uint8Array<ArrayBuffer>], { type: bgMatch.mime });
      background = await createImageBitmap(blob);
    } catch (err) {
      console.warn('BeatmapSetLoader: could not decode background image:', err);
    }
  }

  const beatmapSounds = new Map<string, AudioBuffer>();
  // Same buffers as beatmapSounds, keyed by full path instead of basename. Storyboard
  // `Sample` events reference paths like `sb/sfx/intro.mp3`, where basenames are ambiguous
  // across folders — but decoding twice would be wasteful, so both maps share the buffers.
  const storyboardSamples = new Map<string, AudioBuffer>();
  // The song itself (audioFilename) is already decoded into audioBuffer above — keep it
  // out of beatmapSounds or it gets decoded a second time and retained as dead PCM.
  const soundEntries = Object.entries(files).filter(([p]) => {
    const lower = p.toLowerCase();
    const basename = (lower.split('/').pop() ?? lower);
    if (basename === audioFilename) return false;
    return lower.endsWith('.wav') || lower.endsWith('.mp3') || lower.endsWith('.ogg');
  });

  await Promise.all(soundEntries.map(async ([path, bytes]) => {
    try {
      const copy = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const audioBuf = await audioCtx.decodeAudioData(copy);
      const basename = (path.split('/').pop() ?? path).toLowerCase();
      beatmapSounds.set(basename, audioBuf);
      storyboardSamples.set(path.toLowerCase().replace(/\\/g, '/'), audioBuf);
    } catch { /* undecodable */ }
  }));

  // Storyboard inputs: the .osb text plus every image, kept raw for lazy decoding. Keyed by
  // full path because storyboard folders (`sb/scene1/...`) make basenames ambiguous.
  let osbText: string | null = null;
  const storyboardImages = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    const lower = path.toLowerCase().replace(/\\/g, '/');
    if (lower.endsWith('.osb')) {
      // A set has one .osb; if several somehow exist, the first is as good a choice as any.
      if (osbText === null) osbText = new TextDecoder().decode(bytes);
      continue;
    }
    if (/\.(png|jpe?g)$/.test(lower)) storyboardImages.set(lower, bytes);
  }

  return {
    osuBytes, audioBuffer, background, beatmapSounds, osbText, storyboardImages,
    storyboardSamples,
  };
}

/**
 * Background-image-only counterpart to `loadBeatmapSet`: matches `targetHash` when
 * possible, otherwise uses the first `.osu`. Returns null on any failure.
 */
export async function extractBeatmapBackground(
  buffer: ArrayBuffer,
  targetHash: string,
): Promise<ImageBitmap | null> {
  const files = await unzipAsync(new Uint8Array(buffer));

  const osuEntries = Object.entries(files).filter(([p]) => p.toLowerCase().endsWith('.osu'));
  if (osuEntries.length === 0) return null;

  let matchedBytes: Uint8Array | null = null;
  if (targetHash !== '') {
    for (const [, bytes] of osuEntries) {
      if (md5(bytes) === targetHash) { matchedBytes = bytes; break; }
    }
  }
  if (matchedBytes === null) matchedBytes = osuEntries[0]![1];

  const osuText    = new TextDecoder('utf-8').decode(matchedBytes);
  const bgFilename = extractBackgroundFilename(osuText).toLowerCase();

  const bgMatch = findBackgroundImageBytes(files as Record<string, Uint8Array>, bgFilename);
  if (bgMatch === null) return null;

  try {
    const blob = new Blob([bgMatch.bytes as Uint8Array<ArrayBuffer>], { type: bgMatch.mime });
    return await createImageBitmap(blob);
  } catch (err) {
    console.warn('extractBeatmapBackground: could not decode background image:', err);
    return null;
  }
}
