# 技术问题与决策记录

> 最后更新:2026-08-24

本文档记录已确认的事实、待验证的风险、以及做过的技术决策及其理由。
新增条目请标注日期与状态。状态取值:`待验证` / `已确认` / `已解决` / `已否决` / `搁置`。

---

## A. 阻塞级风险(必须在 M0 内解决)

### A1. osu-parsers 能否在浏览器里跑通 .osr 解析 —— ✅ `已解决`(2026-08-23)

**结论:能,且不需要任何 polyfill。** M0 的成败点已排除。

三条原始风险的实测结果:

| 风险 | 结果 |
|---|---|
| 1. 依赖 Node 的 `fs` / `Buffer`? | **否**。osu-parsers 4.1.7 的 `exports` 里 `node` 与 `import` 两个条件指向不同产物;`lib/browser.mjs` 只 import `osu-classes` + `lzma-js-simple-v2`,`node:fs/promises` / `node:path` 只出现在 `lib/node.mjs` 里 |
| 2. LZMA 实现是否浏览器可用? | **可用**。唯一运行时依赖 `lzma-js-simple-v2` 是纯 JS,零 Node API 引用 |
| 3. 还能解当前格式版本吗? | **能**。stable(`gameVersion` 20260412 / 20260312)与 lazer(30000016)都解得开 |

**验证链条**(三层,逐层收紧):

1. 静态:`grep` 两个产物的 import,确认 Node 专有 API 只在 node.mjs
2. 打包:`vite build` 产出的 chunk 名字就是 `browser-*.js`(说明 Vite 按 `import` 条件解到了 browser.mjs),且 `dist/assets/*.js` 里 `node:` 与 `Buffer` 引用数为 **0**(唯一命中是 replayLoader 一句错误提示的字符串字面量)
3. 实跑:headless Chrome 加载真实 `.osr`,经我们自己的 `loadReplay()` 解析 —— 4 个样本(stable NM / stable HDFL / lazer NM / lazer AP)全部通过,并在真实帧数据上验证了 3000 个时刻的顺序 vs 乱序 `stateAt` 结果逐位一致

**性能**(Node 侧实测,浏览器同量级):16156 帧 / 71 KB 文件 **175 ms**;4377 帧 / 27 KB **43 ms**。一次性成本,可接受。

**打包体积**:解析器 + LZMA 独立成 chunk。`loadReplay()` / `loadBeatmap()` 都用动态 `import()` 让它不进首屏;写成 `const { ScoreDecoder } = await import('osu-parsers')` 而非把整个命名空间存下来,是为了让 Rollup 能 tree-shake。

体积随用到的 decoder 变化:

| 阶段 | 引入的 decoder | chunk | gzip |
|---|---|---|---|
| 整命名空间 cast(最初写法) | 全部 | 145 kB | 42 kB |
| M0:只有 `ScoreDecoder` | 1 个 | **71 kB** | **22 kB** |
| M1:加上 `BeatmapDecoder` | 2 个(+ 它内部依赖的 `StoryboardDecoder`) | 141 kB | 41 kB |

即 `.osu` 解析基本抵消了 tree-shaking 的收益 —— 因为 `BeatmapDecoder` 会拉进故事板解析。若将来要压,可考虑只在需要故事板时才走完整路径。`node:` 引用在各阶段**恒为 0**。

**回归保护**:`src/core/load/replayLoader.test.ts` 会自动纳入 `fixtures/*.osr` 下的任意样本(`.osr` 不入库,所以是条件执行:没素材就跳过)。注意该测试跑在 Node 下,走的是 `node.mjs`,测的是**字段映射**;浏览器那条路径由上面第 2、3 层覆盖。

### A2. 判定结果能否复现原始成绩 —— 🟡 `骨架已建`(2026-08-23)

回放分析类项目最深的坑。给定 .osu + .osr,我们自己模拟出来的分数/连击/准确率**必须**和 .osr 头部记录的原始成绩一致,否则整个 timeline 都是错的。

难点:

- **回放可能是 stable 录的,也可能是 lazer 录的**,判定规则有差异
- lazer 的滑条尾判定与 stable 不同(`ClassicMod` / `LazerClassicScoreMod` 相关)
- 滑条头判定在 lazer 有 "slider head accuracy" 的变化
- stable 有一堆历史遗留的容差行为(notelock、hit window 取整、`OD` 到 hit window 的换算)
- 回放帧的时间戳精度和插值方式会影响边界判定

**验证方式**:准备一组 .osr 测试样本(覆盖 stable/lazer、各种 mod、含滑条密集图),断言模拟结果 == .osr 头部成绩。这套测试要在 M1 就建起来,不能等到 M5。

**比对基准已就位**(2026-08-23):`info.statistics`(`Map<HitResult, count>`)是判定计数的权威来源,`info.totalScore` / `maxCombo` / `accuracy` 是分数侧的。注意 osu-classes 的 `HitResult` 编号与我们内部枚举不同,需映射(见 B4)。stable 回放还自带 `replay.lifeBar`,可用于交叉验证 HP(见 D1)。

**测试骨架已建**(`src/core/sim/judgementAccuracy.test.ts`),分三层,从"现在就能验"到"要等判定器":

| 层 | 验什么 | 现状 |
|---|---|---|
| L1 | 物件数 == `.osr` 判定总数;准确率可由计数反推;回放帧覆盖谱面时间范围 | ✅ **已通过,4/4**(见 B9) |
| L2 | 理论最大 combo == FC 回放的 maxCombo | 🟡 下界已验;精确值需滑条 tick(M2) |
| L3 | 模拟出的 300/100/50/miss、maxCombo、accuracy、totalScore == 头部成绩 | ⬜ 等判定器(24 个 `todo` 占位) |

**样本**:`fixtures/` 下有 4 组完整配对(stable NM / stable HDFL / lazer NM / lazer Moonlight),另有 1 个只有回放没有谱面的(`lazer-ap`,留作降级路径测试)。配对方式是按 `.osr` 头部的 `beatmapHashMD5` 去本机 osu! Songs 库与 `.osz` 包里扫 MD5,命中 5/6。素材不入库,测试对缺失是跳过而非失败。

**已知会影响 A2 的未实现项**:物件堆叠(D9)—— lazer 的命中检测用 `StackedPosition`,不做堆叠则密集段的判定位置会偏。

**参照物**:danser-go 虽然不做渲染后端了,但它是一个成熟的 Go 实现,可以本地跑它来交叉验证我们的判定结果。它自己也有判定不完全对上的 issue,说明这事确实难。

---

## B. 已确认的事实

### B1. danser-go 的能力边界 —— `已确认`(2026-08-23,核对其 README)

有:`-start` / `-end`(秒)、`-speed`、`-pitch`、`-record`(走 FFmpeg 出 mp4)、`-ss=20.5`(单帧截图)、`-mods2`(lazer 风格 mod JSON,带 per-mod settings)。

没有:交互式 seek / scrub / 暂停 / 逐帧接口、headless 模式、任何推流能力。

硬性要求 OpenGL 3.3+ 真实 GPU(macOS 因 OpenGL 支持差而不被支持)。

**结论**:不适合做本项目后端。详见 `ARCHITECTURE.md` 第 0 节。

### B2. 依赖库版本 —— `已确认`(2026-08-23,查 npm registry)

| 包 | 版本 | 最后发布 | 用途 |
|---|---|---|---|
| `osu-parsers` | 4.1.7 | 2024-04-26 | .osu / .osb / .osr 解析 |
| `osu-classes` | 3.1.0 | 2024-04-26 | 基础类型层 |
| `osu-standard-stable` | 5.0.1 | 2025-04-06 | std ruleset(stable 版判定/难度) |

全部 MIT,作者 kionell。基于 osu!lazer 源码移植。

**注意**:包名叫 `*-stable`,是 **stable 版**的 ruleset 实现。我们要的是 lazer 判定体系(M5),届时可能需要自己改造或移植 lazer 的 `ScoreProcessor`。M0-M4 先用它。

### B3. 本机环境 —— `已确认`(2026-08-23)

Node v23.0.0 / npm 10.9.0 / pnpm 可用 / git 2.50.1。

本机有 Chrome(`C:\Program Files\Google\Chrome\Application\chrome.exe`),可用 `--headless=new --virtual-time-budget=N --dump-dom` 做无人值守的浏览器验证 —— A1 第 3 层就是这么跑的。注意 `--virtual-time-budget` 下 `performance.now()` 是虚拟时钟,**测出的耗时无意义**,要测性能得用真实浏览器或 Node。

### B4. `.osr` 解析结果的实际字段形状 —— `已确认`(2026-08-23,实测 10 个真实文件)

`ScoreDecoder.decodeFromBuffer(bytes, true)` 返回 `Score`:

```
Score
├─ info: ScoreInfo        // 头部成绩
└─ replay: Replay | null  // null = 该文件不含帧数据
   ├─ gameVersion  number
   ├─ frames       LegacyReplayFrame[]  // { startTime, interval, position: Vector2, buttonState }
   └─ lifeBar      LifeBarFrame[]       // { startTime, health }
```

几个会咬人的点:

- **`info.rank` / `info.passed` 是假数据。** `.osr` 里根本没存这两项,osu-parsers 从准确率反推。实测一个 0 miss / 98.66% 的成绩也返回 `rank="F"` / `passed=false`。**不要显示它们。**
- **`info.mods` 恒为 `null`。** 它是 `ModCombination`,需要先给 `ScoreInfo` 设 `ruleset` 才能物化。真正存着的是 `info.rawMods` 位掩码。
- **`info.rawMods` 的类型是 `string | number`。** `.osr` 解码走数字分支(位掩码,实测 10/10);从 JSON 构造 `ScoreInfo` 时会变成 `"HDDT"` 这样的 2 字符缩写拼接串(osu-classes 自己用 `.match(/.{1,2}/g)` 解)。接在线成绩 API 时会撞上这个。
- **`info.username` 可能是空串。** 本地 stable 回放不记录本机玩家名。
- **`info.statistics` 是 `Map<HitResult, count>`,判定计数的权威来源** —— `{1:0, 2:2, 3:17, 5:747}` 对应 miss/50/100/300。注意 osu-classes 的 `HitResult.Great = 5`,与我们内部枚举(`Great = 4`)不是同一套编号,A2 比对时要映射。
- **`replay.lifeBar` 只有 stable 有**(实测 33~96 帧),lazer 一律为空数组。这是 stable HP 曲线的现成 ground truth,**D1 可以直接拿它对答案**。
- **`-12345` seed 哨兵帧 osu-parsers 已经替我们剔掉了**(实测 10/10 为 0 个)。`buildReplayFrames` 里那道过滤是纯防御,保留无害。
- **`gameVersion` 才是判断 stable/lazer 的依据,不能看文件名。** 实测一个叫 `solo-replay-osu_*.osr`(lazer 导出的命名风格)的文件 `gameVersion` 是 20260312,其实是 stable 格式。lazer 从 `3000_0000` 起跳。
- **lazer 回放的帧起点可以是负数**(实测 -1781 ms,前 105 帧都在 0 之前)。`timeline.startTime` 取物件范围与帧范围的并集,已经吃下了这种情况。

