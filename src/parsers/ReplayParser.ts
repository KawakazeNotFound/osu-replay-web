// Direct lzma_worker import avoids Node.js 'path' dependency in the browser bundle
// (typed by ./lzma_worker.d.ts — the lzma package ships no declarations).
import { LZMA } from 'lzma/src/lzma_worker.js';
import type { ReplayData, ReplayFrame, ScoreInfo } from '../types/index.js';

class OsrReader {
  private view: DataView;
  private offset: number = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  readByte(): number {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  readShort(): number {
    const val = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readInt(): number {
    const val = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readLong(): bigint {
    // Signed int64. Lazer replays may write a negative replayId; FILETIME
    // timestamps are positive in practice so signedness is a no-op there.
    const val = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return val;
  }

  readULEB128(): number {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = this.readByte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  readString(): string {
    const marker = this.readByte();
    if (marker === 0x00) return '';
    if (marker !== 0x0b) {
      throw new Error(`Unexpected string marker: 0x${marker.toString(16)}`);
    }
    const length = this.readULEB128();
    const bytes = new Uint8Array(this.view.buffer, this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }

  readBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.offset, length);
    this.offset += length;
    return bytes;
  }

  bytesRemaining(): number {
    return this.view.byteLength - this.offset;
  }
}

function decompressLzma(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // lzma_worker reads input via `buf[pos] & 255` / `buf.length`, so a Uint8Array works
    // directly — no boxed number[] copy needed.
    LZMA.decompress(
      data,
      (result: number[] | string, error: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof result === 'string') {
          const encoder = new TextEncoder();
          resolve(encoder.encode(result));
        } else {
          resolve(new Uint8Array(result));
        }
      }
    );
  });
}

/**
 * Parses a `.osr` replay file (osu! stable or lazer). Resolves with the header fields,
 * the decoded input frames (millisecond `timeDelta`s, positions in osu!pixels), and —
 * for lazer replays — the trailing JSON `ScoreInfo` block. Rejects on malformed data.
 */
export async function parseReplay(buffer: ArrayBuffer): Promise<ReplayData> {
  const reader = new OsrReader(buffer);

  const mode = reader.readByte();
  const gameVersion = reader.readInt();
  const beatmapHash = reader.readString();
  const username = reader.readString();
  const replayHash = reader.readString();
  const count300 = reader.readShort();
  const count100 = reader.readShort();
  const count50 = reader.readShort();
  const countGeki = reader.readShort();
  const countKatu = reader.readShort();
  const countMiss = reader.readShort();
  const score = reader.readInt();
  const maxCombo = reader.readShort();
  const perfect = reader.readByte() === 1;
  const mods = reader.readInt();
  const lifebarGraph = reader.readString();
  const timestamp = reader.readLong();
  const compressedDataLength = reader.readInt();
  const compressedData = reader.readBytes(compressedDataLength);
  const replayId = reader.readLong();

  // Lazer replays append an LZMA-compressed JSON ScoreInfo block after replayId.
  // Stable replays either have no trailing bytes or a zero-length marker.
  let scoreInfo: ScoreInfo | undefined;
  if (reader.bytesRemaining() >= 4) {
    const scoreInfoLength = reader.readInt();
    if (scoreInfoLength > 0) {
      const scoreInfoBytes = reader.readBytes(scoreInfoLength);
      const scoreInfoJsonBytes = await decompressLzma(scoreInfoBytes);
      const scoreInfoJson = new TextDecoder('utf-8').decode(scoreInfoJsonBytes);
      scoreInfo = JSON.parse(scoreInfoJson) as ScoreInfo;
    }
  }

  const decompressed = await decompressLzma(compressedData);
  const frameText = new TextDecoder('utf-8').decode(decompressed);

  // Lazer's LegacyScoreEncoder writes only M1/M2; stable sets M1+K1 / M2+K2 together,
  // and key-overlay consumers rely on that. Mirror it so lazer presses light keyboard
  // slots. Taiko reuses the bitfield with a different (drum) mapping, so std-only.
  const isLazer = scoreInfo !== undefined || gameVersion >= 30000000;
  const remapLazerKeys = isLazer && mode === 0;

  const rawFrames = frameText.split(',');
  const frames: ReplayFrame[] = [];

  for (const raw of rawFrames) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    if (parts.length < 4) continue;

    const timeDelta = parseInt(parts[0] ?? '0', 10);
    // `-12345|0|0|seed` is the RNG-seed pseudo-frame appended to newer replays; skip it.
    if (timeDelta === -12345) continue;

    const x = parseFloat(parts[1] ?? '0');
    const y = parseFloat(parts[2] ?? '0');
    let keys = parseInt(parts[3] ?? '0', 10);
    if (remapLazerKeys) {
      if (keys & 1) keys |= 4;
      if (keys & 2) keys |= 8;
    }

    frames.push({ timeDelta, x, y, keys });
  }

  return {
    mode,
    gameVersion,
    beatmapHash,
    username,
    replayHash,
    count300,
    count100,
    count50,
    countGeki,
    countKatu,
    countMiss,
    score,
    maxCombo,
    perfect,
    mods,
    lifebarGraph,
    timestamp,
    frames,
    replayId,
    scoreInfo,
  };
}
