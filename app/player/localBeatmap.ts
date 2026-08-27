/** Pure helpers for local Auto-mode beatmap preparation and selection. */

import { zip } from 'fflate';

/** One `.osu` inside a local archive, as offered to the UI's difficulty picker. */
export interface LocalDifficulty {
  /** Entry name inside the archive. */
  readonly entry: string;
  readonly title: string;
  readonly artist: string;
  readonly version: string;
  /** 0 = osu!std, 1 = taiko, 2 = catch, 3 = mania. */
  readonly mode: number;
  readonly approachRate: number;
  readonly overallDifficulty: number;
  readonly circleSize: number;
  readonly objectCount: number;
}

export type ChooseDifficulty = (
  choices: readonly LocalDifficulty[],
) => Promise<number | null> | number | null;

/** Thrown when the user dismisses the difficulty picker. */
export class DifficultyCancelled extends Error {
  constructor() {
    super('difficulty selection cancelled');
    this.name = 'DifficultyCancelled';
  }
}

/** Wraps a standalone `.osu` in the beatmap-set container expected by `createReplaySession`. */
export async function archiveStandaloneOsu(
  fileName: string,
  osuBytes: Uint8Array,
): Promise<ArrayBuffer> {
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    // One entry, no compression: this satisfies the engine's archive contract rather than saving
    // space, and STORE keeps the operation instant even for a large text file.
    zip({ [fileName]: [osuBytes, { level: 0 }] }, (error, data) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    });
  });
}

/** Resolves the picker result without attaching any difficulty meaning to archive order. */
export async function selectLocalDifficulty(
  choices: readonly LocalDifficulty[],
  chooseDifficulty: ChooseDifficulty | undefined,
  archiveName: string,
): Promise<number> {
  if (choices.length === 0) throw new Error('no readable .osu difficulty inside the archive');
  if (choices.length === 1) return 0;
  if (chooseDifficulty === undefined) {
    throw new Error(
      `${archiveName} contains ${choices.length} difficulties; a difficulty picker is required`,
    );
  }

  const picked = await chooseDifficulty(choices);
  if (picked === null) throw new DifficultyCancelled();
  if (!Number.isInteger(picked) || picked < 0 || picked >= choices.length) {
    throw new Error(`chooseDifficulty returned ${String(picked)}, outside 0..${choices.length - 1}`);
  }
  return picked;
}
