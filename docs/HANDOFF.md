# 交接简报

> 生成于 2026-08-24,HEAD `2618804`。测试 838 通过,tsc / build 干净。

这份文档的存在理由:**三次源码调研的结论有一部分只活在会话上下文里,没进代码注释。**
那三次调研合计烧了约 33 万 token,丢掉就得重跑。这里把还没落地的部分固化下来。

已经落地的结论**不在这里**,在 `TECH-NOTES.md` 的 D14~D18 与各文件头注释里。

---

## 0. 接手前必须知道的一条

> **渲染层不得持有任何跨帧可变游戏状态。**
> 每帧只依赖传入的 `state`(由 `stateAt(timeline, t)` 纯查询得出)。

这是帧级 scrub 成立的**唯一**前提,也是本项目的核心卖点。
`DebugRenderer.test.ts` 里那条「🔒 正放到达 == 直接 seek 到达,绘制调用序列逐项相同」
就是它的守卫。

判据是**幂等性**,不是"有没有字段"。所以这些是允许的:
- `palette` / `sprites` / `tinted` —— 由不可变输入完全决定的记忆化,装好后不再变
- 反例(禁止):在渲染器里存"命中动画计时器"或"拖尾累积数组"

**推论:任何动画都必须能写成 `f(t)`。** lazer 大量使用事件驱动 transform,
照抄会破坏这条。做法是把每段 transform 的**绝对起点时刻**与时长找出来,反推成分段闭式。

## 1. 工作纪律(踩过的坑换来的)

1. **核源码,不凭印象。** 判定/难度/渲染的每个常数都要有 `文件:行号` 依据。
   参考实现(webosu / replayviewer-js)**不是权威** —— 两者都被实测抓到过错值。
2. **变异检验**:写完测试后手动破坏被测代码,确认测试真的变红。
   本项目已有多条测试是这样被发现"假通过"的。
3. **非空洞守卫**:断言前先证明被测代码确实收到了输入
   (例:`expect(state.activeObjects.length).toBeGreaterThan(0)`)。
4. **别拿通用 op 当特征。** 已踩两次:用"第一个 `arc`"定位头圈,结果撞上滑条球;
   用"第一个 `arc` 在 drawImage 之后"验层序,结果撞上光标。
5. **改含中文的源码只用 Edit 工具**,不要走 PowerShell 文本管道
   (PS 5.1 按 ANSI 读 UTF-8,会把注释写成乱码。见 TECH-NOTES D12)。
6. **变异脚本禁止用空串当 replace 目标** —— `replace('')` 会插到下标 0,
   曾把一行代码插进 `import` 里。见 `scripts` 目录外的临时脚本注释。
7. 提交信息用 `git commit -F <file>`,不要 `-m`(PowerShell 会重新分词)。
8. 素材一概不入库:`.osr` / `.osu` / `.osz` / `.osk` 已在 `.gitignore`。
   **例外**:`public/skins/default/` 是刻意入库的第三方素材(CC BY-NC,见该目录 NOTICE)。

---

## 2. 当前渲染状态

| 部件 | 状态 |
|---|---|
| 判定区几何 / combo 配色 | ✅ 对齐源码 |
| hitcircle / sliderstartcircle | ✅ 贴图 + combo 染色 |
| hitcircleoverlay | ✅ 贴图(不染色) |
| 圈内数字 | ✅ 字体贴图 + overlap 排版 |
| approach circle | ✅ 贴图 + 染色 + 分段 alpha/scale + 独立顶层 |
| 光标 / cursormiddle / 拖尾 | ✅ 贴图 + 1.6 分母 + expand/rotate |
| 滑条体 | 🟡 自绘(K 遍不透明同心描边 + snaking) |
| **滑条球 / follow circle / 反向箭头 / 刻度点 / 滑条尾圈** | ❌ **规格已核完,见第 4 节** |
| 转盘 | ❌ 只有一个占位圆 |
| HUD(分数/连击/准确率/血条/按键覆盖/UR 条) | ❌ 素材已下载,未实现 |
| 判定飘字(hit300/100/50/0) | ❌ 素材已下载,未实现 |
| followpoint | ❌ 素材已下载,未实现 |
| 打击音 | ❌ 完全没有 |
| 谱面背景图 + dim | ❌ |

