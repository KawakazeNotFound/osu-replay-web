import type { Rgb } from '../../core/sim/types';

/**
 * # `skin.ini` 解析
 *
 * ## 为什么单独一层、且刻意保持纯函数
 *
 * 参考实现(replayviewer-js `src/parsers/SkinLoader.ts`)把解析、解压、
 * `createImageBitmap`、`decodeAudioData` 全塞进一个 async 函数里。那样整个模块
 * 在 Node 下跑不了 —— 而我们的纪律是"能测的都要测"。所以这里只做**文本 → 结构**,
 * 一个浏览器 API 都不碰。解压与解码在 `skinFiles.ts` / 调用方。
 *
 * ## 源码依据(2026-08-24 核 ppy/osu)
 *
 * `LegacySkinDecoder.ParseLine` 只亲自处理 `[General]` 的 `Name`/`Author`/`Version`
 * 与 `[CatchTheBeat]`,**其余键一律进 `ConfigDictionary[key] = value`(纯字符串)**,
 * 类型转换推迟到读取时(`LegacySkin.genericLookup`)。我们照这个结构来:
 * 具名字段只放确实用到的,其余留在 {@link SkinIni.raw} 里,以后要什么取什么。
 *
 * ### `[Colours]` 丢弃 alpha
 *
 * `LegacySkinDecoder` 对 `Section.Colours` **不拦截**,直接落到基类:
 * `LegacyDecoder.ParseLine` 里是 `HandleColours(output, line, false)` ——
 * `allowAlpha == false` ⇒ 四分量写法里的 alpha 被丢弃、恒为 255。
 * (只有这里亲自处理的 `[CatchTheBeat]` 传 `true`。)
 *
 * 所以皮肤配色与谱面配色**同样**没有 alpha,`Rgb` 类型两边通用。
 *
 * ### `Version` 的默认是 1.0,不是 latest
 *
 * ```csharp
 * case @"Version":
 *     if (pair.Value == "latest") { skin.LegacyVersion = SkinConfiguration.LATEST_VERSION; skin.IsLatestVersion = true; }
 *     else if (decimal.TryParse(pair.Value, ..., CultureInfo.InvariantCulture, out decimal version)) { ... }
 * ```
 * 而 `CreateTemplateObject()` 里 `config.LegacyVersion = 1.0m`。
 * 也就是说**没写 `Version` 的皮肤是 1.0**,不是最新版 —— 这个差别有实际后果:
 * `LegacyMainCirclePiece.cs:183` 用 `legacyVersion > 1.0m` 决定圈内数字是
 * "短淡出 60ms 不缩放"还是"跟其他部件一样淡出并放大"。
 */

/** `LATEST_VERSION`,核 `SkinConfiguration.cs`:`public const decimal LATEST_VERSION = 2.7m;` */
export const LATEST_SKIN_VERSION = 2.7;

/** 没写 `Version` 时的取值。核 `LegacySkinDecoder.CreateTemplateObject()`。 */
export const DEFAULT_SKIN_VERSION = 1.0;

/**
 * 数字字体的前缀与字距默认值。
 *
 * 核 `LegacySkinExtensions.cs:140-185`:
 *
 * ```csharp
 * GetFontPrefix:  Score → "score" | Combo → "score" | HitCircle → "default" | ScoreEntry → "scoreentry"
 * GetFontOverlap: Score → 0f      | Combo → 0f      | HitCircle → -2f       | ScoreEntry → 1
 * ```
 *
 * ⚠️ **overlap 的默认值按字体不同** —— 只有 HitCircle 是 `-2`,Score 与 Combo 是 `0`。
 * 参考实现只建模了一个 `hitCircleOverlap: -2`,套到 score / combo 上会让数字挤在一起。
 */
export const FONT_DEFAULTS = {
  hitCirclePrefix: 'default',
  hitCircleOverlap: -2,
  scorePrefix: 'score',
  scoreOverlap: 0,
  comboPrefix: 'score',
  comboOverlap: 0,
} as const;

export interface SkinIni {
  readonly name: string;
  readonly author: string;

  /**
   * `[General] Version`。`"latest"` 解析成 {@link LATEST_SKIN_VERSION};
   * 缺失或解析失败则是 {@link DEFAULT_SKIN_VERSION}。
   */
  readonly version: number;
  /** 该皮肤是否显式写了 `Version: latest`。对应 lazer 的 `IsLatestVersion`。 */
  readonly isLatestVersion: boolean;

