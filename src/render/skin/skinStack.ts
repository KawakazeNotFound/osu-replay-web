import type { Rgb } from '../../core/sim/types';
import { resolveTexture, type SkinTexture } from './skinFiles';
import { LATEST_SKIN_VERSION, parseSkinIni, type SkinIni } from './skinIni';

/**
 * # 分层皮肤查找
 *
 * ## 模型:一个有序的皮肤栈,逐层查
 *
 * 核 `osu.Game/Skinning/SkinProvidingContainer.cs`(2026-08-24):
 *
 * ```csharp
 * public Texture? GetTexture(string componentName, WrapMode wrapModeS, WrapMode wrapModeT)
 * {
 *     foreach (var (_, lookupWrapper) in skinSources)
 *     {
 *         Texture? sourceTexture;
 *         if ((sourceTexture = lookupWrapper.GetTexture(componentName, wrapModeS, wrapModeT)) != null)
 *             return sourceTexture;
 *     }
 *     ...
 *     return ParentSource?.GetTexture(componentName, wrapModeS, wrapModeT);
 * }
 *
 * public ISkin? FindProvider(Func<ISkin, bool> lookupFunction)
 * {
 *     foreach (var (skin, lookupWrapper) in skinSources)
 *     {
 *         if (lookupFunction(lookupWrapper))
 *             return skin;
 *     }
 *     ...
 * }
 * ```
 *
 * 两条要点:
 *
 * 1. **回退是逐组件的,不是逐皮肤的。** 用户皮肤有 `hitcircle` 但没有
 *    `approachcircle` 时,`approachcircle` 会从下一层(默认皮肤)取。
 *    实测用户的 `test.osk` 正好缺 `approachcircle` 与 `reversearrow`。
 * 2. **`FindProvider` 返回"第一个满足条件的层"**,用于"某个组件该用哪个名字"
 *    这类需要先定位提供方的决策 —— 见 {@link findProvider} 的注释。
 *
 * ## ⚠️ 默认皮肤的配置是**代码里写死的**,不是解析空 ini 得来的
 *
 * 这是个很容易掉进去的坑。`ppy/osu-resources` 的 `Skins/Legacy` 里
 * **根本没有 `skin.ini`**,但 `DefaultLegacySkin` 的构造函数把配置直接赋上了:
 *
 * ```csharp
 * Configuration.CustomColours["SliderBall"] = new Color4(2, 170, 255, 255);
 * Configuration.CustomComboColours = DEFAULT_COMBO_COLOURS;
 * Configuration.ConfigDictionary[nameof(SkinConfiguration.LegacySetting.AllowSliderBallTint)] = @"true";
 * Configuration.LegacyVersion = 2.7m;
 * Configuration.IsLatestVersion = true;
 * ```
 *
 * 所以默认皮肤是 **2.7 / latest**,而不是"没写 Version ⇒ 1.0"。
 * 这个差别有实际后果:`LegacyMainCirclePiece.cs:183` 用 `legacyVersion > 1.0m`
 * 决定圈内数字是"短淡出 60ms 不缩放"还是"跟其他部件一样淡出并放大"。
 * 若图省事写成 `parseSkinIni('')`,默认皮肤会拿到 1.0,数字动画就走错分支。
 */

/**
 * 皮肤栈里的一层。
 *
 * `files` 只要能回答"有没有这个路径"就够了 —— 所以类型是 `ReadonlySet`,
 * 让**默认皮肤那种"文件在 HTTP 上、只有清单在本地"**的形态也能直接进栈,
 * 不必先把 5 MB 贴图全下下来。真正取字节由 {@link load} 负责。
 */
export interface SkinLayer {
  /** 调试与报错用的名字,如 `用户皮肤` / `默认皮肤` */
  readonly name: string;
  readonly ini: SkinIni;
  /** 该层拥有的文件路径(小写正斜杠) */
  readonly files: ReadonlySet<string>;
  /** 按路径取字节。路径一定来自 {@link files}。 */
  load(path: string): Promise<Uint8Array>;
}

/** 一次分层查找的结果 —— 比 {@link SkinTexture} 多一个"来自哪层"。 */
export interface LayeredTexture extends SkinTexture {
  readonly layer: SkinLayer;
}

/**
 * 逐层查一个贴图,**第一个命中的层胜出**。
 *
 * 对应 `SkinProvidingContainer.GetTexture` 的 foreach。
 */
export function resolveInLayers(
  layers: readonly SkinLayer[],
  componentName: string,
): LayeredTexture | null {
  for (const layer of layers) {
    const found = resolveTexture(layer.files, componentName);
    if (found !== null) return { ...found, layer };
  }
  return null;
}