### 相关文件

```
src/render/
  DebugRenderer.ts        主渲染器(唯一持有 canvas 的地方)
  approachCircle.ts       approach circle 的 alpha/scale 闭式
  cursor.ts               1.6 分母、expand、rotate、拖尾两模式
  comboColours.ts         配色优先级链(谱面 → 皮肤 → 默认)
  sliderSnaking.ts        滑条伸展/收缩
  skin/
    skinIni.ts            skin.ini 解析(纯函数)
    skinFiles.ts          .osk 解包 + @2x 贴图查找
    skinStack.ts          分层查找 + findProvider + 默认皮肤 ini
    defaultSkin.ts        默认皮肤装载 + userSkinLayer
    skinTextures.ts       贴图解码与缓存(必须先装好再画)
    tint.ts               combo 色染色(multiply 三步配方)
    spriteGeometry.ts     像素 → 判定区尺寸换算 + 居中裁剪
    numberLayout.ts       数字字体排版
```

---

## 3. 贯穿性换算规则(所有贴图共用)

```
drawSize(osu 单位) = (贴图像素 / ScaleAdjust) × 部件常数 × (Radius / 64)
```

- `ScaleAdjust`:命中 `@2x` 时为 2,否则 1(`LegacySkin.cs:571-582`)
- `Radius = 64 × HitObject.Scale`,`OBJECT_RADIUS = 64`
- **部件常数**几乎全是 1。**唯一例外是 follow circle 的 `0.5`**
- **光标类三个组件额外再除 1.6**(`cursor` / `cursormiddle` / `cursortrail`,
  见 `cursor.ts` 的 `STABLE_MAGIC_SCALE_FACTOR`)

`WithMaximumSize` 是**居中裁剪**不是缩放(`LegacySkinExtensions.cs:112-133`),
上限先乘 `ScaleAdjust`,且**逐轴取 min**。各部件上限:

| 部件 | display 上限 |
|---|---|
| `sliderb*` / `sliderb-nd` / `sliderb-spec` / `sliderfollowcircle` | **384**(`OBJECT_DIMENSIONS × 3`) |
| `hitcircle` / `sliderstartcircle` / `sliderendcircle` + overlay / `reversearrow` / `approachcircle` | 256 |
| `sliderscorepoint` | 128 |
| 数字字形 | 320(= 256 / 0.8) |

⚠️ `LEGACY_CIRCLE_RADIUS = 59`(`OsuLegacySkinTransformer.cs:29`)**只用于滑条体路径半径**
(`SliderPathRadius`),**不参与任何贴图尺寸**。注释里"圈本体只有 118px"极容易误导。

---

## 4. 滑条贴图的完整规格 —— 下一步要做的东西

⚠️ **这一节是本文档存在的主要理由。** 以下全部核自 `ppy/osu@e9451fe7`(2026-08-21)。

### 4.0 绘制顺序(底 → 顶)

核 `DrawableSlider.cs:100-128`。注意源码里有一句注释:
*"proxied here so that the tail is drawn under repeats/ticks - legacy skins rely on this"*

1. 滑条体
2. **滑条尾圈**(proxy 到这里,所以在 ticks/repeats **之下**)
3. 刻度点(`sliderscorepoint`)
4. repeat 圈
5. 滑条头圈(主贴图)
6. 所有反向箭头(proxy 进 `OverlayElementContainer`)
7. 滑条头的 overlay + combo 数字(`Depth = float.MinValue`,该容器内最前)
8. follow circle
9. 滑条球

### 4.1 滑条球(sliderb)

