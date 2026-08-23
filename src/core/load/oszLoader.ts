import { unzipSync } from 'fflate';

import { md5OfBytes } from './beatmapHash';

/**
 * `.osz` 解包。
 *
 * `.osz` 就是一个 zip:里面有若干 `.osu`(每个难度一个)、音频、背景图、
 * 以及可选的自定义打击音效。
 *
 * ⚠️ **必须按 MD5 挑难度,不能按难度名或 beatmap id。** 理由:
 * - 一个 `.osz` 里通常有多个难度,`.osr` 只记了谱面的 MD5
 * - 谱面被作者更新过之后,同一个难度名/id 对应的内容会变,MD5 才是唯一凭据
 * - 若镜像站给的是更新后的版本而回放录于旧版,MD5 对不上 —— 这时**应该报错**
 *   而不是硬凑一个难度上去,否则物件与判定会完全错位
 *
 * 实测:`fflate` 解一个 7 MB / 10 条目的 `.osz` 约 140ms(Node 侧),零依赖。
 */

/** zip 里的一个条目。 */
export interface OszEntry {
  /** zip 内的路径(通常就是文件名,osu 的 osz 一般不带目录) */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface OszContents {
  /** 全部 `.osu`,已算好 MD5 */
  readonly beatmaps: readonly (OszEntry & { readonly md5: string })[];
  /** 其余文件,按小写名索引(zip 内大小写与 `.osu` 里写的可能不一致) */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** 音频扩展名。osu 允许 mp3 / ogg / wav。 */
const AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.wav'];

/**
 * 解开 `.osz`。
 *
 * @throws 若不是有效 zip,或里面一个 `.osu` 都没有
 */
export function unpackOsz(data: ArrayBuffer): OszContents {
  const bytes = new Uint8Array(data);

  // zip 的魔数是 "PK\x03\x04"。先自己查一下,好给出比 fflate 更可读的错误
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(
      `不是有效的 .osz(zip):文件开头不是 "PK",而是 ` +
        `[${[...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' ')}]。` +
        '若是从镜像站下载的,可能拿到了一个 HTML 错误页而不是压缩包。',
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    throw new Error('.osz 解压失败,压缩包可能已损坏。', { cause });
  }

  const beatmaps: (OszEntry & { md5: string })[] = [];
  const files = new Map<string, Uint8Array>();

  for (const [name, content] of Object.entries(entries)) {
    // 目录条目内容为空,跳过
    if (name.endsWith('/')) continue;

    files.set(name.toLowerCase(), content);

    if (name.toLowerCase().endsWith('.osu')) {
      beatmaps.push({ name, bytes: content, md5: md5OfBytes(content) });
    }
  }

  if (beatmaps.length === 0) {
    throw new Error(
      `.osz 里没有找到任何 .osu 谱面文件。条目:[${Object.keys(entries).slice(0, 10).join(', ')}]`,
    );
  }

  return { beatmaps, files };
}

/**
 * 按 MD5 挑出对应的谱面。
 *
 * @throws 找不到时抛出,并列出包内实际有哪些难度 —— 这通常意味着镜像站给的
 *   版本与回放录制时的版本不一致(谱面被更新过)
 */
export function pickBeatmapByMd5(contents: OszContents, md5: string): OszEntry {
  const wanted = md5.toLowerCase();
  const hit = contents.beatmaps.find((b) => b.md5 === wanted);
  if (hit) return hit;

  const available = contents.beatmaps
    .map((b) => `    ${b.md5}  ${b.name}`)
    .join('\n');

  throw new Error(
    `.osz 里没有 MD5 为 ${md5} 的谱面。\n` +
      `包内实际有 ${contents.beatmaps.length} 个难度:\n${available}\n` +
      '这通常意味着谱面在回放录制之后被作者更新过 —— 镜像站给的是新版,' +
      '而回放对应旧版。硬套一个难度会让物件与判定完全错位,所以这里拒绝继续。',
  );
}

/**
 * 从包里取音频。
 *
 * `.osu` 的 `AudioFilename` 与 zip 内的实际大小写可能不一致(Windows 上不敏感,
 * 打包时就混了),所以按小写查。找不到时退而求其次:取包内**任意**音频文件 ——
 * 单曲 osz 里通常只有一个,这个退路能救下大小写以外的轻微不一致。
 */
export function findAudio(
  contents: OszContents,
  audioFilename: string,
): { readonly name: string; readonly bytes: Uint8Array } | null {
  const exact = contents.files.get(audioFilename.toLowerCase());
  if (exact) return { name: audioFilename, bytes: exact };

  for (const [name, bytes] of contents.files) {
    if (AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      // 打击音效也是 wav,要排除掉 —— 它们的名字有固定前缀
      if (/^(normal|soft|drum)-/.test(name)) continue;
      return { name, bytes };
    }
  }

  return null;
}

/** 从包里取背景图(M6 的 UI 可能要用)。找不到返回 null。 */
export function findBackground(
  contents: OszContents,
  backgroundPath: string | null,
): { readonly name: string; readonly bytes: Uint8Array } | null {
  if (!backgroundPath) return null;

  const bytes = contents.files.get(backgroundPath.toLowerCase());
  return bytes ? { name: backgroundPath, bytes } : null;
}
