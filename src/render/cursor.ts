import { normalizeKeys, type ReplayFrames } from '../core/replay/frames';
import { lastIndexAtOrBefore } from '../core/util/search';

/**
 * # 光标的尺寸与动画
 *
 * ## ⚠️ 光标贴图要**额外再除 1.6**
 *
 * 这是最容易漏、且漏了必然错 1.6 倍的一条。光标不是 playfield 内的元素:
 *
 * ```csharp
 * // osu.Game.Rulesets.Osu/Skinning/NonPlayfieldSprite.cs
 * if (value != null)
 *     value.ScaleAdjust *= LegacySkin.STABLE_MAGIC_SCALE_FACTOR;
 * // osu.Game/Skinning/LegacySkin.cs:36
 * public const float STABLE_MAGIC_SCALE_FACTOR = 1.6f;
 * ```
 *
 * 1.6 的来历(`OsuPlayfieldAdjustmentContainer.cs:56-64`):
 * ```csharp
 * // Parent!.ChildSize.X = 819.2
 * // Scale = 819.2 / 512
 * // Scale = 1.6
 * Scale = new Vector2(Parent!.ChildSize.X / OsuPlayfield.BASE_SIZE.X);
 * ```
 * 也就是说**光标贴图是按"1024×768 参考屏幕下 1:1 像素"设计的**,
 * 而判定区在那个参考屏幕下被放大了 1.6 倍,所以要先除掉。
 *
 * 用到它的三个组件:`cursor`、`cursormiddle`、`cursortrail`。
 * hitcircle / approachcircle / 滑条那些都**不用**。
 *
 * ## 光标不随 CS 缩放
 *
 * ```csharp
 * // osu.Game/Configuration/OsuConfigManager.cs:116,118
 * SetDefault(OsuSetting.GameplayCursorSize, 1.0f, 0.1f, 2f, 0.01f);
 * SetDefault(OsuSetting.AutoCursorSize, false);
 * ```
 * `AutoCursorSize` 默认**关**,所以默认光标尺寸与 CS 无关,恒为 1.0 倍。
 * (开了才会乘 `1 - 0.7 * (1 + CS - 5) / 5`。)
 *
 * ## 只有 `cursor` 会转会缩,`cursormiddle` 不会
 *
 * `LegacyCursor.cs:37-51` 里 `ExpandTarget` 是 `cursor` 那一张;
 * `cursormiddle` 是它的兄弟节点,不在 `ExpandTarget` 里。
 * 而 `Expand()` / `Spin()` 都只作用于 `ExpandTarget`。
 */

/** 光标类贴图的额外缩放分母。核 `LegacySkin.cs:36`。 */
export const STABLE_MAGIC_SCALE_FACTOR = 1.6;

/** 按下时的目标缩放。核 `LegacyCursor.cs:16`:`private const float pressed_scale = 1.3f;` */
export const CURSOR_PRESSED_SCALE = 1.3;

/** 放大/缩小的时长。核 `LegacyCursor.cs:62-68`:`ScaleTo(..., 100, Easing.Out)`。 */
export const CURSOR_EXPAND_MS = 100;

/** 旋转一圈的时长。核 `LegacyCursor.cs:14`:`REVOLUTION_DURATION = 10000`。 */
export const CURSOR_REVOLUTION_MS = 10000;