- **启用条件**:`GetTexture("sliderb") != null || GetTexture("sliderb0") != null`
- **帧命名无分隔符**:`sliderb0.png`、`sliderb1.png`…
  源码传的 `animationSeparator` 是 **`""`**,而其他部件默认是 `"-"`。
  ```csharp
  ballTextures = skin.GetTextures("sliderb", default, default, true, "", maxSize, out _);
  ```
- **帧间隔由滑条速度算,与 `SliderBallFrames` 无关**(那个键 lazer 不读):
  ```csharp
  frameDelay = Math.Max(0.15 / drawableSlider.HitObject.Velocity * SIXTY_FRAME_TIME,
                        SIXTY_FRAME_TIME);   // SIXTY_FRAME_TIME = 1000/60
  ```
- **动画循环**,起点 `T0 = slider.StartTime - slider.TimePreempt`:
  ```
  frame = floor(((t - T0) mod (N × delay)) / delay)
  ```
- **染色**:`AllowSliderBallTint`
  - ⚠️ **这个键读的是"提供 sliderb 的那一个皮肤"的 ini,不是整个皮肤栈** ——
    因为 `LegacySliderBall` 收到的是 `OsuLegacySkinTransformer`(包裹单个 skin),
    而 `SkinTransformer.GetConfig` 只转发给它包的那一个。
    对比 `LegacyMainCirclePiece` 用的是 `ISkinSource`(整条链)。
  - **不写 = false**(源码是 `?.Value == true`)。默认皮肤显式写了 `true`。
  - `true` → combo 色;否则 → `[Colours] SliderBall` 或白色
    (默认皮肤的 SliderBall 是 `rgb(2, 170, 255)`,见 `skinStack.ts`)
- **`sliderb-nd`**:球**下方**一层,强制 `rgb(5,5,5)`,正常混合,单张无动画
- **`sliderb-spec`**:球**上方**一层,**加法混合**,不染色,单张无动画
- **旋转**:球跟着路径方向转;**`nd` 与 `spec` 反向抵消**(不转)
  ```
  p    = clamp((t - StartTime) / Duration, 0, 1)
  cd   = 0.1 / Path.Distance
  diff = CurvePositionAt(min(1-cd, p)) - CurvePositionAt(min(1, p+cd))
  if |diff| >= 0.01:  rot = -90° - atan2(diff.x, diff.y)   // 度
  ```
  验证:向右移动时 rot = 0°
- **可见性**:`alpha = 1` 当且仅当 `StartTime <= t < HitStateUpdateTime`(瞬变,无渐变)
- `SliderBallFlip` lazer **不读**,不要实现

### 4.2 follow circle(sliderfollowcircle)

- 动画:`GetAnimation("sliderfollowcircle", true, true, true, maxSize: 384)`
  → 帧名 `sliderfollowcircle-0`、`-1`…(**默认 `-` 分隔符**),
  帧长 = `AnimationFramerate > 0 ? 1000/它 : 1000/帧数`
- **唯一带额外常数的部件**:
  ```csharp
  // LegacyFollowCircle.cs:14-15
  // follow circles are 2x the hitcircle resolution in legacy skins
  animationContent.Scale *= 0.5f;
  ```
  ⇒ `drawSize = tex.DisplaySize × 0.5 × scaleAnim(t) × HitObject.Scale`
- 标准 256px 贴图 + `scaleAnim = 2` ⇒ 256 osu 单位 = `4 × Radius`
- ⚠️ 判定用的跟踪半径是 `FOLLOW_AREA = 2.4`,但**贴图只画到 2.0**。
  源码注释明确说这是为了匹配 legacy 行为。**别把这两个数搞混。**
- 初始:`scale = 1`,`alpha = 0`

**动画是事件驱动的,要预计算事件表再反推 f(t)。** 五种事件:

