# 技术问题与决策记录

> 最后更新:2026-08-23

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

### D7. 变速 mod 的播放倍率未补偿 —— `待解决`(M1)

回放帧的时间戳是**谱面时间**,DT 的含义是谱面时间相对真实时间跑得更快。所以要忠实还原一段 DT 回放,时钟推进谱面时间的速率必须是 1.5×,用户设定的倍速再乘在这之上。

M0 的时钟还没算这个倍率,DT/HT 回放现在按 1× 播 —— 光标位置对,节奏比玩家当时听到的慢/快。载入时会在状态栏提示。

`speedMultiplierOfLegacyMods()` 已经写好(在 `replayLoader.ts`),接进 `PlaybackController` 是 M1 的事。

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

### D10. 谱面与回放是否匹配未校验 —— `待解决`

`.osr` 头部记了谱面 MD5,但目前载入时**不校验**当前谱面是否就是它。配错了物件与判定会完全错位,而且症状很隐蔽(画面能动,只是全都对不上)。

要校验需要算 `.osu` 文件的 MD5。浏览器里可用 `crypto.subtle.digest` —— 但它**不支持 MD5**(只有 SHA-1/256/384/512)。所以得自己带一个 MD5 实现,或退而求其次:比对物件数与 `count300+100+50+miss` 是否相等(这正是 A2 的 L1 断言,已实现且实测 4/4 精确相等)。

UI 目前在同时载入谱面与回放时显示一条提醒。

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