/** `Easing.Out` = OutQuad,核 `DefaultEasingFunction.cs:50-52`:`time * (2 - time)`。 */
function outQuad(t: number): number {
  return t * (2 - t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 光标的旋转角(**度**,顺时针)。
 *
 * 核 `TransformSequenceExtensions.cs:37-39` 的 `Spin`:
 * ```csharp
 * => t.Loop(d => d.RotateTo(startRotation).RotateTo(startRotation + 360, revolutionDuration));
 * ```
 * 即每 10000ms 转一圈,合每秒 36 度。
 *
 * ## ⚠️ 相位起点在 lazer 里**不可复现**
 *
 * `Spin` 是在 `LoadComplete` 里调的,`TransformStartTime` 等于"游戏界面加载完成
 * 那一瞬间"的时钟值 —— 既不是 0,也不是谱面开始,而是取决于加载耗时。
 * **lazer 自己每次运行都不一样。**
 *
 * 所以我们取 `T0 = 0`(时间轴原点)。与 lazer 差一个恒定相位,无法消除也无需消除:
 * 只要我们自己**可复现**,帧级 scrub 就成立 —— 这比"与 lazer 逐帧一致"更重要,
 * 因为后者本来就做不到。
 */
export function cursorRotationAt(time: number): number {
  const revolutions = time / CURSOR_REVOLUTION_MS;
  // 负时间(lead-in)也要给出正的角度
  return ((revolutions % 1) + 1) % 1 * 360;
}

/**
 * 光标的按下缩放。
 *
 * ## 触发规则
 *
 * `OsuCursorContainer.cs:77-125` 维护一个按键计数 `downCount`:任意键按下就
 * `Expand()`、归零就 `Contract()`。而 `Expand()` 是
 * `ScaleTo(1).ScaleTo(1.3, 100, Easing.Out)` —— **先瞬间归 1 再重新涨**。
 *
 * 推论:**多按一个键会重启整个动画**(哪怕已经按着一个)。所以基准时刻是
 * "最近一次**新增**按键"的时刻,不是"最近一次从无到有"。
 *
 * ## 松开之后
 *
 * `Contract()` 是 `ScaleTo(1, 100, Easing.Out)` —— 从**当时的实际缩放**回到 1。
 * 所以要先算出松手那一刻的缩放值,再从它插值。
 *
 * @param frames 回放帧
 * @param time 当前时刻
 * @param enabled `CursorExpand`。为 `false` 时恒为 1(用户皮肤设了 0)
 */
export function cursorExpandScaleAt(
  frames: ReplayFrames,
  time: number,
  enabled: boolean,
): number {
  if (!enabled || frames.count === 0) return 1;

  const at = lastIndexAtOrBefore(frames.time, frames.count, time);
  if (at < 0) return 1;

  // 从当前帧往前扫,找两个时刻:
  //   pressAt   —— 最近一次「新增按键」(位域里多了一位)
  //   releaseAt —— 最近一次「归零」
  // 只需回溯到能覆盖一次 100ms 动画即可,但帧数很少时直接扫到头更简单可靠。
  // 扫描范围有界:100ms 的动画只关心最近两个事件
  let pressAt: number | null = null;
  let releaseAt: number | null = null;
  let pressBeforeRelease: number | null = null;

  for (let i = at; i >= 0; i--) {
    const keys = normalizeKeys(frames.keys[i]!);
    const previous = i > 0 ? normalizeKeys(frames.keys[i - 1]!) : 0;

    // 新增按键:出现了上一帧没有的位
    const added = (keys & ~previous) !== 0;

    if (releaseAt === null && keys === 0 && previous !== 0) {
      releaseAt = frames.time[i]!;
      continue;
    }

    if (added) {
      if (releaseAt === null) {
        pressAt = frames.time[i]!;
        break;
      }
      // 松手之前的那次按下 —— 用来算松手瞬间的缩放
      pressBeforeRelease = frames.time[i]!;
      break;
    }
  }

  const pressed = normalizeKeys(frames.keys[at]!) !== 0;

  if (pressed) {
    if (pressAt === null) return 1;
    return 1 + (CURSOR_PRESSED_SCALE - 1) * outQuad(clamp01((time - pressAt) / CURSOR_EXPAND_MS));
  }

  if (releaseAt === null) return 1;

  // 松手瞬间的缩放
  const atRelease =
    pressBeforeRelease === null
      ? 1
      : 1 +
        (CURSOR_PRESSED_SCALE - 1) *
          outQuad(clamp01((releaseAt - pressBeforeRelease) / CURSOR_EXPAND_MS));

  const back = outQuad(clamp01((time - releaseAt) / CURSOR_EXPAND_MS));
  return atRelease + (1 - atRelease) * back;
}

/**
 * 拖尾的两种模式。
 *
 * 核 `LegacyCursorTrail.cs:44-45`:
 * ```csharp
 * // Stable always chooses cursor trail disjoint behaviour based on the cursor texture
 * // lookup source, so we need to fetch where that occurred.
 * var cursorProvider = skinSource.FindProvider(s => s.GetTexture("cursor") != null);
 * DisjointTrail = cursorProvider?.GetTexture("cursormiddle") == null;
 * ```
 *
 * ⚠️ 判据是「**提供 `cursor` 的那一层**有没有 `cursormiddle`」,不是整个皮肤栈 ——
 * 又一次 `FindProvider` 的用法(与圈类命名决策同一个模式)。
 */
export type TrailMode = 'connected' | 'disjoint';

/** 各模式的淡出时长。核 `LegacyCursorTrail.cs:63`。 */
export const TRAIL_FADE_MS: Record<TrailMode, number> = {
  connected: 500,
  disjoint: 150,
};

/**
 * disjoint 模式的时间网格。
 *
 * 核 `LegacyCursorTrail.cs:19`:
 * `private const double disjoint_trail_time_separation = 1000 / 60.0;`
 */
export const DISJOINT_TRAIL_STEP_MS = 1000 / 60;

/**
 * disjoint 模式下当前可见的拖尾点时刻,**从新到旧**。
 *
 * 这是**完全的纯函数** —— 点生成于 `k × step` 的固定网格上,位置由 `cursorAt` 反查。
 * 所以帧级 scrub 与顺序播放逐点一致。
 *
 * ⚠️ 唯一与 lazer 的差异是网格相位:lazer 的 `lastTrailTime` 从第一次鼠标移动
 * 起累加,我们取 `0`。肉眼不可分辨,而且 lazer 那个起点同样不可复现。
 *
 * @param fade 淡出时长,取 {@link TRAIL_FADE_MS}
 */
export function disjointTrailTimes(time: number, fade: number): number[] {
  const out: number[] = [];

  // 最近一个网格点
  const newest = Math.floor(time / DISJOINT_TRAIL_STEP_MS);
  const oldest = Math.ceil((time - fade) / DISJOINT_TRAIL_STEP_MS);

  for (let k = newest; k >= oldest; k--) {
    const t = k * DISJOINT_TRAIL_STEP_MS;
    // 严格小于等于 t，且在淡出窗口内
    if (t <= time && time - t < fade) out.push(t);
  }

  return out;
}

/**
 * 拖尾点的不透明度。
 *
 * 着色器(`sh_CursorTrail.vs`):
 * ```glsl
 * v_Colour = vec4(m_Colour.rgb, m_Colour.a * pow(clamp(m_Time - g_FadeClock, 0.0, 1.0), g_FadeExponent));
 * ```
 * 而 `LegacyCursorTrail.cs:64` 给 `FadeExponent => 1` ⇒ **完全线性**。
 */
export function trailAlphaAt(age: number, fade: number): number {
  return clamp01(1 - age / Math.max(1e-9, fade));
}