| 事件 | 绝对起点 | scale | alpha |
|---|---|---|---|
| PRESS | `max(tracking 上升沿, slider.StartTime)` | 瞬时 1,然后 `1→2` over `min(180, remaining)`,**Easing.Out** | 瞬时 0,然后 `0→1` over `min(60, remaining)`,线性 |
| RELEASE | — | **legacy 什么都不做**(停在 2) | 不动(停在 1) |
| TICK | 该 tick/repeat 的 `HitStateUpdateTime` | 若当时 `scale >= 2`:瞬时 2.2,然后 `2.2→2` over 200ms 线性 | 不动 |
| END | **slider 自己的** `HitStateUpdateTime` | `→1.6` over 200ms,Easing.Out | `→0` over 200ms,**Easing.In** |
| BREAK | 漏掉的 tick/repeat/tail 的 `HitStateUpdateTime` | `→4` over 100ms 线性 | `→0` over 100ms 线性 |

`remaining = max(0, slider.HitStateUpdateTime - 触发帧时刻)`

**反推要点**:除 TICK 外每个事件都把目标写死(2 / 1.6 / 4),所以整条 scale 曲线是
分段闭式的,每段段末值是常数 ⇒ O(1) 可求。TICK 的守卫 `scale >= 2` 可离线判定:
只有处于 PRESS 段且 `t_tick - T_press >= min(180, remaining)`,或处于上一次 TICK
的 2.2→2 段中(那时恒 ≥ 2)才成立。

⚠️ **RELEASE 什么都不做 + PRESS 会瞬时归 1** ⇒ 断了再接会看到一次完整的重新弹出。

### 4.3 反向箭头(reversearrow)

- **启用条件**:皮肤链里有 `hitcircle`(`hasHitCircle`)
- 单张贴图,无动画,上限 256
- `drawSize = tex.DisplaySize × HitObject.Scale`
- **颜色**:仅当贴图来自 `DefaultLegacySkin` **且** combo 色的 `R+G+B > 600`(0..255 之和)
  → 染黑,否则白(即原色)
- **位置**:`RepeatIndex % 2 == 0` → 路径**末端**,否则路径**起点**
- **朝向**:从自己所在那一端沿曲线折线点列向内扫,取**第一个与自身位置不几乎相等**的点
  ```
  aimRotation = degrees(atan2(target.y - pos.y, target.x - pos.x))
  ```
  即"指向离开自己、朝滑条内部走"的方向
  ⚠️ 源码还有一个**帧率相关的平滑插值**(`Interpolation.ValueAt(ElapsedFrameTime, ...)`),
  无法闭式化。**直接用目标角,跳过平滑** —— 只在 snaking 中的线性滑条上差几度。
- **脉动(源码本身已是纯 f(t),可直接照搬)**:
  ```
  T0 = repeat.StartTime - repeat.TimePreempt
  if (t >= repeat.HitStateUpdateTime && state == Hit):
      d = min(300, slider.SpanDuration)
      scale = lerp_OutQuad(1 → 1.4) over [HSU, HSU + d]   // clamp
      rot   = 0
  else:
      u = ((t - T0) mod 300) / 300
      if skinVersion <= 1:  rot = 5.625 - 11.25u ;  scale = 1.3 - 0.3u        // 线性
      else:                 rot = 0              ;  scale = 1.3 + (1-1.3)·u(2-u)  // OutQuad
  ```
  `shouldRotate = 皮肤 Version <= 1`
- repeat 的 `TimePreempt`:`RepeatIndex > 0` → `TimeFadeIn = 0` 且 `TimePreempt = SpanDuration × 2`;
  否则 `TimePreempt += StartTime - Slider.StartTime`
- 箭头淡入:150ms(`ApplyRepeatFadeIn(Arrow, 150)`);snaking 开启且 `RepeatIndex == 0` 时
  延迟 `TimePreempt / 3` 才开始
- ⚠️ **当前 master 没有"箭头旁边加 X"这个特性** —— 全仓库搜索无果

### 4.4 刻度点(sliderscorepoint)

- `GetAnimation("sliderscorepoint", false, false, maxSize: 128)`
  → **`animatable = false`,只取单张**,不做 `-0` 帧动画