  /** `[Colours]` 的 `Combo1..ComboN`,按**文件出现顺序**。见 {@link parseSkinIni}。 */
  readonly comboColours: readonly Rgb[];
  readonly sliderBorder: Rgb | null;
  readonly sliderTrackOverride: Rgb | null;

  readonly hitCirclePrefix: string;
  readonly hitCircleOverlap: number;
  readonly scorePrefix: string;
  readonly scoreOverlap: number;
  readonly comboPrefix: string;
  readonly comboOverlap: number;

  /**
   * 其余所有键值,**原样存字符串**,键保留原始大小写。
   *
   * 对应 lazer 的 `SkinConfiguration.ConfigDictionary` —— 它同样不在解析期做
   * 类型转换。这样以后要 `AllowSliderBallTint` / `AnimationFramerate` /
   * `LayeredHitSounds` 之类,不必回来改解析器。
   */
  readonly raw: ReadonlyMap<string, string>;
}

/** combo 色上限。核 `LegacyDecoder`:`public const int MAX_COMBO_COLOUR_COUNT = 8;` */
const MAX_COMBO_COLOUR_COUNT = 8;

/**
 * 解析 `skin.ini`。
 *
 * ## 行处理规则(核 `LegacyDecoder.ParseStreamInto`)
 *
 * - 空白行、以 `//` 开头的行跳过(`ShouldSkipLine`)
 * - 行内注释:`StripComments` 只在 `//` 的下标 **> 0** 时截断
 *   (下标为 0 的情况上一条已经过滤掉了)
 * - `[Xxx]` 切换段落
 * - 其余按**第一个** `:` 拆成键值,两边各自 trim(`SplitKeyVal`)
 *
 * ## combo 色的顺序就是索引
 *
 * `Combo1:` 后面那个数字**不参与定位**:`HandleColours` 用
 * `int.TryParse(pair.Key[5..], out int comboIndex)` 之后只做范围校验
 * (`1..MAX_COMBO_COLOUR_COUNT`),通过了就 `CustomComboColours.Add(colour)` ——
 * 数字随即丢弃。所以乱序写就是乱序,跳号也不留空位。
 *
 * 与谱面 `[Colours]` 完全同一套逻辑,见 `SimBeatmap.comboColours` 的注释。
 *
 * 解析永不抛错:单行坏了就跳过那一行。lazer 也是这么做的
 * (`ParseStreamInto` 逐行 catch 并只记日志,不中断整个文件)。
 */
export function parseSkinIni(text: string): SkinIni {
  const raw = new Map<string, string>();
  const comboColours: Rgb[] = [];

  let name = '';
  let author = '';
  let version = DEFAULT_SKIN_VERSION;
  let isLatestVersion = false;
  let sliderBorder: Rgb | null = null;
  let sliderTrackOverride: Rgb | null = null;

  let section = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;

    const line = stripComment(trimmed);
    if (line === '') continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }

    const colon = line.indexOf(':');
    if (colon < 0) continue;

    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === '') continue;

    if (sectionHasColours(section)) {
      const colour = parseColour(value);
      if (colour === null) continue;

      if (key === 'SliderBorder') sliderBorder = colour;
      else if (key === 'SliderTrackOverride') sliderTrackOverride = colour;
      else if (isComboKey(key) && comboColours.length < MAX_COMBO_COLOUR_COUNT) {
        comboColours.push(colour);
      } else {
        // 编号越界的 ComboN 会掉进 custom-colour 字典,不算 combo 色
        raw.set(key, value);
      }
      continue;
    }

    if (section === 'general') {
      if (key === 'Name') { name = value; continue; }
      if (key === 'Author') { author = value; continue; }
      if (key === 'Version') {
        if (value === 'latest') {
          version = LATEST_SKIN_VERSION;
          isLatestVersion = true;
        } else {
          // decimal.TryParse + InvariantCulture:解析失败时保留模板里的 1.0
          const parsed = Number.parseFloat(value);
          if (Number.isFinite(parsed)) {
            version = parsed;
            isLatestVersion = false;
          }
        }
        continue;
      }
    }

    raw.set(key, value);
  }

  return {
    name,
    author,
    version,
    isLatestVersion,
    comboColours,
    sliderBorder,
    sliderTrackOverride,
    hitCirclePrefix: prefixOf(raw, 'HitCirclePrefix', FONT_DEFAULTS.hitCirclePrefix),
    hitCircleOverlap: numberOf(raw, 'HitCircleOverlap', FONT_DEFAULTS.hitCircleOverlap),
    scorePrefix: prefixOf(raw, 'ScorePrefix', FONT_DEFAULTS.scorePrefix),
    scoreOverlap: numberOf(raw, 'ScoreOverlap', FONT_DEFAULTS.scoreOverlap),
    comboPrefix: prefixOf(raw, 'ComboPrefix', FONT_DEFAULTS.comboPrefix),
    comboOverlap: numberOf(raw, 'ComboOverlap', FONT_DEFAULTS.comboOverlap),
    raw,
  };
}

