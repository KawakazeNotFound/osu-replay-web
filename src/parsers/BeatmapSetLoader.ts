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
    if (line === '[Events]') { inEvents = true; continue; }
    if (line.startsWith('[')) { inEvents = false; continue; }
    if (!inEvents) continue;
    const m = /^0\s*,\s*0\s*,\s*"([^"]+)"/.exec(line);
    if (m) return m[1]!;
  }
  return '';
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
  if (bgFilename !== '') {
    const bgBytes = byName.get(bgFilename);
    if (bgBytes !== undefined) {
      try {
        const isJpg = bgFilename.endsWith('.jpg') || bgFilename.endsWith('.jpeg');
        // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
        const blob  = new Blob([bgBytes as Uint8Array<ArrayBuffer>], { type: isJpg ? 'image/jpeg' : 'image/png' });
        background  = await createImageBitmap(blob);
      } catch (err) {
        console.warn('BeatmapSetLoader: could not decode background image:', err);
      }
    }
  }

  const beatmapSounds = new Map<string, AudioBuffer>();
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
    } catch { /* undecodable */ }
  }));

  return { osuBytes, audioBuffer, background, beatmapSounds };
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

  const byName = new Map<string, Uint8Array>();
  for (const [path, bytes] of Object.entries(files)) {
    const basename = (path.split('/').pop() ?? path).toLowerCase();
    byName.set(basename, bytes);
  }

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
  if (bgFilename === '') return null;

  const bgBytes = byName.get(bgFilename);
  if (bgBytes === undefined) return null;

  try {
    const isJpg = bgFilename.endsWith('.jpg') || bgFilename.endsWith('.jpeg');
    // fflate output is always plain-ArrayBuffer-backed (never SharedArrayBuffer).
    const blob  = new Blob([bgBytes as Uint8Array<ArrayBuffer>], { type: isJpg ? 'image/jpeg' : 'image/png' });
    return await createImageBitmap(blob);
  } catch (err) {
    console.warn('extractBeatmapBackground: could not decode background image:', err);
    return null;
  }
}
