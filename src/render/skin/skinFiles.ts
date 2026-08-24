import { unzipSync } from 'fflate';

import { parseSkinIni, type SkinIni } from './skinIni';

/**
 * # 皮肤文件索引与贴图查找
 *
 * ## 这一层为什么必须存在
 *
 * 参考实现(replayviewer-js)把 `@2x` 回退**复制粘贴到了 8 个渲染文件里**,
 * 每处都是 `images.get(`${stem}@2x.png`) ?? images.get(`${stem}.png`)`。
 * 那样做:
 * - 每个调用点都要自己记得 `@2x` 优先
 * - **拿不到"用了哪一档"** —— 而 @2x 贴图必须按半尺寸画(`ScaleAdjust = 2`),
 *   忘了就会画成两倍大
 * - 少了 lazer 实际有的两个细节(见下)
 *
 * 所以这里集中成一个 resolver,返回**路径 + 缩放分母**。
 *
 * ## 源码(`LegacySkin.GetTexture`,2026-08-24 核)
 *
 * ```csharp
 * Texture? texture = null;
 * float ratio = 1;
 *
 * if (AllowHighResolutionSprites)
 * {
 *     // some component names (especially user-controlled ones, like `HitX` in mania)
 *     // may contain `@2x` scale specifications.
 *     // stable happens to check for that and strip them, so do the same to match stable behaviour.
 *     componentName = componentName.Replace(@"@2x", string.Empty);
 *
 *     string twoTimesFilename = $"{Path.ChangeExtension(componentName, null)}@2x{Path.GetExtension(componentName)}";
 *
 *     texture = Textures?.Get(twoTimesFilename, wrapModeS, wrapModeT);
 *
 *     if (texture != null)
 *         ratio = 2;
 * }
 *
 * texture ??= Textures?.Get(componentName, wrapModeS, wrapModeT);
 *
 * if (texture != null)
 *     texture.ScaleAdjust = ratio;
 * ```
 *
 * 两个参考实现没有的细节:
 *
 * 1. **请求名里自带的 `@2x` 要先剥掉。** 源码注释说明这是为了对齐 stable。
 *    所以 `hitcircle@2x` 与 `hitcircle` 的查找结果完全一样。
 * 2. **`@2x` 插在扩展名之前**:`foo.png` → `foo@2x.png`,不是 `foo.png@2x`。
 *    常见调用是不带扩展名的(`hitcircle`),那时 `Path.GetExtension` 返回空串,
 *    于是变成 `hitcircle@2x`,再由 texture store 去补扩展名。
 */

/** 贴图查找的扩展名顺序。osu 皮肤只有这两种位图格式。 */
const IMAGE_EXTENSIONS = ['.png', '.jpg'] as const;

export interface SkinTexture {
  /** zip 内的路径,小写正斜杠 */
  readonly path: string;
  /**
   * 缩放分母:`2` = @2x(HD)贴图,`1` = SD。
   *
   * 对应 lazer 的 `Texture.ScaleAdjust`。**绘制时必须把像素尺寸除以它**,
   * 否则 HD 皮肤的一切都会大一倍。
   */
  readonly scale: 1 | 2;
}

/**
 * 解开的皮肤。
 *
 * 刻意**只到字节**,不做解码 —— `createImageBitmap` 是浏览器 API,
 * 混进来整个模块就没法在 Node 下测了。解码由调用方按需做。
 */
export interface SkinPackage {
  readonly ini: SkinIni;
  /** 全部文件,键是小写正斜杠路径 */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/**
 * 解开 `.osk`(其实就是 zip)。
 *
 * ⚠️ **只认根目录的 `skin.ini`。** 有些皮肤包里的子目录残留着旧的 `skin.ini`,
 * 那些不该生效。
 *
 * 路径统一成小写正斜杠:zip 里的分隔符可能是 `\`,大小写也常与 ini 里写的不一致
 * (Windows 上不敏感,打包时就混了)。
 *
 * **保留子目录路径**,不压成 basename —— 因为 `[Fonts]` 的前缀可以指向子目录
 * (如 `fonts/hitcircle/default`),压平会与根目录的同名文件撞车。
 */
export function unpackSkin(data: ArrayBuffer): SkinPackage {
  const bytes = new Uint8Array(data);

  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error(
      `不是有效的 .osk(zip):文件开头不是 "PK",而是 ` +
        `[${[...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' ')}]。`,
    );
  }

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    throw new Error('.osk 解压失败,压缩包可能已损坏。', { cause });
  }

  const files = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(entries)) {
    if (name.endsWith('/') || name.endsWith('\\')) continue; // 目录条目
    files.set(name.replace(/\\/g, '/').toLowerCase(), content);
  }

  const iniBytes = files.get('skin.ini');
  const ini = parseSkinIni(iniBytes === undefined ? '' : decodeIni(iniBytes));

  return { ini, files };
}

/**
 * `skin.ini` 的文本解码。
 *
 * 先按 UTF-8 严格解;失败就退回 latin1 —— 老皮肤的 ini 常是本地代码页
 * (作者名里的非 ASCII 会乱码,但**结构不会坏**,总比整个皮肤加载失败好)。
 * 我们只有 Name/Author 是自由文本,其余键值都是 ASCII。
 */
function decodeIni(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/**
 * 按 lazer 的规则查一个贴图。找不到返回 `null`。
 *
 * @param componentName 不带扩展名的组件名(如 `hitcircle`、`sliderb0`),
 *   带扩展名也行。自带的 `@2x` 会被剥掉(与 stable 一致)。
 */
export function resolveTexture(
  files: ReadonlyMap<string, Uint8Array> | ReadonlySet<string>,
  componentName: string,
): SkinTexture | null {
  const has = (path: string): boolean => files.has(path);

  // ⚠️ 先剥掉请求名里的 @2x —— 源码注释:stable 就是这么做的
  const name = componentName.replace(/@2x/g, '');

  const ext = extensionOf(name);
  const stem = ext === '' ? name : name.slice(0, name.length - ext.length);

  // @2x 插在扩展名**之前**
  const hd = findWithExtension(has, `${stem}@2x${ext}`);
  if (hd !== null) return { path: hd, scale: 2 };

  const sd = findWithExtension(has, name);
  return sd === null ? null : { path: sd, scale: 1 };
}

/**
 * 皮肤有没有提供某个数字字体。
 *
 * 核 `LegacySkinExtensions.cs:137`:`source.GetTexture($"{prefix}-0") != null`
 * —— 判据就是"有没有 0 这个字形"。
 */
export function hasFont(
  files: ReadonlyMap<string, Uint8Array> | ReadonlySet<string>,
  prefix: string,
): boolean {
  return resolveTexture(files, `${prefix}-0`) !== null;
}

/** 已知图片扩展名中命中的那个,否则空串。 */
function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? '';
}

/**
 * 补扩展名后查找。名字已带已知扩展名时按原样查。
 *
 * 顺序 `.png` → `.jpg`:与 lazer 的 texture store 一致,也与实际皮肤惯例一致
 * (绝大多数是 png,jpg 只偶见于背景类大图)。
 */
function findWithExtension(has: (path: string) => boolean, name: string): string | null {
  const lower = name.toLowerCase();

  if (extensionOf(lower) !== '') return has(lower) ? lower : null;

  for (const ext of IMAGE_EXTENSIONS) {
    if (has(lower + ext)) return lower + ext;
  }
  return null;
}