/** `Combo1` … `Combo8`。编号只做范围校验,不用于定位。 */
function isComboKey(key: string): boolean {
  if (!key.startsWith('Combo')) return false;

  const n = Number.parseInt(key.slice(5), 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_COMBO_COLOUR_COUNT;
}

/**
 * 哪些段落的键值会走颜色解析。
 *
 * ## ⚠️ `[CatchTheBeat]` 的 `ComboN` **会进 std 的 combo 色列表**
 *
 * 这不是我们的选择,是 lazer 的行为,而且很可能是上游的意外后果。证据链:
 *
 * `LegacySkinDecoder.ParseLine`:
 * ```csharp
 * // osu!catch section only has colour settings
 * // so no harm in handling the entire section
 * case Section.CatchTheBeat:
 *     HandleColours(skin, line, true);
 *     return;
 * ```
 *
 * 而 `LegacyDecoder.HandleColours`(2026-08-24 核原文)**完全不看段落**:
 * ```csharp
 * bool isCombo = pair.Key.StartsWith(@"Combo", StringComparison.Ordinal)
 *                && int.TryParse(pair.Key[5..], out int comboIndex)
 *                && comboIndex >= 1 && comboIndex <= MAX_COMBO_COLOUR_COUNT;
 * if (isCombo) { ...; tHasComboColours.CustomComboColours.Add(colour); }
 * else        { ...; tHasCustomColours.CustomColours[pair.Key] = colour; }
 * ```
 *
 * 而 `SkinConfiguration` 实现 `IHasComboColours`。所以 catch 段里的 `Combo1`
 * 会被 `Add` 进同一个列表,osu!std 照样会用到它。
 *
 * **实测**:用户提供的真实皮肤(`fixtures/user/test.osk`)正好触发这一条 ——
 * `[Colours]` 只有一个 `Combo1: 74,134,255`,而 `[CatchTheBeat]` 里有
 * `Combo1: 0,0,0`,于是 std 得到"蓝、黑"两个 combo 色交替。
 * 那大概不是皮肤作者的本意,但我们照搬,因为**偏离源码更危险**:
 * 我们对不上时无法判断是自己错还是上游错。
 *
 * 另一处已知偏差:catch 段传的是 `allowAlpha: true`,而 `[Colours]` 是 `false`。
 * 我们的 `Rgb` 不带 alpha,所以 catch 段里写四分量时会丢掉 alpha。
 * 这是"边缘情况的边缘情况",不为它单独建模。
 */
function sectionHasColours(section: string): boolean {
  return section === 'colours' || section === 'catchthebeat';
}

/**
 * 行内注释:`//` 之后的内容截掉,但**只在它不位于行首时**。
 *
 * 核 `LegacyDecoder.StripComments`:`index > 0` 才截。行首的 `//` 由上层
 * `ShouldSkipLine` 处理(整行跳过),所以这里不需要再管。
 */
function stripComment(line: string): string {
  const index = line.indexOf('//');
  return index > 0 ? line.slice(0, index).trim() : line;
}

/**
 * `R,G,B` 或 `R,G,B,A`。**alpha 丢弃** —— 见文件头注释。
 *
 * 分量走 `byte.Parse`(允许两侧空白),失败则整条颜色作废。
 */
function parseColour(value: string): Rgb | null {
  const parts = value.split(',');
  if (parts.length !== 3 && parts.length !== 4) return null;

  const byteAt = (i: number): number | null => {
    const n = Number.parseInt(parts[i]!.trim(), 10);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
  };

  const r = byteAt(0);
  const g = byteAt(1);
  const b = byteAt(2);
  if (r === null || g === null || b === null) return null;

  return { r, g, b };
}

/**
 * 字体前缀。皮肤里可能写成 Windows 路径(`fonts\hitcircle\default`),
 * 统一成正斜杠、去掉尾部斜杠、转小写 —— 因为文件索引也是小写正斜杠。
 */
function prefixOf(raw: ReadonlyMap<string, string>, key: string, fallback: string): string {
  const value = raw.get(key);
  if (value === undefined || value.trim() === '') return fallback;

  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function numberOf(raw: ReadonlyMap<string, string>, key: string, fallback: number): number {
  const value = raw.get(key);
  if (value === undefined) return fallback;

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