### B5. 光标坐标会跑出 playfield —— `已确认`(2026-08-23)

playfield 是 512×384,但实测**两种格式都会越界**:stable 到 `x∈[-20, 527]` / `y∈[-27, 397]`,lazer 到 `x∈[-21, 530]` / `y∈[-37, 405]`。

这是真实输入,不是脏数据(玩家把鼠标移到判定区外很正常)。所以:

- `frames.x` / `frames.y` 用 `Float32Array`(有符号)是对的,**不要 clamp**
- 渲染层**不能**假设坐标落在 `[0, 512] × [0, 384]`,画光标与拖尾时要么裁剪要么允许画到判定区外

### B6. 回放帧存在零间隔(时间戳重复) —— `已确认`(2026-08-23,实测 4 个文件)

`frames.time` 是**非严格**升序。真实回放里有 `interval == 0` 的帧,导致相邻帧时间戳相同:

| 样本 | 帧数 | 重复时间戳对数 | 其中按键状态不同 |
|---|---|---|---|
| stable NM | 16156 | 69 | 25 |
| stable HDFL | 5411 | 21 | 12 |
| lazer NM | 4377 | 43 | **42** |
| lazer AP | 3922 | 16 | 多数 |

**关键含义:一次点击可以整个发生在零长度间隔内。** 例如 stable 的 `t=7156` 是 `buttonState=0` 紧跟 `buttonState=10`(位置完全相同)。lazer 尤其明显 —— 43 对里有 42 对按键不同,说明它把按键变化单独发成一帧。

由此得出三条硬约束:

1. **绝不能按时间戳去重** —— 会直接丢掉按键。M1 写判定时若想"规整化"帧序列,这是第一个坑。
2. **排序必须稳定**。`buildReplayFrames` 依赖 `Array.prototype.sort` 的稳定性(ES2019 起为规范要求)来保住零间隔帧的先后 —— 否则"先松开后按下"可能被翻成"先按下后松开"。
3. **`cursorAt` 在重复时刻取最后一帧**(`lastIndexAtOrBefore` 的自然结果),这是对的:后一帧是更新的状态。插值时 `span == 0` 会走 `f = 0` 分支,不会除零。

已由 `frames.test.ts` 覆盖。

### B7. lazer 公式对照结果 —— `已确认`(2026-08-23,对照 ppy/osu master)

`difficulty.ts` 里的公式过去只是"按印象写的",这次逐条对了源码,**发现三处偏差并已修正**:

| 项 | 原实现 | lazer 实际 | 影响 |
|---|---|---|---|
| `difficultyRange` | `mid - (mid-min)(5-v)/5` | `mid + (mid-min)(v-5)/5` | ✅ 数学等价,无需改 |
| `fadeInFromPreempt` | `400*min(1, p/450)` | 同 | ✅ 一致 |
| `preemptFromAR` | 返回原始 double | `DifficultyRangeInt` —— **`(int)` 截断** | ❌ 已修。整数/一位小数 AR 本来就落在整数上,但 mod 调整过的 AR 会出小数(HR 把 AR ×1.4) |
| `hitWindowsFromOD` | 返回原始 double | **`Math.Floor(x) - 0.5`** | ❌ 已修。**影响判定边界**:OD 8 的 great 原始值 32,实际窗口 31.5 —— 偏差恰好 32ms 的一击不算 300 |
| `radiusFromCS` | `54.4 - 4.48cs` | 同 **× 1.00041** | ❌ 已修。lazer 传 `applyFudge: true` |

关于那两个"怪"常数,lazer 源码里的理由:

- **`- 0.5`**:用来复现 stable 按整数毫秒比较命中偏差的行为。这是 A2 最容易栽的地方 —— 差 0.5ms 在边界击上就是 300 与 100 之别。
- **`1.00041`**(`broken_gamefield_rounding_allowance`):2013-05-04 前的 osu 构建在宽屏下把判定区尺寸向下取整。影响不到 1 个游戏像素,但 lazer 仍然应用它,注释明确说是为了**回放还原的保真度**。本项目做的就是回放还原,所以照抄。
- miss 窗口是常数 400,**不参与** floor/-0.5,也不随 OD 变化。

对照过的源文件已记在 `difficulty.ts` 顶部。测试(`difficulty.test.ts`)里的期望值一律按 lazer 公式**手算**,不从本项目实现反推。

### B8. `.osu` 解析结果的实际字段形状 —— `已确认`(2026-08-23,实测 4 个真实谱面)

`new BeatmapDecoder().decodeFromBuffer(bytes, false)`(第二参 = 不解故事板)返回 `Beatmap`:

```
Beatmap
├─ fileFormat      number    // 实测均为 14
├─ originalMode    number    // 0 = std。非 0 必须拒绝
├─ general         { audioFilename, audioLeadIn, stackLeniency, previewTime, … }
├─ difficulty      // 全是 getter
│  └─ { circleSize, drainRate, overallDifficulty, approachRate, sliderMultiplier, sliderTickRate }
├─ metadata        { title, artist, creator, version, beatmapId, beatmapSetId, … }
├─ events.breaks   BeatmapBreakEvent[]  // { startTime, endTime }
├─ controlPoints   // timingPoints 等,算滑条 tick 要用(M2)
└─ hitObjects      HittableObject | SlidableObject | SpinnableObject
```

会咬人的点:

- **`BeatmapDecoder.decodeFromBuffer` 是同步的**,`ScoreDecoder.decodeFromBuffer` 才是 async。两个 decoder 不一致,容易写错。
- **`hitType` 是位域不是枚举值**:`1`=Normal `2`=Slider `4`=NewCombo `8`=Spinner `128`=Hold(mania)。一个 slider 的 hitType 是 `2|4 = 6`。实测取值集合 `{1, 2, 5, 6, 12}`。
- **combo 索引解析器不填**:`currentComboIndex` / `indexInCombo` 实测恒为 `undefined`,只有 `isNewCombo` / `comboOffset` 是解析出来的。必须自己走一遍 lazer 的 `UpdateComboInformation`。
- **而且不能只看 `isNewCombo`**:lazer 的 `OsuBeatmapProcessor.PreProcess()` 会**强制**把「第一个物件」与「转盘之后的第一个非转盘物件」标成新 combo,即使 `.osu` 里没标(注释说 legacy 解码器通常保证了,但编辑器不强制)。漏掉这一步 combo 编号与圈内数字整体错位。
- **难度值是 float32**,取出来会看到 `9.300000190734863`(AR 9.3)、`3.700000047683716`(CS 3.7)。**不要四舍五入** —— lazer 同样以单精度参与后续计算。
- **slider 的 `endTime` 解析器已算好**(由 `distance / velocity` 推出),spinner 有显式 `endTime`,circle 没有 `endTime` 字段。但 `endTime` 只在具体类上,`hitObjects` 的静态类型是基类 `HitObject[]`,取值要按结构断言 + 运行时校验。
- **`nestedHitObjects` 是空的** —— 滑条 tick / repeat 的嵌套物件需要 ruleset 才能生成,解析器不给。maxCombo 要精确对上就得自己算(M2)。
- **`SlidableObject.path` 是完整的 `SliderPath`**,带 `curveType`('P'/'L'/'B'/'C')、`controlPoints`、`expectedDistance`,以及 `positionAt()` / `progressAt()` / `curvePositionAt()` 方法。**M2 的滑条渲染可以直接用,不必自己写路径细分。**

### B9. 物件数 == 判定总数(A2 的第一条强断言)—— `已确认`(2026-08-23,实测 4/4)

`.osr` 头部的 `count300 + count100 + count50 + countMiss` **恰好等于谱面的物件总数**:

| 样本 | 物件数 | 300/100/50/X | 和 |
|---|---|---|---|
| stable | 766 | 747/17/2/0 | **766** ✅ |
| stable-hdfl | 302 | 253/44/2/3 | **302** ✅ |
| lazer | 248 | 243/5/0/0 | **248** ✅ |
| lazer-moonlight | 929 | 890/35/0/4 | **929** ✅ |

意义:这四个数记的是"产生了主判定的物件数",滑条 tick / repeat **不计入**。所以它是一条不依赖判定器就能跑的强断言 —— 对不上就说明物件解析漏了或多了,而那会让**每一条**后续判定错位。已落在 `judgementAccuracy.test.ts` 的 L1。

### B12. `countMiss == 0` **不等于** full combo —— `已确认`(2026-08-23,踩坑记录)

**这条纠正了 B9 里一个基于错误前提的推论。**

stable 里漏掉滑条尾或某个刻度会产生 **slider break**:它**打断 combo,但不计入 miss**
(整条滑条仍按命中了多少部件给出 100 或 50)。所以 0 miss 的成绩完全可以没拿到
理论最大 combo。

**踩坑过程**:我曾想用"FC 回放的 maxCombo"反推滑条刻度数 ——
`stable`:`1151 - (物件 766 + 尾 340 + repeat 27) = 18`,于是断定该图有 18 个刻度。
实现刻度公式后算出 **19**,以为是浮点边界问题,去查 `GetPrecisionAdjustedBeatLength`。

手算下来公式是对的:该图唯一带刻度的长滑条(t=220431,inherited SV `-333.333`)
`precisionAdjustedBeatLength = 327.869 × 3.3333 = 1092.9` →
`Velocity = 170 / 1092.9 = 0.15555` → `scoringDistance = 51.0` → 19 个刻度。
**错的是前提**:该回放理论最大 1152、实得 1151,在最后一条滑条上断了一次 combo。

