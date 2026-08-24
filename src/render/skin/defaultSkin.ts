import { defaultSkinIni, type SkinLayer } from './skinStack';

/**
 * # 默认皮肤的装载
 *
 * 素材放在 `public/skins/default/`(75 个 `@2x` png,来自 `ppy/osu-resources`,
 * CC BY-NC 4.0 —— 见那个目录里的 `NOTICE.md`)。
 *
 * ## 为什么用清单而不是逐个探测
 *
 * 贴图查找要先能回答"有没有这个文件"。若不带清单,`resolveTexture` 每次未命中
 * 都会变成一次 404 —— 一帧里几十个组件,全都要走网络。
 *
 * 所以 `scripts/fetch-default-skin.mjs` **生成** `index.json`(纯文件名数组),
 * 这里一次取回建成 `Set`。生成而非手写:手写必然与磁盘漂移,
 * `defaultSkin.test.ts` 会断言两者一致。
 *
 * ## 字节是懒加载的
 *
 * `SkinLayer.load()` 才发请求。5 MB 素材里一次回放通常只用到十几个组件,
 * 全量预载既慢又浪费 —— 而且解码成 `ImageBitmap` 才是真正的开销所在。
 */

/** 默认皮肤在站点里的位置。Vite 把 `public/` 原样搬到站点根。 */
const DEFAULT_SKIN_BASE = '/skins/default';

/** 清单文件名。与 `scripts/fetch-default-skin.mjs` 里写死的名字一致。 */
export const DEFAULT_SKIN_INDEX = 'index.json';

/**
 * 装载默认皮肤层。
 *
 * @param baseUrl 素材目录,默认 `/skins/default`。测试里可以指向别处。
 * @param fetchImpl 注入点 —— 让测试不必起真服务器。
 *
 * @throws 清单取不到或不是字符串数组时抛出。**刻意不静默降级**:
 *   默认皮肤是兜底层,它没了的话上层"缺贴图就自绘线框"的降级仍然成立,
 *   但那属于**配置错误**(素材没抓 / 部署漏了 `public/`),应该让人看见。
 */
export async function loadDefaultSkin(
  baseUrl: string = DEFAULT_SKIN_BASE,
  fetchImpl: typeof fetch = fetch,
): Promise<SkinLayer> {
  const indexUrl = `${baseUrl}/${DEFAULT_SKIN_INDEX}`;

  const res = await fetchImpl(indexUrl);
  if (!res.ok) {
    throw new Error(
      `取不到默认皮肤清单 ${indexUrl}(HTTP ${res.status})。` +
        '是否忘了运行 `node scripts/fetch-default-skin.mjs`,或部署时漏了 public/ 目录?',
    );
  }

  const parsed: unknown = await res.json();
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'string')) {
    throw new Error(`默认皮肤清单 ${indexUrl} 不是字符串数组。`);
  }

  // 清单里就是小写文件名(脚本按上游文件名落盘,上游全是小写),
  // 但仍然归一一次 —— resolveTexture 假定索引是小写
  const files = new Set((parsed as string[]).map((n) => n.toLowerCase()));

  return {
    name: '默认皮肤',
    ini: defaultSkinIni(),
    files,
    load: async (path) => {
      const url = `${baseUrl}/${path}`;
      const r = await fetchImpl(url);
      if (!r.ok) {
        throw new Error(`默认皮肤缺文件 ${url}(HTTP ${r.status})—— 清单与实际内容不一致。`);
      }
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}

/**
 * 把解包好的 `.osk` 变成一层。
 *
 * 用户皮肤的字节已经在内存里,所以 `load` 是同步查表包成 Promise ——
 * 与默认皮肤的 HTTP 形态统一到同一个接口,上层不必区分。
 */
export function userSkinLayer(
  ini: SkinLayer['ini'],
  files: ReadonlyMap<string, Uint8Array>,
  name = '用户皮肤',
): SkinLayer {
  return {
    name,
    ini,
    files: new Set(files.keys()),
    load: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`${name} 里没有 ${path}。`);
      return bytes;
    },
  };
}
