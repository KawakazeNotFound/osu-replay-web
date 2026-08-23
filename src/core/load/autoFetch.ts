import { loadBeatmap, type LoadedBeatmap } from './beatmapLoader';
import {
  downloadOsz,
  lookupByMd5,
  type BeatmapLookup,
  type FetchOptions,
  type MirrorProvider,
} from './mirror';
import { findAudio, pickBeatmapByMd5, unpackOsz, type OszContents } from './oszLoader';

/**
 * 自动取谱面:只给一个 `.osr` 头部的 MD5,还回可播放的谱面 + 音频。
 *
 * 三步:镜像站按 MD5 查 beatmapset → 下载 `.osz` → 解包并**按 MD5 挑难度**。
 *
 * ⚠️ 这是**外部服务依赖**。镜像站挂了、或谱面在录制后被更新过(MD5 对不上),
 * 这条路就走不通 —— 此时必须能退回手动上传。所以调用方要处理失败,
 * 不能假定它一定成功。
 */

/** 进度阶段。UI 靠它显示"正在做什么"。 */
export type AutoFetchStage =
  | { readonly kind: 'lookup' }
  | { readonly kind: 'download'; readonly loaded: number; readonly total: number | null }
  | { readonly kind: 'unpack' }
  | { readonly kind: 'parse' };

export interface AutoFetchOptions extends FetchOptions {
  readonly onStage?: (stage: AutoFetchStage) => void;
}

export interface AutoFetchedBeatmap {
  readonly beatmap: LoadedBeatmap;
  /** 该谱面的音频原始字节。null = 包里没找到 */
  readonly audio: { readonly name: string; readonly bytes: Uint8Array } | null;
  /** 镜像站返回的元信息 */
  readonly lookup: BeatmapLookup;
  readonly mirror: MirrorProvider;
  /** 解开的整个包,供后续取背景图等 */
  readonly osz: OszContents;
  readonly oszBytes: number;
}

export async function autoFetchBeatmap(
  beatmapHashMD5: string,
  options: AutoFetchOptions = {},
): Promise<AutoFetchedBeatmap> {
  if (!/^[0-9a-f]{32}$/i.test(beatmapHashMD5)) {
    throw new Error(
      `回放里的谱面哈希不是合法的 MD5:"${beatmapHashMD5}"。` +
        '无法自动取谱面,请手动上传 .osu。',
    );
  }

  options.onStage?.({ kind: 'lookup' });
  const { lookup, mirror } = await lookupByMd5(beatmapHashMD5, options);

  options.onStage?.({ kind: 'download', loaded: 0, total: null });
  const oszBuffer = await downloadOsz(mirror, lookup.beatmapSetId, {
    ...options,
    onProgress: (loaded, total) => options.onStage?.({ kind: 'download', loaded, total }),
  });

  options.onStage?.({ kind: 'unpack' });
  const osz = unpackOsz(oszBuffer);

  // 按 MD5 挑难度 —— 一个 osz 里通常有多个,只有 MD5 能确定是哪个
  const entry = pickBeatmapByMd5(osz, beatmapHashMD5);

  options.onStage?.({ kind: 'parse' });
  const beatmap = await loadBeatmap(
    entry.bytes.buffer.slice(
      entry.bytes.byteOffset,
      entry.bytes.byteOffset + entry.bytes.byteLength,
    ) as ArrayBuffer,
  );

  return {
    beatmap,
    audio: findAudio(osz, beatmap.metadata.audioFilename),
    lookup,
    mirror,
    osz,
    oszBytes: oszBuffer.byteLength,
  };
}

/** 把进度阶段渲染成一句人话。 */
export function describeStage(stage: AutoFetchStage): string {
  switch (stage.kind) {
    case 'lookup':
      return '正在按谱面哈希查询镜像站…';
    case 'download': {
      if (stage.total === null) {
        return `正在下载谱面包… ${formatBytes(stage.loaded)}`;
      }
      const percent = Math.floor((stage.loaded / stage.total) * 100);
      return `正在下载谱面包… ${percent}%(${formatBytes(stage.loaded)} / ${formatBytes(stage.total)})`;
    }
    case 'unpack':
      return '正在解包 .osz…';
    case 'parse':
      return '正在解析谱面…';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
