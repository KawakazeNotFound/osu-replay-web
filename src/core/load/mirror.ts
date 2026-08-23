/**
 * 谱面镜像站客户端 —— 按 `.osr` 头部的 MD5 自动取回谱面与音频。
 *
 * ## 为什么能在纯浏览器里做
 *
 * ✅ 已实测(2026-08-23,真实 Chrome):`osu.direct` 的两个端点都带 CORS 头
 * (`Access-Control-Allow-Origin` 回显请求方 Origin),且 `content-length` 经
 * `access-control-expose-headers` 暴露出来,所以能做下载进度。
 *
 * 顺带一个交叉验证:该站返回的物件构成(426 circle / 340 slider / 0 spinner)
 * 与我们自己解析同一张图得到的数字完全一致。
 *
 * ## 备用镜像的状态
 *
 * 实测当时 `catboy.best` 返回 502、`api.nerinyan.moe` 返回 530(都是服务端故障,
 * 不是 CORS 问题)。所以**只实现了 osu.direct**,但接口留成可配置的 provider 列表,
 * 将来加备用不必改调用方。
 *
 * ⚠️ 这是**外部服务依赖**:镜像站挂了这个功能就用不了。所以手动上传谱面的路径
 * 必须保留,不能删。
 */

/** 一个镜像站提供者。 */
export interface MirrorProvider {
  readonly name: string;
  /** MD5 → 谱面元信息(含 beatmapset id) */
  lookupUrl(md5: string): string;
  /** beatmapset id → `.osz` 下载地址 */
  downloadUrl(setId: number): string;
  /** 解析 lookup 的响应 */
  parseLookup(json: unknown): BeatmapLookup | null;
}

/** 镜像站返回的谱面元信息。只取我们用得到的字段。 */
export interface BeatmapLookup {
  readonly beatmapId: number;
  readonly beatmapSetId: number;
  /** 难度名 */
  readonly version: string;
  /** ranked / loved / graveyard … */
  readonly status: string;
  readonly artist: string | null;
  readonly title: string | null;
}

/**
 * osu.direct。
 *
 * - lookup:`GET /api/v2/md5/{md5}` → 单个 beatmap 的 JSON
 * - download:`GET /api/d/{setId}` → `.osz`(application/octet-stream)
 */
export const OSU_DIRECT: MirrorProvider = {
  name: 'osu.direct',

  lookupUrl: (md5) => `https://osu.direct/api/v2/md5/${md5}`,
  downloadUrl: (setId) => `https://osu.direct/api/d/${setId}`,

  parseLookup: (json) => {
    if (json === null || typeof json !== 'object') return null;
    const o = json as Record<string, unknown>;

    const beatmapSetId = o['beatmapset_id'];
    const beatmapId = o['id'];
    if (typeof beatmapSetId !== 'number' || typeof beatmapId !== 'number') return null;

    // artist / title 在 beatmapset 子对象里,可能缺
    const set = (o['beatmapset'] ?? {}) as Record<string, unknown>;

    return {
      beatmapId,
      beatmapSetId,
      version: typeof o['version'] === 'string' ? o['version'] : '(unknown)',
      status: typeof o['status'] === 'string' ? o['status'] : '(unknown)',
      artist: typeof set['artist'] === 'string' ? set['artist'] : null,
      title: typeof set['title'] === 'string' ? set['title'] : null,
    };
  },
};

/** 按优先级排列的镜像站。第一个失败就试下一个。 */
export const MIRRORS: readonly MirrorProvider[] = [OSU_DIRECT];

/** 下载进度回调。`total` 为 null 表示服务端没给 content-length。 */
export type ProgressCallback = (loaded: number, total: number | null) => void;

export interface FetchOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressCallback;
  readonly mirrors?: readonly MirrorProvider[];
}

/**
 * 按 MD5 查谱面元信息。
 *
 * 依次尝试各镜像;全部失败时抛出,错误信息里列出每个站的失败原因 ——
 * 这样用户能分辨"网络断了"和"这张图镜像站没有"。
 */
export async function lookupByMd5(
  md5: string,
  options: FetchOptions = {},
): Promise<{ readonly lookup: BeatmapLookup; readonly mirror: MirrorProvider }> {
  const mirrors = options.mirrors ?? MIRRORS;
  const failures: string[] = [];

  for (const mirror of mirrors) {
    try {
      const response = await fetch(mirror.lookupUrl(md5), {
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (response.status === 404) {
        failures.push(`${mirror.name}: 404 —— 该站没有这张谱面`);
        continue;
      }
      if (!response.ok) {
        failures.push(`${mirror.name}: HTTP ${response.status}`);
        continue;
      }

      const parsed = mirror.parseLookup(await response.json());
      if (!parsed) {
        failures.push(`${mirror.name}: 响应格式无法识别`);
        continue;
      }

      return { lookup: parsed, mirror };
    } catch (error) {
      // AbortError 要原样抛出,不能当成"这个站失败了"继续试下一个
      if (error instanceof Error && error.name === 'AbortError') throw error;
      failures.push(`${mirror.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `没有镜像站能提供 MD5 为 ${md5} 的谱面。\n${failures.map((f) => `  - ${f}`).join('\n')}\n` +
      '可以手动上传 .osu 与音频文件继续。',
  );
}

/**
 * 下载 `.osz`。
 *
 * 用流式读取以便报告进度 —— `.osz` 常有几 MB(实测 2.4 MB / 7.1 MB),
 * 没有进度提示会让人以为卡住了。
 */
export async function downloadOsz(
  mirror: MirrorProvider,
  setId: number,
  options: FetchOptions = {},
): Promise<ArrayBuffer> {
  const response = await fetch(mirror.downloadUrl(setId), {
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    throw new Error(`${mirror.name} 下载失败:HTTP ${response.status}(beatmapset ${setId})`);
  }

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader !== null ? Number(lengthHeader) : null;
  const validTotal = total !== null && Number.isFinite(total) && total > 0 ? total : null;

  // 没有 body(理论上不该发生)或不需要进度时,直接整体读
  if (!response.body || !options.onProgress) {
    const buffer = await response.arrayBuffer();
    options.onProgress?.(buffer.byteLength, validTotal);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    chunks.push(value);
    loaded += value.length;
    options.onProgress(loaded, validTotal);
  }

  // 拼成一块连续内存交给 zip 解码
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged.buffer;
}