- `drawSize = tex.DisplaySize × HitObject.Scale × tickScale(t)`
- 位置 = `HitObject.Position - Slider.Position`(相对),**不染色**
- `ANIM_DURATION = 150`
- 出现起点 `T0 = tick.StartTime - tick.TimePreempt`,其中
  ```
  offset = (SpanIndex > 0) ? 200 : (base TimePreempt × 0.66)
  TimePreempt = (StartTime - SpanStartTime) / 2 + offset
  ```
- ```
  alpha:  t < T0        → 0
          T0 ≤ t < TH   → clamp((t-T0)/150, 0, 1)              // 线性
          t ≥ TH        → 1 - outQuint((t-TH)/150)   clamp     // Hit 与 Miss 相同
  scale:  T0 ≤ t < TH   → 0.5 + 0.5 · outElasticHalf((t-T0)/600)
          t ≥ TH (Hit)  → lerp_OutQuad(s_TH → s_TH × 1.5) over 150ms
          t ≥ TH (Miss) → 冻结在 s_TH
  ```
- `OutElasticHalf`(osu-framework `DefaultEasingFunction.cs:129-130`):
  ```
  elastic_const  = 2π / 0.3 ;  elastic_const2 = 0.3 / 4
  offset_half    = 2^-10 · sin((0.5 - elastic_const2) · elastic_const)
  f(t) = 2^(-10t) · sin((0.5t - elastic_const2) · elastic_const) + 1 - offset_half · t
  ```
- **飘字**:仅当皮肤 `Version < 2` 时,tick 命中会飘一个 `sliderpoint10`
  (tail 用 `sliderpoint30`),向上移 10px / 300ms OutQuad,然后 60ms 淡出

### 4.5 滑条头 / 尾 / repeat 的圈

| 部件 | 组件名 prefix | 带数字 |
|---|---|---|
| 滑条头 | `sliderstartcircle` | ✅ |
| 滑条尾 **与 repeat 点** | `sliderendcircle` | ❌ |

两者都走 `LegacyMainCirclePiece`,所以命名决策与 overlay 回退规则与普通圈完全一致
(见 `skinStack.ts` 的 `circleComponentName`)。**滑条头已实现**;尾与 repeat 未实现。

⚠️ **非 legacy 皮肤下尾/repeat 的圈是空的**(`_ => Empty()`)—— 只有 legacy 会画。

⚠️ **默认皮肤没有 `sliderstartcircle` / `sliderendcircle`** ⇒ std 的滑条头尾默认都用
`hitcircle`。这一条已由 `defaultSkin.test.ts` 钉住。

- `sliderendmiss` → `IgnoreMiss`(滑条尾漏掉);`slidertickmiss` → `LargeTickMiss`

---

## 5. 已知的技术债与近似(都是**刻意**的,别当 bug 修掉)

1. **connected 拖尾是近似的。** lazer 沿轨迹每 `cursortrail.DisplayWidth / 2.5` 个
   osu 单位放一个点(**移动快时点更密**),我们按回放帧放点(密度取决于采样率)。
   急动时我们的点偏稀。正解是弧长积分:沿 `P(t)` 累计弧长 `L(t)`,点位于 `s_k = k·interval`,
   时刻 `t_k = L⁻¹(s_k)`,只画 `t - t_k < 500` 且 `s_k < L(t) - interval` 的点。
   见 `DebugRenderer.trailPointTimes` 的注释。

2. **光标旋转相位取 `T0 = 0`。** lazer 的 `Spin` 起点是"界面加载完成那一瞬"的时钟值,
   **它自己每次运行都不同**,不可复现。我们只需自己可复现。

3. **滑条体的 alpha 预合成到判定区纯色背景上。** 背景是纯色时逐像素精确,
   将来渲染谱面背景图 / 故事板后会失真(中心该透出图片却透出纯色)。
   那时才需要 M2 的 WebGL 方案。见 TECH-NOTES D15。