**教训**:`.osr` 的 maxCombo 只能当**上界**,不能当等式 —— 除非已知是真 full combo。
`lazer.osu` 那张就是真 FC(理论 346 == 实得 346),它才是精确确认刻度公式的那个样本。

### B13. 滑条刻度与理论最大 combo —— `已确认`(2026-08-23)

`tickDistance = velocity × beatLength / sliderTickRate`,刻度按该步长从 `tickDistance`
起铺,条件 `distance < pathDistance - velocity × 10`(**严格小于**),每个 span 各铺一遍。

⚠️ lazer 注释明确说**不要**把 `scoringDistance` 写成 `BASE_SCORING_DISTANCE × sliderMultiplier`
—— 它刻意保留 stable 的浮点误差("intentionally introducing floating point errors to
match stable")。所以要走 `velocity × beatLength`,不能"化简"。

`beatLength` 取该滑条起点处生效的**非继承** timing point(`controlPoints.timingPointAt()`)。

**理论最大 combo** = 物件数 + 刻度 + repeat + 滑条尾。实测:

| 样本 | 物件 | 刻度 | repeat | 尾 | 理论 | `.osr` 实得 |
|---|---|---|---|---|---|---|
| stable | 766 | 19 | 27 | 340 | **1152** | 1151(断过一次) |
| lazer | 248 | 0 | 3 | 95 | **346** | **346** ✅ 精确 |

`lazer.osu` 刻度为 0 是正常的:`tickDistance ≈ 170` 大于路径长度 128,循环一次都不进。

⚠️ **未实现**:刻度/尾的**判定**(玩家是否真的按住滑过)。那需要跟踪光标是否在
follow circle 内,属 M2。目前只算"理论"值,用作上界断言。

### B11. `osu-standard-stable` 与当前 lazer master 有实质分歧 —— `已确认`(2026-08-23)

调研过 `osu-standard-stable@5.0.1`(同作者 kionell 把 stable ruleset 移植到 TS)。
它内容很多:**堆叠、滑条 tick/repeat/tail 嵌套物件、全部 mod、命中窗口、星数/pp**,
且浏览器安全(只 import `osu-classes`,零 Node API)。

**但它与当前 lazer master 有两处实质分歧:**

| 项 | 当前 lazer master | osu-standard-stable 5.0.1 | 本项目 |
|---|---|---|---|
| preempt | `DifficultyRangeInt` = `(int)` 截断 | `Math.fround(...)`,**不截断** | `Math.trunc` ✅ |
| 圈半径 | `CalculateScaleFromCircleSize(cs, applyFudge: **true**)` → ×1.00041 | **无** fudge | 带 ×1.00041 ✅ |

AR 9.15 下 preempt:lazer 得 **577**,该包得 **577.5**。而堆叠阈值是
`timePreempt * stackLeniency`,分歧会**传导进堆叠结果**。

**决定:不引入该依赖**,自己实现堆叠,把它当 reference implementation 交叉参考。
理由:本项目的全部价值系于 A2(复现原始成绩),而 `difficulty.ts` 是对照 master
逐条验证过的(那次对照发现了三处真 bug),不能为省事倒退。

⚠️ 若将来要用它的**滑条 tick 生成**(M2 的 maxCombo 精确计算需要),同样要先核
它的 tick 间隔算法是否与 master 一致,不能直接信。

### B16. lazer 的 standardised 记分(ScoreV2)—— ✅ `已实现且精确复现`(2026-08-24)

`src/core/sim/lazerScoring.ts`。核 `ScoreProcessor.cs` + `HitResult.cs`。

```
Accuracy      = currentBaseScore / currentMaximumBaseScore
comboProgress = currentComboPortion / maximumComboPortion
accProgress   = currentAccuracyJudgementCount / maximumAccuracyJudgementCount

分数 = round( 500000·Accuracy·comboProgress + 500000·Accuracy⁵·accProgress + bonusPortion )
```

累积(`ApplyResultInternal`):

```
若 MaxResult.AffectsAccuracy():  currentMaximumBaseScore += 基础分(MaxResult); accCount++
若 Type.AffectsAccuracy():       currentBaseScore += 基础分(Type)
若 Type.IsBonus():               currentBonusPortion += 基础分(Type)
否则若 Type.IsScorable():         currentComboPortion += 基础分(MaxResult) · combo^0.5
```

**三处与 ScoreV1 根本不同:**

1. **combo 开平方**(`COMBO_EXPONENT = 0.5`)后归一化 → 总分恒 ≤ 100 万。
   ScoreV1 是线性放大且无上限,所以长图能上千万。
2. **准确率进了两次** —— 一次线性(乘 comboProgress 那半),一次五次方。
   `Accuracy⁵` 让 99% 与 100% 的差距被显著放大。
3. **上限来自"完美走一遍"的模拟**(源码里 `Reset` 会跑一次 autoplay)。
   所以算分前必须先按满分遍历整张图 → `lazerMaxima()`。

**基础分表**(`GetBaseScoreForResult`):Great 300、Ok 100、Meh 50、
**SliderTailHit 150**、LargeTickHit 30、SmallTickHit 10、SmallBonus 10、LargeBonus 50。

#### 滑条末端:lazer 与 stable 的根本分歧

| | lazer | stable(`ClassicSliderBehaviour`) |
|---|---|---|
| 末端的 MaxResult | `SliderTailHit`(基础分 **150**) | `LargeTickHit`(30) |
| 末端的 MinResult | `IgnoreMiss` | `LargeTickMiss` |
| 漏掉末端 | **不断 combo,也不加 combo** | **断 combo** |

关键依据:`HitResultExtensions.AffectsCombo` 的列表里**没有 `IgnoreMiss`**,
而 `LargeTickMiss` 在。所以 combo 规则必须按记分体系分支 —— 见 `judgement.ts`
的 `ScoreModel`。这不是"换个算分函数"能解决的。

#### 验证结果

| 样本 | `.osr` | 我们 | 差 |
|---|---|---|---|
| `lazer` | 966,821 | **966,821** | ✅ **0** |
| `lazer-moonlight` | 741,861 | 743,545 | 1684(0.23%) |

`lazer-moonlight` 的 0.23% 完全能被它已知的判定偏差解释(1 个 300 判成 100、
maxCombo 多 1)。另外 `accCount` 两边恰好相等(346/346、1258/1258)——
`lazerMaxima` 独立构造的物件图与判定器产生的事件图一致,是个有力的交叉验证。

#### ⚠️ lazer 的分数**会回跌**(反直觉但正确)

`Accuracy` 是个 running 比值:一次 miss 让分母 `currentMaximumBaseScore` 增长
而分子不变,准确率就掉;而 `acc` 与 `acc⁵` 都是**乘性**因子,所以即使
`comboProgress` 在涨,总分也可能净减少。真实 lazer 里 miss 的瞬间显示分数确实回跌。

我最初写了"分数单调不减"的断言,两个 lazer 样本都失败 —— **前提错了,不是代码错**。
现在断言的是那个更精确的性质:**回跌只发生在拿不到满档的判定上**。

#### 仍未实现

- **转盘的 bonus 刻度**(`SpinnerTick` → `SmallBonus`、`SpinnerBonusTick` → `LargeBonus`)。
  `bonusPortion` 是加在 100 万**之外**的,漏掉它会让带转盘的图偏低。
  `lazer.osr` 无转盘所以不受影响;`lazer-moonlight` 有 2 个。
- **lazer 的 mod 系数**。lazer 每个 mod 自带 `ScoreMultiplier`,与 stable 的表**不同**,
  现在硬编码为 1。两个样本都是 NM 所以没暴露。

### B14. stable 分数公式的难度系数 —— `已实现`(2026-08-23,`src/core/sim/stableScoring.ts`)

公式在 `LegacyRulesetExtensions.CalculateDifficultyPeppyStars(difficulty, objectCount, drainLength)`:

```
objectToDrainRatio = drainLength != 0
    ? clamp((decimal)objectCount / drainLength * 8, 0, 16)
    : 16

difficultyPeppyStars = (int)round(
    (HP + OD + CS + objectToDrainRatio) / 38 * 5
)
```

`drainLength` 是可玩时长(秒)减去 break。

⚠️ **两处必须照抄的类型细节**(lazer 注释写明原因):

1. `DrainRate` / `OverallDifficulty` / `CircleSize` 要按 **float → double → decimal** 逐级转。
   注释说这些 cast "ARE IMPORTANT AND MUST REMAIN" —— 直接 float→decimal 会把单精度
   值"悄悄"清理干净,而当年 x87 FPU 不是那样。
2. 全程用 `decimal` 而非 double。理由:.NET Framework 的浮点运算走 x87 寄存器,是
   **80 位**宽,比 float 和 double 都宽;现代 .NET 走 SSE。用 `decimal` 当高精度替身。
   lazer 承认有一张 ranked 图仍然对不上,算"acceptable casualty"。

JS 里没有 `decimal`,只有 float64 —— 这是一处**已知的潜在偏差来源**,实现时要留意。

**实现后补充的三条**(实现时才浮出水面,记下来免得下次重新踩):

3. **`基础分 / 25` 是整数除法。** lazer 在那一行标了
   `PossibleLossOfFraction (intentional to match osu-stable)` —— 是刻意保留 stable 的
   行为,不是笔误。300/25=12、100/25=4、50/25=2 都恰好整除,所以**用这三个值测不出来**;
   测试里要拿一个不整除的基础分(比如 60)才能卡住。
4. **`drainLength` 用末物件的 `startTime`,不是 `endTime`。** 而且每个时间戳
   **先各自 `round` 再相减**,最后那次除以 1000 是整数除法:
   ```
   drainLength = (round(末物件.startTime) - round(首物件.startTime) - Σbreak) / 1000
   ```
   若谱面以长转盘结尾,用 `endTime` 会让 drainLength 明显偏大 → 物件密度偏小 → 难度系数可能少 1。
5. **只有 HitCircle / Slider / Spinner 吃 combo 加成。** 滑条的嵌套部件(刻度 10 分、
   头/repeat/末端 30 分)只进 accuracyScore。我们把"滑条整体判定"挂在带 `counted` 的
   那个事件上(stable 是末端、lazer 是头),所以代码里的判据是"有没有 `counted`",
   **不是看 part 名字** —— 同一个 part 名在两种记分口径下含义不同,按名字判会错。

**验证结果**(2026-08-23):

| 样本 | `.osr` 分数 | 我们 | 比值 | 说明 |
|---|---|---|---|---|
| `stable-hdfl` | 1,316,450 | 1,368,465 | **1.040** | 公式基本正确;4% 的差来自 combo 差 7 |
| `stable` | 20,931,102 | 7,078,362 | 0.338 | maxCombo 412 vs 1151 —— 见 D13 |
| `lazer` / `lazer-moonlight` | — | — | — | lazer 用 standardised 记分,与 ScoreV1 **不可比** |

⚠️ **分数被 combo 加成主导**,所以它不是一个独立的正确性指标:combo 差多少,分数就
成比例地差。测试因此只在 `maxCombo` 精确对上时才断言分数精确相等,否则只检查量级
(比值 0.2~2,能抓住"漏乘难度系数"这类整体性错误)。真正的把关点仍是 combo。

### B15. 滑条跟踪(tracking)的确切规则 —— `已核源码,待实现`(2026-08-23)

下一步要做的滑条刻度/尾判定,规则全部核完了。记在这里是因为**研究是最贵也最容易出错的部分** —— 实现时照这份抄,不要重新推导。

来源:`osu.Game.Rulesets.Osu/Objects/Drawables/SliderInputManager.cs` 与
`DrawableSliderBall.cs`(2026-08-23 核对 master)。

#### 跟踪状态

```
Tracking = (!slider.AllJudged || t <= slider.endTime)
        && 光标在 follow area 内
        && 按的是"有效的键"
```

#### follow area:有滞回(hysteresis)

```
followRadius(expanded) = expanded ? radius * 2.4 : radius
```

`FOLLOW_AREA = 2.4f`(`DrawableSliderBall` 的常量),**乘的是物件半径**,不是绘制尺寸。

⚠️ **每帧传入的 `expanded` 是"当前是否正在跟踪"** —— 于是:
- 已在跟踪 → 用**大**圈判定(不容易掉)
- 未在跟踪 → 必须进**小**圈才能(重新)开始跟踪

这个滞回不能省,否则在边缘会疯狂抖动。

#### 位置比较

```
followProgress = clamp((t - startTime) / duration, 0, 1)
ballPosition   = slider.curvePositionAt(followProgress)   // 理论曲线位置,不是绘制变换
判据           = 距离平方 <= radius²                       // 平方比较,且**含等号**
```

注意 `followProgress` 被钳到 `[0, 1]`,所以滑条开始前/结束后用的是头/尾的曲线位置。

#### "有效的键" —— 这条最容易漏

不是简单的"任意键按住"。lazer 的注释说明它防的是一种滥用:**滑条开始前就按住一个键,再点一下第二个键**。

```
hitAction = 命中滑条头的那个键

若 hitAction 存在 且 (timeToAcceptAnyKeyAfter 未设置 或 t <= timeToAcceptAnyKeyAfter):
    只有 action == hitAction 算有效
否则:
    左右键任一都算
```

`timeToAcceptAnyKeyAfter` 的维护:
- 滑条头未命中 → 置 `null`
- 滑条头已命中 且 该值当前为 `null` → 若**上一帧**另一个键没被按住,则置为 `t`

即:**命中滑条头的那个键是唯一的跟踪键,直到观察到某一帧另一个键处于松开状态**,之后两个键都可以跟踪。lazer 特意存**时刻**而不是布尔值,为的是正确处理回退。

#### 嵌套物件何时判定(`TryJudgeNestedObject`)

| 部件 | 条件 |
|---|---|
| tick / repeat | `timeOffset >= 0` |
| tail | `timeOffset >= TAIL_LENIENCY` |

另外两个前提,**顺序守卫**:
- 必须 `slider.HeadCircle.Judged`
- tail 还要求最后一个 tick / repeat 已判定(否则记分与 combo 顺序会乱)

满足后:`Tracking ? HitForcefully() : (timeOffset >= 0 ? MissForcefully() : 不动)`。

#### 滑条头命中时的"追认"(`PostProcessHeadJudgement`)

这一步很容易漏,但影响判定结果:滑条头**被命中之后**,若光标此刻在**放大**的
follow area 内,会回头检查所有"已到时刻但未判定"的嵌套物件 ——
若它们**全部**都在放大圈内,就一次性全部判为命中;否则全部判为 miss。

之后 `updateTracking(allTicksInRange || 光标在未放大圈内)`。

#### 实现时还需要的东西

1. **嵌套物件的时刻**,不只是数量。现在 `sliderParts.ts` 只算 `tickCount`,
   要扩成生成 `{ kind, time, progress }` 列表(osu-classes 的 `EventGenerator`
   已经给全了,但要先补 `tickDistance`,这一步已经做了)
2. **`TAIL_LENIENCY` 的值** —— 在 `SliderEventGenerator` 里,尚未核
3. **每帧的按键状态**,而不只是"按下边沿"。现在 `extractPresses` 只取边沿,
   跟踪需要"某时刻哪些键处于按住状态" —— `cursorAt(frames, t).keys` 已经能给
4. **整条滑条的最终 300/100/50** —— 按命中的部件比例决定,这才是与 `.osr` 的
   计数口径对齐的关键(见 `judgement.ts` 里"滑条头不计 300/100/50"那段注释)

#### 一处必然的近似

lazer 是**逐渲染帧**跟踪(高频鼠标位置 + `IsRewinding` 历史),我们是**逐回放帧**。
回放帧率约 60~1000Hz,而 lazer 跑在显示帧率上并有 `IRequireHighFrequencyMousePosition`。
所以边缘擦过 follow circle 的瞬间可能判得不同 —— 这会是 A2 剩余偏差的嫌疑点之一,
实现后要用真实回放的 maxCombo 检验。

### B10. 真实谱面上的 `stateAt` 性能 —— `已确认`(2026-08-23)

核心架构主张(`stateAt` 是 O(log n + k),所以 seek 免费)在真实数据上成立。已固化为 `performance.test.ts`,每次 `npm test` 都跑:

- `buildTimeline` < 200ms(实测远低于)
- 单次 `stateAt` < 1ms 阈值,实测 μs 量级
- **随机 seek 与顺序播放同速** —— 这条最关键,证明实现里没有藏"从上一帧继续扫"的顺序依赖
- 同屏物件数有界(实测个位数~十几个,远小于物件总数)

⚠️ 一个反直觉的量:`maxVisualDuration` 可以很大。`stable.osu` 有一条 **6557ms** 的长滑条(distance 1020,低 SV),`lazer-moonlight.osu` 的收尾转盘长 **9754ms**。`activeObjectsAt` 的回溯窗口由它界定,所以密集图上一帧要扫几十个物件 —— 仍是有界的,但不是"几个"。阈值设宽是为了抓退化,不是卡性能。

---

## C. 技术决策

### C1. 用"预编译时间线"而非"checkpoint + 增量重放" —— `已解决`(2026-08-23)

初始建议是 checkpoint 方案,已修正。理由:回放的全部输入在加载完成时已完全已知,不存在实时交互,因此没有理由把模拟推迟到 seek 时。全量预编译后 seek 退化为二分查找,O(log n) 且零模拟。

完整推理见 `ARCHITECTURE.md` 第 1 节。

### C2. 时钟用 `AudioContext.currentTime`,不用 `<audio>.currentTime` —— `已解决`(2026-08-23)

`<audio>.currentTime` 的更新粒度受浏览器实现限制,抖动可达数十 ms,足以让 approach circle 视觉抖动。`AudioContext.currentTime` 由音频硬件时钟驱动,单调、采样精确。

### C3. 回放帧用 SoA(TypedArray)而非对象数组 —— `已解决`(2026-08-23)

典型回放约 30000 帧。对象数组会产生 30000 个 GC 对象;三块并行 TypedArray(time/x/y/keys)是连续内存,二分查找 cache 友好。

### C4. "渲染层不得持有跨帧状态"这条约束也管 canvas context —— `已解决`(2026-08-23)

架构上说"渲染层不得持有跨帧可变状态",最初只理解成"不要在类里缓存游戏状态"。实际上 **canvas 2D context 本身就是一份跨帧可变状态**。

踩到的具体形态:`DebugRenderer.drawTrail` 设了 `ctx.lineCap = 'round'` 却不复位。它在时间轴起点会提前 return(那时还没有任何回放帧),于是**同一时刻首次渲染与之后渲染差一个像素** —— 首帧的光标用默认 `'butt'` 描边,后续帧用上一帧泄漏进来的 `'round'`。`arc(0, 2π)` 是开放路径,线帽会影响接缝处。

这个 bug 的性质值得记下来:它**只在"先渲染别的时刻、再回到这个时刻"时出现**,顺序播放永远看不到 —— 与 D1 的 HP 分段是同一类陷阱。

修法两层:

1. `draw()` 开头把用到的 context 状态全部归零(`lineCap` / `lineJoin` / `globalAlpha`),保证一帧的输出不依赖上一帧留下什么
2. `drawTrail` 内部改用 `save()` / `restore()` 包住自己的改动,免得同一帧里后画的光标被它影响(拖尾在时间轴两端不绘制,否则光标外观会随"这一帧有没有拖尾"而变)

**发现方式**:headless Chrome 里对同一批时刻做"顺序渲染 vs 乱序渲染"的 `canvas.toDataURL()` 逐像素比对。人眼验收发现不了这种一像素差异 —— 这正是把"画面是否相同"变成客观判据的价值。

---

## D. 已知待解决的技术问题

### D1. HP 流失的分段计算 —— `待解决`

HP 同时受离散判定事件和连续被动流失影响,且流失**仅在 drain section 内生效** —— break 区间不流失,第一个物件之前不流失。

所以不能简单写成 `hp = lastEvent.hp - rate * (t - lastEvent.time)`,必须扣掉区间内的 break 时长。

这是最容易写错且最难发现的一处(顺序播放时误差会被后续事件"纠正"掉,只有 scrub 到 break 中间才暴露)。

**方案**:预计算 `DrainProfile`,把整条时间轴切成 (drain / no-drain) 交替的区间,并存每个区间起点的累积流失量前缀和。这样 `hpAt(t)` 也是 O(log n)。

**状态**(2026-08-23):数据结构与 `hpAt` 已实现并有单测覆盖(`query.test.ts` 里专门测了"break 内不流失""跨 break 只算 break 之外的时长""查询顺序不影响结果")。**仍缺的是 `drainPerMs` 的真实推导** —— 现在是外部传入的占位值。lazer 的 `HealthProcessor` 是靠二分搜索求"玩家刚好能活过全图"的流失率,依赖完整判定序列,不是能从 HP 值直接算出的常数。

**对答案的办法**:stable 回放自带 `replay.lifeBar`(实测 33~96 帧的 `{startTime, health}`),是现成的 ground truth。推出 `drainPerMs` 后可以直接与它比对。lazer 回放没有这个,只能靠 A2 的判定复现来间接验证。

### D2. 倍速的音高保持 —— `待解决`

`AudioBufferSourceNode.playbackRate` 变速会同时变调(即 Nightcore 效果)。若要保持音高,需要 time-stretching:

- SoundTouch.js(移植自 C++ SoundTouch,质量尚可)
- 自己写 phase vocoder(质量更好但复杂)
- 或直接接受变调(osu 玩家对 DT 变调本来就习惯)

**倾向**:M0 先接受变调(实现成本为零),把音高保持排到 M3 之后。需要确认用户预期。

### D3. 极低倍速与逐帧的音频处理 —— `待解决`

`playbackRate` 低于约 0.25 时音频质量崩坏,逐帧步进时更是完全无意义。

**方案**:设一个阈值(如 0.25x),低于此值或处于逐帧模式时直接静音,时钟切到 `ManualClock` 驱动。

### D4. 滑条体渲染 —— `待解决`(M2 专项)

lazer 的 slider body 不是画线,是用 depth buffer + 三角带做的立体渐变,靠深度测试让自重叠处不叠色。这是全项目最硬的单点技术。

路径生成本身也有量:Bezier / Catmull / 完美圆弧 / 线性四种曲线类型,加上 lazer `PathApproximator` 的细分算法(`osu-classes` 里应有 TS 移植,待确认)。

**策略**:M0/M1 用简陋画法(粗折线)占位,M2 专项攻克,不要在早期被它拖住。

### D5. 皮肤 fallback 链 —— `待解决`(M4)

stable 皮肤(.osk 就是 zip)有一堆隐式规则:`@2x` 高清变体、动画帧序列(`hit0-0.png`, `hit0-1.png`...)、`hitcircleoverlay` 分层、`skin.ini` 的 combo colour 覆盖、找不到时逐级回退到默认皮肤。

lazer 的 Argon / Triangles 皮肤**不是贴图,是代码画的**,要另外实现一套程序化绘制。

### D6. `osu-parsers` 格式版本时效性 —— ✅ `已解决`(2026-08-23)

最后发布 2024-04,但实测能解 2026 年的 stable(`gameVersion` 20260312 / 20260412)与 lazer(30000016)`.osr`,10/10 通过;`.osu` 谱面 4/4 通过(fileFormat 14)。见 A1 与 B8。

### D7. 变速 mod 的播放倍率 —— ✅ `已解决`(2026-08-23)

回放帧的时间戳是**谱面时间**,DT 的含义是谱面时间相对真实时间跑得更快。所以要忠实还原一段 DT 回放,时钟推进谱面时间的速率必须是 1.5×,用户设定的倍速再乘在这之上。

已实现:`PlaybackController` 把 mod 倍率与用户倍速**分开**存,时钟速率 = `modRate × userRate`。于是"1× 播放"表示按玩家当时的实际节奏播,而不是"谱面时间 1ms/ms"。载入回放时按 `rawMods` 重设 —— 必须每次重设,否则上一段 DT 回放的倍率会漏到下一段 NM 回放上(已写测试卡住)。

HUD 会显示 `用户倍速 × mod 倍率 = 实际倍率`。

⚠️ 该函数**只对 stable 准确**:lazer 的 DT/HT 倍速可由玩家自定义(0.5×~2×),legacy 位掩码里读不到,一律返回 1.5 / 0.75 会出错。属于 M5 要处理的"lazer mod 有损投影"问题(见 A1 与 `formatLegacyMods` 的注释)。

### D8. 渲染层没有常驻的自动化回归保护 —— `待解决`
M0 验收 3 / 5 的逐像素判据(headless Chrome + `canvas.toDataURL()` 顺序 vs 乱序比对)是用临时页面跑的,**没有留在仓库里**。

它抓出了 C4 那个一像素的状态泄漏 —— 说明这个判据有真实价值,不该只跑一次。

**方案**:做成 `vitest --browser`(需 Playwright)或独立的 Playwright 用例。M1 换 PixiJS/WebGL 渲染器时这层保护更重要,因为 WebGL 的状态泄漏面比 canvas2d 大得多。

现状:改渲染器要靠手动重建那个页面。

### D9. 物件堆叠(stacking)—— ✅ `已解决`(2026-08-23)

已实现,见 `src/core/sim/stacking.ts`。算法逐行对照 `ppy/osu` master 的
`OsuBeatmapProcessor.cs`,并与 `osu-standard-stable@5.0.1` 交叉比对。

**实测效果**(`stable-hdfl.osu`):61/302 个物件有堆叠,层数范围 `[-2, 11]`,
其中 22 个负向。未堆叠时三个圈完全重合成一个,堆叠后沿左上依次错开。

**几处不能"顺手简化"的细节**(改之前务必读 `stacking.ts` 顶部注释):

| 点 | 内容 |
|---|---|
| 阈值 | `(int)TimePreempt * StackLeniency` —— **只截断 preempt,不截断乘积** |
| circle 分支时间比较 | `(int)StartTime - (int)endTime > threshold`,两个操作数**各自**截断,start-vs-**end** |
| slider 分支时间比较 | `StartTime - StartTime > threshold`,**不截断**,start-vs-**start**。与 circle 分支规则**不同** |
| 距离 | `< STACK_DISTANCE`(int 3),**严格小于**。恰好相距 3 不堆叠 |
| 链式 | `objectI` 会在内层循环被重新指向,`objectI.stackHeight` 随之改变 —— 这是链式堆叠的实现方式,不是笔误 |
| 负向 | 圈落在滑条尾上时往**右下**偏(lazer:"bump notes down and right") |

**滑条末端位置**用 `path.curvePositionAt(1, spans)` —— 它**考虑 repeat**,
偶数 span 的滑条(来回一趟)末端会回到起点。堆叠用末端位置判断"圈是否落在
滑条尾上",所以这个细节会影响结果。

**已知微小分歧**:osu 里坐标与距离都是 float32,我们用 float64 算距离。
只有当距离落在 `3` 附近约 1e-7 内时结论才可能不同 —— 若将来 A2 出现
"个别物件堆叠层数差 1",这里是嫌疑点之一。

**legacy 算法(`applyStackingOld`,fileFormat < 6)刻意未实现**:手上没有
v6 以下谱面可测,照文字描述写一个测不了的算法出错概率高于不做 —— 错的堆叠
比没堆叠更糟。遇到时抛明确错误而非静默跳过。v6 是 2008 年的格式。

### D10. 谱面与回放是否匹配 —— ✅ `已解决`(2026-08-23)

`.osr` 头部记了谱面 MD5,现在能真校验了。状态栏明确显示 ✅ 匹配 / ❌ 不匹配(并列出两个哈希)。

**关键障碍与解法**:浏览器的 `crypto.subtle.digest` **不支持 MD5**(规范刻意排除,因为 MD5 已不安全),而 osu 的谱面标识就是 MD5,没得选。所以引了 `spark-md5`(零依赖)。

⚠️ **引第三方哈希库必须先证明它可信** —— MD5 错了症状很隐蔽,会变成"镜像站没有这张图"而不是明显崩溃。已做两层验证:

1. RFC 1321 附录 A.5 的 **7 个标准测试向量,7/7 通过**
2. 与 Node `crypto` 对随机字节逐位比对,覆盖 **55/56/57/63/64/65** 这些分块边界

实测四个 fixture 的 `.osu` MD5 全部等于对应 `.osr` 头部的 `beatmapHashMD5`。

### D11. 自动获取谱面依赖外部镜像站 —— `已确认的权衡`(2026-08-23)

"只传 `.osr` 就能播"靠的是镜像站。这引入了一个**外部服务依赖**:

- 实测 **`osu.direct` 可用**,lookup 与 download 两个端点都带 CORS 头(回显请求方 Origin),`content-length` 经 `access-control-expose-headers` 暴露,所以能做下载进度
- 实测当时 `catboy.best` 返回 502、`api.nerinyan.moe` 返回 530 —— 都是服务端故障,**不是 CORS 问题**。所以只实现了 osu.direct,但 provider 列表留成可配置,加备用镜像不必改调用方

**因此手动上传谱面的路径必须保留,不能删。** UI 上"自动获取"是个可关掉的开关。

另一个失败模式:**谱面在回放录制之后被作者更新过**,镜像站给的是新版而回放对应旧版,MD5 对不上。这时**报错而不是硬凑一个难度** —— 否则物件与判定会完全错位却毫无提示。错误信息里列出包内实际有哪些难度,便于人工判断。

### D12. 浏览器验证结果怎么取出来 —— ✅ `已解决`(2026-08-23)

浏览器专属的东西(CORS、`decodeAudioData`、canvas 像素)只能在真实浏览器里验,但 headless Chrome 的 `--dump-dom` 是**一次性快照**,踩了两个坑:

1. 虚拟时钟(`--virtual-time-budget`)**不等真实网络与音频解码** —— 页面常在跑完之前就被 dump
2. `--dump-dom` 本身会让 Chrome **立刻退出**,页面里后续的异步代码根本没机会跑

解法:`vite.config.ts` 里加了 `verifySink` 插件(`apply: 'serve'`,仅 dev)。页面
`POST /__verify/<name>`,内容写到 `.verify-out/<name>.txt`,外部脚本轮询该文件。
Chrome 不加 `--dump-dom` 直接开页面,拿到文件后再 kill。

`main.ts` 也支持 `?verify=<name>` —— 真实 app 载入完成后把状态栏内容回传,
所以"只传 `.osr` 能不能自动播起来"这件事可以无人值守验收。

⚠️ 读文件时要显式指定 UTF-8(PowerShell 默认按 ANSI 读会变乱码)。

### D13. `stable` 样本的 combo 缺口 —— 🔴 `未解决`(2026-08-23,当前最大偏差)

四个样本里三个的 combo 已经很接近了,只有 `stable.osr` 差得离谱:

| 样本 | `.osr` maxCombo | 我们 | 差 |
|---|---|---|---|
| `lazer` | 346 | 346 | ✅ 0 |
| `lazer-moonlight` | 755 | 756 | -1 |
| `stable-hdfl` | 253 | 260 | -7 |
| **`stable`** | **1151** | **412** | **739** |

同时它的判定计数只差 1(747/17/2/0 vs 746/17/3/0),准确率差 0.11%。
**判定几乎全对,但 combo 断了** —— 说明有极少数几个滑条部件被误判成 miss,
而每一次都会把 combo 归零。1151 → 412 只需要**两三次**位置合适的误判。

已排除的解释:
- 不是判定窗口 —— 主判定计数只差 1
- 不是物件解析 —— L1 断言(物件数 == 判定总数)四个样本全精确通过
- 不是 stacking —— 该图 `stackLeniency` 会产生偏移,但偏移错了会同时影响判定计数

下一步该查的方向(按可疑度排序):
1. **滑条跟踪的按键有效性规则**(B15 的 `acceptAnyKeyAfter`)。这条最复杂也最可能实现错。
   具体查:`stable.osr` 里 combo 断掉的那几个时刻,玩家是不是换了按键。
2. **`legacyLastTick` 的时刻**(`max(start + totalDuration/2, finalSpanStart + spanDuration - 36)`)。
   若这个时刻算偏了,末端会落在跟踪范围外。
3. **重复滑条(repeat)的时间反转**。反向 span 的刻度顺序若错了,刻度位置就全错。

#### 已完成的定位(2026-08-23,第一轮)

加了两个诊断(都是"永远通过、只打印"的报告型测试):

- `comboBreakReport.test.ts` —— 列出**每一次 combo 归零**的时刻、物件下标、部件类型、
  断连前的 combo。**739 的 combo 缺口收窄到了 2 个物件。**
- `sliderTrackingReport.test.ts` —— 把指定滑条在其存续期间的**每一帧**摊开:
  光标坐标、球坐标、距离、按键位域。改 `TARGETS` 换目标。

`stable.osr` 只断 2 次,且都在滑条部件上(头部是 countMiss 0 / maxCombo 1151,满连):

| 物件 | 部件 | 时刻 | 断连前 combo |
|---|---|---|---|
| #225 | `legacyLastTick` | 67.281s | 340 |
| #501 | `sliderRepeat` | 145.431s | 412 |

**#225**(spans 1,半径 36.49,follow 半径 87.59):末端刻度时刻光标在 (5.2, −26.6)、
球在 (60.3, 68.0),距离 **109.5 > 87.59**。光标"跑到球前面去了"(沿路径方向越过了
滑条末端,正在赶往下一个物件)。几何已核对无误 —— 见下方"已核实的公式"。

**#501**(spans 3):repeat 时刻距离只有 **44.4 < 87.59**,按位置**应该判中**。
按键序列是 `10`(K2)→ `15`(双键)→ `5`(K1) —— **玩家中途换手**,正好撞在
"有效键"规则上。所以这一个几乎确定是 `acceptAnyKeyAfter` 的实现与源码有偏差。

#### 已核实的公式(不必再查)

`SliderEventGenerator.Generate` 的 `PathProgress`(2026-08-23 核 master):

| 事件 | `PathProgress` |
|---|---|
| Head | `0` |
| Tick | `d / length`(从**整条路径**起点量,不是当前 span) |
| Repeat | `(span + 1) % 2` |
| LegacyLastTick | `(tickTime − finalSpanStartTime) / spanDuration`,`spanCount % 2 == 0` 时取 `1 − p` |
| Tail | `spanCount % 2` |

⚠️ 我原本怀疑"末端刻度的位置该取 span 末端(progress 1)而不是按时间插值"。
**核完源码证明不是** —— `LegacyLastTick` 的 progress 确实是按时间算的,与我的
`timeProgressToPathProgress` 在这两个滑条上结果一致。**这条排除掉了。**

#### 一次失败的尝试(记下来,别再走同一条路)

`SliderInputManager.PostProcessHeadJudgement` 结尾是:

```csharp
if (!head.Judged || !head.Result.IsHit) return;
if (!IsMouseInFollowArea(true)) return;          // ← 闸门用扩大圈
...
updateTracking(allTicksInRange || IsMouseInFollowArea(false));
```

读起来就是"**头一命中,只要光标在扩大圈内,tracking 立刻为 true**"。而我的实现是
`tracking = false` 起步、必须先落进小圈才咬得上。看着是个明显的偏差,于是加了个
`seedFromHeadHit()`。

**结果指标大幅变差**:`stable` 断连 2 → **39** 次,`lazer-moonlight` 4 → **22** 次,
`stable-hdfl` maxCombo 260 → 173。已回退。

原因分析:`seedFromHeadHit` 顺手把 `lastKeys` 初始化成了头命中帧的按键。而
`acceptAnyKeyAfter` 的解锁条件是"**上一帧**另一个键没被按住" —— 预置 `lastKeys`
让"限制只用头的那个键"的状态**持续得更久**,于是大量正常跟踪被按键规则拒掉。

**教训**:`PostProcessHeadJudgement` 与 `updateTracking` 是**耦合**的 ——
`lastPressedActions` 在 `updateTracking` 内部先读后清,`resetState` 又会清空它。
只照抄其中一段而不同时把 `lastPressedActions` 的生命周期搬对,会让规则变严而不是变准。
下一次要动这块,**必须先把 `lastPressedActions` 的读/清/重置时序完整对照一遍**。

> 更一般的教训:**单独看一段源码判断"更忠实"是不够的**。判据只能是真值指标 ——
> 一个让 ground-truth 变差的改动必须回退,哪怕它看起来更贴源码。

诊断入口:`npx vitest run src/core/sim/comboBreakReport` —— 直接列出每次 combo 归零的物件。
要摊开某个滑条的逐帧数据,改 `sliderTrackingReport.test.ts` 的 `TARGETS` 再跑。

**下一步该做的**(按顺序):

1. 把 `sliderTrackingReport` 的时间窗口扩到**滑条头**(现在只打部件时刻 ±40ms,
   头不在 `parts` 里所以看不到),确认 #501 的头是用哪个键命中的。
2. 照 `SliderInputManager.updateTracking` **完整**重写 `acceptAnyKeyAfter` 与
   `lastKeys` 的时序 —— 特别是 `lastPressedActions` 的"先读后清"和 `resetState`。
   不要只改一半。
3. #225 那种"光标越过滑条末端"的情形单独查:它距离 109.5 明显超界,但 stable 判中了。
   怀疑与 stable 的**末端宽容**有关(stable 的滑条末端判定比 lazer 松),
   要核 `OsuLegacyScoreSimulator` 或 stable 的滑条末端处理。

---

### D14. combo 配色的三处坑 —— ✅ `已解决`(2026-08-24)

调研 webosu 时顺手核 combo 配色,结果连挖出**三个我们自己的 bug**,而且都属于
"换成真颜色之后才会显形"的那一类 —— 之前配色是硬编码的假色,全部隐形。

### 坑 1:`comboIndex` 应该是 **1-based**

核 `IHasComboInformation.UpdateComboInformation`:

```csharp
int index = lastObj?.ComboIndex ?? 0;          // 首个物件 lastObj 为 null → 0
int indexWithOffsets = lastObj?.ComboIndexWithOffsets ?? 0;
if (NewCombo || lastObj == null) {
    index++;                                    // → 1
    indexWithOffsets += ComboOffset + 1;
}
```

`BeatmapProcessor.PreProcess()` 从 `lastObj = null` 起遍历全部物件,所以**首个物件
必然进那个分支** —— `ComboIndex` 从 1 起,不是 0。我们原来从 `-1` 起 `++`,
首个物件得到 0,配 4 色调色板时 lazer 取 `ComboColours[1 % 4]`(第二色)而我们取第一色,
**整张图配色错开一格**。

> 教训:两次 WebFetch 对**同一个文件**给出了互相矛盾的说法(一次说 `?? 0` 让 null 时
> 全部归零、一次说 `index++` 作用在种子为 0 的局部变量上)。这种"小模型转述源码"
> 的结论不能定案 —— 最后是 `curl` 把文件抓下来自己读才确定的。**核源码就要读原文。**

### 坑 2:取颜色用哪个索引,**取决于颜色来自哪一层**

```
IHasComboInformation.cs:70   GetComboColour(skin) => GetSkinComboColour(this, skin, ComboIndex)
LegacySkin.cs                GetComboColour(src, colourIndex, combo)
                               => src.ComboColours[colourIndex % src.ComboColours.Count]
LegacyBeatmapSkin.cs:89-90   protected override GetComboColour(src, comboIndex, combo)
                               => base.GetComboColour(src, combo.ComboIndexWithOffsets, combo)
                                                          ^^^^ 参数被丢弃,换成含 offset 的
```

| 颜色来源 | 索引 |
|---|---|
| 谱面 `[Colours]` | `ComboIndexWithOffsets` |
| 皮肤 `skin.ini` / osu 默认色 | `ComboIndex` |

也就是说 **combo-skip 位只对谱面自带的配色生效**;谱面没给颜色时,谱师写的跳色意图
被完全忽略。听起来像 bug,但这是 lazer 的实际行为。

`LegacyBeatmapSkin` 构造函数里的 `AllowDefaultComboColoursFallback = false` 解释了链条
怎么接:谱面没有 `[Colours]` 时返回 null 而**不是**兜底成默认色,好让查找继续落到
用户皮肤那一层。所以顺序是 **谱面 → 用户皮肤 → 默认色**。

实现在 `src/render/comboColours.ts`,两个方向的变异检验各自钉住不同的测试。

### 坑 3:`comboOffset` **不能**用 osu-parsers 的字段

osu-parsers 移植的是一个**旧版** lazer。现在的 `ConvertHitObjectParser`:

```csharp
ComboOffset = newCombo ? comboOffset : 0        // createHitCircle / createSlider
NewCombo = newCombo                             // createSpinner
// Spinners cannot have combo offset.
```

`extraComboOffset` / `forceNewCombo` 这两个字段在 master 上**已经删除**。分歧:

| | osu-parsers | 现在的 lazer |
|---|---|---|
| 转盘的 skip 位结转给下一个物件 | 有(`_extraComboOffset`) | 已删除 |
| 物件未标 NewCombo 时的 skip 位 | 保留 | 归零 |

> 这里我**先后判断反了两次**:一开始打算自己写 `(hitType >> 4) & 7`,读到
> osu-parsers 有转盘结转后改成"必须用它的字段"并写下"幸好查了";再核 lazer master
> 才发现结转已被删除,于是又回到按位域自己算。**参考实现不是权威,只有上游源码是。**

注意门是**文件里显式标的** NewCombo 位,不是 `forceNewCombos()` 补出来的那个 ——
"转盘之后被强制开 combo、且自带 skip 位"的物件,offset 仍然是 0。

### 验证状况

四张 fixture **一个 combo-skip 位都没有**(实测全为 0),所以 `comboIndexWithOffsets`
在真实数据上恒等于 `comboIndex` —— ground truth **验不出**这段。和 D-hitPolicy 同一种局面,
只能靠合成 `.osu`(`beatmapLoader.test.ts` 的「combo-skip 位(合成谱面)」)。

变异检验:改用 osu-parsers 的 `comboOffset` 后,序列从 `[1,4,4,4,5,7]` 变成
`[1,4,4,4,8,10]` —— 正是测试注释里预言的 `8`。

另一个副产品:四张图**全都有 `[Colours]`**,所以真实运行时永远走"谱面配色"那一层,
osu 默认四色反而是罕见路径。

---

### D15. webosu 的渲染做法 —— `已调研`(2026-08-24),滑条体做法**已落地**

用户指向 <https://web-osu.github.io/>,源码 `github.com/BlaNKtext/webosu`(默认分支 `main`)。

### 许可边界(先看这个,它决定其余一切)

- `LICENSE` = **MIT**,`Copyright (c) 2015 Drew DeVault`。无 copyleft,义务只有保留版权声明。
- ⚠️ `LICENSE-CC-BYNC.md` = CC BY-NC(**禁商用**),`README.md:10` 说部分文件属 ppy,
  但**仓库里没有清单说明哪个文件归哪个许可证**。所以规则简化为:
  **只看 `js/*.js`,任何美术/音频资源(`skin.7z`、`img/sprites.png`、`hitsounds/*`、`fonts/*`)一律不碰。**
- ⚠️ `js/curves/*.js` 每个文件头写着 "Adapted from … opsu!",而 **opsu! 是 GPLv3**,
  这批文件在这里以 MIT 分发,来源许可存疑。算法思路照用(等弧长重采样这种做法不受版权保护),
  但**别逐行搬那几个文件**。

### 核心收获:滑条自相交不叠亮 = 每条滑条独立的深度缓冲双 pass

`js/SliderMesh.js`(433 行,全部核心都在这一个文件),PixiJS v5 但绕过 batcher 直接
`gl.drawElements`:

- 顶点属性 `vec4(x, y, t, dist)`,`dist` 在中心线 = 0、轮廓边 = 1,`gl_Position.z` **直接取 `dist`**
- 每条滑条画之前 `gl.clear(DEPTH_BUFFER_BIT)` —— **per-slider 清深度**,滑条之间照常混合
- pass 1:`colorMask` 全关 + 深度测试,只把每像素的**最小 `dist`** 写进深度缓冲
- pass 2:`depthFunc(EQUAL)` + colorMask 全开,同一个 draw call 再来一遍

净效果一条规则:**每像素只被着色一次,着的是"离中心线最近"的那个 fragment**。
alpha 不累积、自相交看起来是一根连续的管、边框不横穿交叉区,三件事一条规则解决。

其余常数:渐变是一张 `200 × ncolors` 的 1D LUT(全图共用一个 shader),
`borderwidth = 0.128`、中心 alpha `0.3` → 内边缘 `0.8`(RGB 恒定,只有 alpha 变),
`blurrate = 0.015` 在两处边界各做一次 alpha 淡出**用来免费换抗锯齿,不开 MSAA**。
snaking 完全在顶点着色器里做(`t*dt > ot` 不满足时给 z 加 2.0 把顶点顶出裁剪体),不重建几何。

> 它有个真 bug,抄之前要修:`SliderMesh.js:210,213` 调 `addArc(5*i, ...)` 时漏传第 4 个
> 参数 `t`,导致转折点楔子的顶点 `t = NaN`,于是那些楔子在 snaking 期间不会被裁掉。

### 落到我们 canvas2d 上

深度缓冲需要深度缓冲,canvas2d 没有。但那条**语义**可以一比一翻译:
"每像素由它到中心线最小距离处的 LUT 值着色" = **不透明同心描边,由宽到窄**。

1. 把 ramp 烘成 K 级(K ≈ 24~64)**纯不透明** RGB(合成到黑底上 —— 我们判定区背景
   `#0f0f14` 本就接近黑,这个近似只在将来渲染亮背景/故事板时才失真)
2. 离屏 canvas 上 `lineJoin = lineCap = 'round'`、`globalAlpha = 1`,对**同一条完整路径**
   描边 K 次,`lineWidth` 从 `2r` 递减到接近 0,颜色取 `LUT[k]`
3. 每遍都不透明 ⇒ 自相交**不可能**累积;越窄的遍越晚画 ⇒ 每像素赢家是"距中心线最小"
   的那一级 —— 与深度测试强制的规则等价
4. 最后整张离屏以 `globalAlpha = fade` 贴上去,滑条体的淡入淡出也一并解决

⚠️ 一个必须记下的**认知修正**:原来 D4 里写"canvas2d 单遍粗折线在交叠处会变亮"——
这是错的。canvas2d 把**一次 `stroke()` 的整条路径当成一个区域填充**,自重叠不重复合成。
所以现在这版滑条体真正的问题不是叠亮,而是**横截面渐变完全没有**(内浓外淡的管道感缺失)。
K 遍同心描边解决的是后者。

### ✅ 已实现(`DebugRenderer.drawSliderBody`)

`BODY_LEVELS = 32`(按屏上半径下调,小滑条不浪费描边),常数照搬 webosu 实测值:
`BORDER_WIDTH = 0.128`、`EDGE_OPACITY = 0.8`、`CENTER_OPACITY = 0.3`。

**没有用离屏 canvas**,直接画在主画布上 —— 理由:K 遍之间只有在 `globalAlpha < 1`
时才会互相混合,而滑条体绝大部分生命周期是全不透明的,那时每遍完全盖住上一遍,
结果与离屏方案逐像素相同。淡入那 ~400ms 里中心会偏浓一点,换来省掉每帧每滑条
一次离屏分配 + `drawImage`。

alpha 是**预先合成到判定区背景色**(`PLAYFIELD_BG`)上的,这是本方案唯一的近似:
判定区背景是纯色时逐像素精确,将来渲染谱面背景图 / 故事板后会失真
(滑条体中心该透出图片,却透出这个纯色)。那时才需要 M2 的 WebGL 方案。

三条变异检验都杀掉了对应测试:反转描边顺序(t 取 `1 - i/(K-1)`)→ 宽度单调性 +
横截面渐变两条红;把颜色改回 `rgba()` 半透明 → 不透明性 + 横截面渐变两条红。
说明"宽度递减"与"每级不透明"是两条**独立**的牙,不是碰巧一起过。

### 两块没有参考价值

- **皮肤:webosu 完全没有 `.osk` 支持。** 全仓库零个 `.ini`、零处 `skin.ini`/`@2x` 引用、
  无命名回退链。它的"皮肤"是一张烘好的 PIXI 图集,命名甚至跟 osu 不兼容
  (`disc.png` 而非 `hitcircle.png`)。M4 只能直接照 ppy/osu 的 `LegacySkin` 来。
- **combo 颜色:它没有优先级链**,只读谱面 `[Colours]`,且谱面无 `[Colours]` 时兜底的
  四色 `[96,159,159] [192,192,192] [128,255,255] [139,191,222]` **不是 osu 的默认色**,
  是它自己编的。真实默认见 D14。**参考别人实现时,"看起来很权威的常量"最容易照抄出错。**

playfield 缩放它也用 `0.8`(`js/playback.js:94-107`),算是对我们那次改 `0.9 → 0.8` 的独立交叉验证。

### 另外两条与渲染后端无关、可以直接照用的

- **等弧长重采样 + 每点带 `t`**(`js/curves/EqualDistanceMultiCurve.js`,`CURVE_POINTS_SEPERATION = 5` osu px):
  一份点表同时喂几何生成、snaking 截断、滑条球定位、reverse arrow 定位。点表让"按 t 截断"变成 O(1) slice。
- **插入排序的显示列表**(`js/playback.js:1009-1031`):不每帧重排,维护按浮点 `depth` 有序的
  children 数组、二分插入。`depth = 4.9999 - 0.0001*hitIndex`,靠"早出现的物件 depth 更大"
  实现 osu 的"先出现的画在上面"。

---

### D16. 滑条 snaking(伸展与收缩)—— ✅ `已实现`(2026-08-24)

用户实测报的两个问题:滑条一出现就把整条路径画出来(应从头部伸展到尾部);
球划过之后路径不消失(应在球后面收缩,而 repeat 滑条要等最后一次重复之后才抹除)。

两条都对应 `osu.Game.Rulesets.Osu/Skinning/SnakingSliderBody.cs:73-100`:

```csharp
int span = slider.SpanAt(completionProgress);
double spanProgress = slider.ProgressAt(completionProgress);

double start = 0;
double end = SnakingIn.Value
    ? Math.Clamp((Time.Current - (slider.StartTime - slider.TimePreempt)) / (slider.TimePreempt / 3), 0, 1)
    : 1;

if (span >= slider.SpanCount() - 1)
{
    if (Math.Min(span, slider.SpanCount() - 1) % 2 == 1)
    {
        start = 0;
        end = SnakingOut.Value ? spanProgress : 1;
    }
    else
    {
        start = SnakingOut.Value ? spanProgress : 0;
    }
}

setRange(start, end);   // 内部先做 if (p0 > p1) swap,再 Path.GetPathToProgress(curve, p0, p1)
```

配合 `IHasPathWithRepeats.cs` / `IHasRepeats.cs`:

```csharp
SpanAt(p)     => (int)(p * SpanCount())
ProgressAt(p) => { double q = p * SpanCount() % 1; if (SpanAt(p) % 2 == 1) q = 1 - q; return q; }
SpanCount()   => RepeatCount + 1
```

### 三个容易写错的点

1. **伸展窗口是 `preempt / 3`,不是 `preempt`。** 起点在 `startTime - preempt`,
   所以滑条在出现后的**前三分之一**就伸完,剩下三分之二是完整路径在等着被点。
   用整个 preempt 会慢三倍,肉眼很明显。webosu 用的也是 `approachTime / 3`,两边一致。

2. **收缩只发生在最后一个 span**(`span >= SpanCount - 1`)。这正是用户说的
   "repeat 滑条在最后一次重复之后才抹除" —— 中间那些来回是整条常驻的,
   少了这个门,路径会每走完一段就抹一次再重现。

3. **`ProgressAt` 自带奇偶反转**(`q = 1 - q`),所以反向 span 上 `spanProgress`
   是从 1 降到 0 的。这让"奇 span → `[0, spanProgress]`"自然表现为**向头部收缩**。
   自己实现 `ProgressAt` 时漏掉这次反转,repeat 滑条的收缩方向就会反 ——
   而我们的 `timeProgressToPathProgress` 早就实现了它,所以直接复用。

### 默认开关

`OsuRulesetConfigManager`:`SnakingInSliders` 与 `SnakingOutSliders` **默认都是 `true`**。
所以这是 lazer 的默认观感,不是可选特效。`SnakingOptions` 留了开关只为将来做播放器设置。

### 实现

- `sim/sliderPath.ts` 加 `pathRangeBounds(samples, from, to)`:返回**严格落在开区间内**
  的采样点下标范围。刻意返回下标而非新建数组 —— snaking 每帧都在变,每条滑条每帧
  建一个数组会造出大量短命对象。
- 两个端点用 `pathOffsetAt` **精确插值**。若把端点吸附到最近采样点,伸展与收缩会以
  采样间距(2 osu 单位)为步长跳动,肉眼能看出"一格一格地长"。
- `render/sliderSnaking.ts`:`snakeRangeAt()`,逐行对齐上面那段源码(包括 `setRange`
  的那次交换 —— 极短滑条上收缩已推进而伸展未完时两者会反)。

### 变异检验

- 去掉 `span >= spans - 1` 这个门 → 3 条红(两处 repeat 行为 + 渲染器侧)
- `preempt / 3` 改成 `preempt` → 5 条红,包括专门写来区分这两种写法的那条

---

### D17. 皮肤系统第一步:解析层 —— ✅ `已实现`(2026-08-24)

用户找到 `daladal/replayviewer-js`(MIT)并要求参照。它的架构与我们**高度一致**
(`Ruleset.ts:35-40` 对 `draw` 写了契约:*"Must not mutate the session — scrubbing
calls this at arbitrary times in any order."*),但**零测试**,且带着我们已修掉的
`SCALE * 0.9` 判定区 bug(`HitObjectRenderer.ts:15-16`)。所以定位是
**借渲染与 I/O,判定层保持自己的**。

第一块落地:`.osk` / `skin.ini` / 贴图查找。

#### 与参考实现的三处刻意分歧

1. **解析与解码分离。** 它的 `loadSkin` 把 unzip + `createImageBitmap` +
   `decodeAudioData` 塞在一个 async 函数里 —— 那样整个模块在 Node 下不可测。
   我们只做"字节 → 结构",浏览器 API 一个不碰,于是这一层 40 个测试全部能跑。

2. **`@2x` 回退集中成一个 resolver。** 它把
   `images.get(stem+'@2x.png') ?? images.get(stem+'.png')` **复制粘贴到了 8 个渲染文件**。
   问题不只是重复:那个写法**拿不到"用了哪一档"**,而 @2x 贴图必须按半尺寸画
   (lazer 的 `Texture.ScaleAdjust = 2`),忘了就整体大一倍。
   我们的 `resolveTexture` 返回 `{ path, scale }`。

3. **overlap 的默认值按字体不同。** 核 `LegacySkinExtensions.cs:166-185`:
   `HitCircleOverlap` 默认 **-2**,而 `ScoreOverlap` / `ComboOverlap` 默认 **0**
   (`ScoreEntry` 是 1)。参考实现只有一个 `hitCircleOverlap: -2`。

#### 从源码核出来的、参考实现没有的两个细节

`LegacySkin.GetTexture`:

```csharp
// some component names (especially user-controlled ones, like `HitX` in mania)
// may contain `@2x` scale specifications.
// stable happens to check for that and strip them, so do the same to match stable behaviour.
componentName = componentName.Replace(@"@2x", string.Empty);
string twoTimesFilename = $"{Path.ChangeExtension(componentName, null)}@2x{Path.GetExtension(componentName)}";
```

1. **请求名里自带的 `@2x` 先剥掉**。不剥的后果很隐蔽:传 `hitcircle@2x` 会拼成
   `hitcircle@2x@2x.png`(不存在)→ 退回 SD 分支查到 `hitcircle@2x.png` ——
   **路径碰巧对,但 scale 报成 1**,于是 HD 贴图被画成两倍大。
   变异检验复现了这个:`{ path: 'hitcircle@2x.png', scale: 1 }`。
2. **`@2x` 插在扩展名之前**:`foo.png` → `foo@2x.png`。

#### 其他核实项

- **皮肤 `[Colours]` 同样丢弃 alpha。** `LegacySkinDecoder` 对 `Section.Colours`
  不拦截,落到基类的 `HandleColours(output, line, false)`;只有它亲自处理的
  `[CatchTheBeat]` 传 `true`。所以 `Rgb`(无 alpha)两条路径通用。
- **`Version` 缺省是 1.0,不是 latest。** `CreateTemplateObject()` 里
  `config.LegacyVersion = 1.0m`;`"latest"` → `LATEST_VERSION` = 2.7。
  这个差别有后果:`LegacyMainCirclePiece.cs:183` 用 `legacyVersion > 1.0m`
  决定圈内数字是"短淡出 60ms 不缩放"还是"跟其他部件一样淡出并放大"。
- **combo 色顺序就是索引**(与谱面 `[Colours]` 同一套逻辑),上限 8。
- `hasFont(prefix)` 的判据是 `GetTexture($"{prefix}-0") != null`(`LSE.cs:137`)。
- 其余键一律进 `raw` 字典(对应 `ConfigDictionary`),类型转换推迟到读取时 ——
  这样以后要 `AllowSliderBallTint` / `AnimationFramerate` 不必回来改解析器。

#### 副产品:配色优先级链**接通了**

`buildComboPalette` 早就接受 `skinColours` 且有双向变异检验,但一直没人传。
现在 `DebugRenderer.setSkin()` 把 `ini.comboColours` 喂进去,「谱面 → 皮肤 → 默认」
三层全部可达。

⚠️ 一处易漏:配色表的记忆化键是 `beatmap`,但值现在**还依赖皮肤** ——
所以 `setSkin()` 必须显式作废缓存。变异检验(去掉作废)→ 2 条红。

#### 还没做

贴图**绘制**路径(`drawImage` + combo 色 tint)、动画帧(`hitcircle-0.png` 序列)、
音效、谱面自带皮肤(优先级高于用户皮肤)。

---

## E. 待办 / 杂项

- **仓库名**:目录名 `OSUReplay-Danser` 已不准确(danser 不再是后端)。建议改名(如 `osu-replay-web`)。不阻塞,但越早改越好。
- **法务**:谱面与音频的再分发、回放数据归属。o!rdr 这类服务长期存在说明大体被容忍,但若要公开服务,倾向"用户自行上传 + 代理镜像站"而非自建谱面库。
- **生态调研**:已派 agent 调研现有可复用项目(重点 `rewind` —— Electron + PixiJS 的 osu 回放分析器,可能有大量可借鉴的滑条渲染与判定代码)。若有维护良好的现成基础,M0-M2 工作量可能大幅缩减。**结果待回收,应在写 M1 代码前评估。**

### 参考源码(用户明确鼓励对照)

对照上游源码是本项目的**首选做法**,不是最后手段 —— 判定/难度/滑条这些地方靠推测必错。

| 用途 | 位置 |
|---|---|
| 难度换算 | `ppy/osu` → `osu.Game/Beatmaps/IBeatmapDifficultyInfo.cs` |
| 命中窗口 | `ppy/osu` → `osu.Game.Rulesets.Osu/Scoring/OsuHitWindows.cs` |
| preempt / 半径 / 堆叠 | `ppy/osu` → `osu.Game.Rulesets.Osu/Objects/OsuHitObject.cs` |
| stable 兼容换算 | `ppy/osu` → `osu.Game/Rulesets/Objects/Legacy/LegacyRulesetExtensions.cs` |
| .osr 格式权威 | `ppy/osu` → `osu.Game/Scoring/Legacy/LegacyScoreDecoder.cs` |
| HP drain 推导(D1) | `ppy/osu` → `osu.Game/Rulesets/Scoring/HealthProcessor.cs` / `DrainingHealthProcessor.cs` |
| 记分体系(M5) | `ppy/osu` → `osu.Game/Rulesets/Scoring/ScoreProcessor.cs` |
| 滑条路径(M2) | `ppy/osu` → `osu.Game/Rulesets/Objects/SliderPath.cs` / `PathApproximator.cs` |
| Go 侧交叉验证 | `Wieku/danser-go` → `app/beatmap/objects/` / `app/rulesets/osu/` |

拉取方式:`raw.githubusercontent.com/ppy/osu/master/<path>`(该域名已在 `.claude/settings.local.json` 放开)。

⚠️ 抄公式时**连注释一起看**:`- 0.5`、`1.00041` 这类"怪"常数都有历史原因,注释里写了为什么,漏掉就会在 A2 上栽(见 B7)。