/**
 * 第一个满足条件的层,没有则 `null`。对应 `ISkinSource.FindProvider`。
 *
 * ## 这个函数存在的唯一理由
 *
 * `LegacyMainCirclePiece.load()` 里有一段注释解释得很清楚(2026-08-24 核):
 *
 * > As a precondition, prefer that any *prefix* lookups are run against the skin
 * > which is providing "hitcircle". This is to correctly handle a case such as:
 * > - Beatmap provides `hitcircle`
 * > - User skin provides `sliderstartcircle`
 * > In such a case, the `hitcircle` should be used for slider start circles rather
 * > than the user's skin override.
 *
 * 也就是说"滑条头该叫 `sliderstartcircle` 还是 `hitcircle`"这个**命名决策**,
 * 要拿**提供 `hitcircle` 的那一层**来判断,而不是拿整个栈判断。
 * 但注释紧接着强调:
 *
 * > Of note, this consideration should only be used to decide whether to continue
 * > looking up the prefixed name or not. The final lookups must still run on the
 * > full skin hierarchy as per usual in order to correctly handle fallback cases.
 *
 * —— **决策看单层,取图看全栈。** 见 {@link circleComponentName}。
 */
export function findProvider(
  layers: readonly SkinLayer[],
  predicate: (layer: SkinLayer) => boolean,
): SkinLayer | null {
  return layers.find(predicate) ?? null;
}

/** 普通圈的基准查找名。核 `LegacyMainCirclePiece`:`const string base_lookup = @"hitcircle";` */
const BASE_CIRCLE_LOOKUP = 'hitcircle';

/**
 * 圈类物件该用哪个组件名(`hitcircle` / `sliderstartcircle` / `sliderendcircle`)。
 *
 * @param prefix 该物件想优先用的前缀,`null` 表示就是普通圈
 *
 * 逻辑逐行对应源码:
 * ```csharp
 * var provider = skin.FindProvider(s => s.GetTexture(base_lookup) != null) ?? skin;
 * string circleName = (priorityLookupPrefix != null && provider.GetTexture(priorityLookupPrefix) != null)
 *     ? priorityLookupPrefix : base_lookup;
 * ```
 *
 * ⚠️ 另一条同样重要、写在源码后半段的注释:
 *
 * > the conditional above handles the case where a sliderendcircle.png is retrieved
 * > from the skin, but sliderendcircleoverlay.png doesn't exist. expected behaviour
 * > in this scenario is **not showing the overlay**, rather than using hitcircleoverlay.png.
 *
 * 即:名字定成 `sliderendcircle` 之后,overlay 就只查 `sliderendcircleoverlay` ——
 * **查不到就不画 overlay**,不会退回 `hitcircleoverlay`。所以调用方拿到这个名字后,
 * overlay 一律用 `${name}overlay` 去查,不要另做回退。
 */
export function circleComponentName(
  layers: readonly SkinLayer[],
  prefix: string | null,
): string {
  if (prefix === null) return BASE_CIRCLE_LOOKUP;

  // 提供 hitcircle 的那一层;都不提供时源码退回 `skin` 本身(即整个栈)
  const provider = findProvider(
    layers,
    (layer) => resolveTexture(layer.files, BASE_CIRCLE_LOOKUP) !== null,
  );

  const scope: readonly SkinLayer[] = provider === null ? layers : [provider];
  return resolveInLayers(scope, prefix) !== null ? prefix : BASE_CIRCLE_LOOKUP;
}

/**
 * osu! legacy 默认皮肤的 combo 四色。
 *
 * 核 `DefaultLegacySkin.cs` 的 `DEFAULT_COMBO_COLOURS` —— 与
 * `SkinConfiguration.DefaultComboColours` 是同样的四个值,只是挂在两处:
 * 前者是"默认皮肤自己的配色",后者是"没有任何皮肤时的兜底"。
 * 我们两条路径都保留,结果一致(见 `render/comboColours.ts`)。
 */
const DEFAULT_LEGACY_COMBO_COLOURS: readonly Rgb[] = [
  { r: 255, g: 192, b: 0 },
  { r: 0, g: 202, b: 0 },
  { r: 18, g: 124, b: 255 },
  { r: 242, g: 24, b: 57 },
];

/** 默认皮肤的滑条球色。核 `DefaultLegacySkin.cs`:`CustomColours["SliderBall"]`。 */
export const DEFAULT_SLIDER_BALL_COLOUR: Rgb = { r: 2, g: 170, b: 255 };

/**
 * 默认皮肤的 `SkinIni` —— **在代码里构造**,见文件头注释里那段说明。
 *
 * 从 `parseSkinIni('')` 起步再覆盖具名字段:这样 `[Fonts]` 那些默认值
 * (`hitCirclePrefix: 'default'`、`hitCircleOverlap: -2` 等)自动来自同一处定义,
 * 不必在两个文件里各写一遍。
 */
export function defaultSkinIni(): SkinIni {
  const base = parseSkinIni('');

  return {
    ...base,
    name: 'osu! "classic" (2013)',
    author: 'team osu!',
    version: LATEST_SKIN_VERSION,
    isLatestVersion: true,
    comboColours: DEFAULT_LEGACY_COMBO_COLOURS,
    raw: new Map([
      ...base.raw,
      // DefaultLegacySkin 显式打开了它 —— 其他皮肤不写就是关
      ['AllowSliderBallTint', 'true'],
    ]),
  };
}