4. **miss 的淡出没做。** 有源码依据:`DrawableHitCircle.UpdateHitStateTransforms`
   在 `ArmedState.Miss` 下是 `this.FadeOut(100)`(线性,**无缩放**),
   作用于整个 `DrawableHitCircle`(含三层)。我们现在对 miss 什么都不做 ——
   红圈一直画到视觉窗口结束。**这是个小而明确的缺口,适合当第一个热身任务。**

5. **圈内数字的淡出简化了。** 真实行为:`legacyVersion > 1.0` 时数字单独淡出
   `240/4 = 60ms` 且不缩放;`<= 1.0` 时与圈体同步(缩到 1.4)。我们直接让它消失。

6. **`cursor-smoke` 建议永不实现** —— 它的旋转依赖 `RNG.Next()` 种子,
   本身就不可复现,与本项目的确定性前提冲突。

7. **四个 stable 遗留键 lazer 根本不读,不要为它们写代码**:
   `SliderBallFlip` / `SliderBallFrames` / `SliderStyle` / `SpinnerFadePlayfield`。
   (全仓库 grep 确认,除被 `LegacySkinEncoder` 原样回写外无任何读取点。)

---

## 6. 判定 / 记分侧还差的

按"lazer 优先"排序:

1. **lazer 转盘 bonus 刻度** —— `SpinnerTick` → `SmallBonus`、`SpinnerBonusTick` → `LargeBonus`,
   `bonusPortion` 加在 100 万**之外**。漏掉会让带转盘的图分数偏低。
2. **lazer mod 系数** —— 现在硬编码 1。两个 fixture 都是 NM 所以没暴露。
3. **`lazer-moonlight` 那 1 个判定差**(一个 300 被判成 100)。已排除:命中窗口
   (lazer 也取整)、hit policy(两种 policy 结果字节级相同)。下一个怀疑对象是滑条头判定细节。
4. **HP drain** —— `drainPerMs` 仍是占位值(TECH-NOTES D1)。
   stable 回放自带 `replay.lifeBar` 可直接当 ground truth。
5. *(已降级)* **D13:`stable.osr` 的 combo 缺口** —— 412 vs 头部 1151,
   已定位到**具体 2 个滑条部件**(#225 末端、#501 repeat)。按"优先 lazer"降级。

---

## 7. 建议的推进顺序

1. **miss 淡出**(第 5 节第 4 条)—— 小、有源码依据、能立刻在真实回放上看到效果。热身用。
2. **滑条尾 / repeat 的圈** —— 复用已有的 `drawCirclePiece`,只是换 prefix 与关掉数字。
3. **滑条球 + `nd`/`spec`** —— 动画帧 + 旋转。中等。
4. **follow circle** —— 要先建事件表再反推 f(t),是滑条里最费脑的一块。
5. **反向箭头 + 刻度点** —— 脉动公式源码里已经是 f(t),照搬即可。
6. **HUD**(分数/连击/准确率)—— 素材与排版规则都齐了。
   ⚠️ `ScoreOverlap` / `ComboOverlap` 默认是 **0**,只有 `HitCircleOverlap` 是 -2。
7. **打击音** —— 对"看回放"的体感提升最大。`replayviewer-js` 的
   `src/player/hitsoundSchedule.ts` 是预计算且已 scrub-correct 的,值得借鉴
   (MIT,但它的 `assets/lazer-defaults/*.wav` 是 CC BY-NC,音频素材要另外考虑)。

## 8. 验证手段

```bash
npm test                                  # 838 通过
npx tsc --noEmit && npx vite build
npm run dev                               # localhost:5173,丢一个 .osr 进去
```

真实素材放 `fixtures/`(不入库):`.osr` / `.osu`,皮肤放 `fixtures/user/*.osk`。
缺素材时相关测试**跳过**而非失败。

**渲染侧的观感只能肉眼验。** 测试能锁"调用序列/尺寸/顺序",锁不住"看起来对不对" ——
本项目历史上四个渲染 bug 全是用户实测发现的。改完渲染务必让用户看一眼。




