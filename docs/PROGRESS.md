# 工作进度

> 最后更新:2026-08-23
> 当前阶段:**M1 —— 只传 .osr 即可播放;分数与正式渲染未做**

关联文档:[架构设计](./ARCHITECTURE.md) · [技术问题记录](./TECH-NOTES.md)

---

## 一句话现状

**M0 完成,M1 已经能"只丢一个 `.osr` 进来就播"** —— 自动按谱面 MD5 从镜像站取回 `.osz`,解包挑出正确难度,连音乐一起装好(真实浏览器实测 **6 秒**),然后跑完整链路:堆叠 → 判定 → combo 累积。477 个单测全绿 + 24 个 `todo` 占位。

**距"可交付"还有多远:** 分数公式、HP、滑条刻度判定、正式渲染(combo 数字/颜色/命中动画)、皮肤 —— 见下方待完成与里程碑表。M2(滑条体渲染)仍是最硬的一块。

> ⚠️ **本仓库出现过多会话并行编辑**(2026-08-23):`timeline.test.ts` 由另一次会话写入。
> 现已纳入 git 并推到私有远端 `KawakazeNotFound/osu-replay-web`,多会话并行编辑有了退回点。
> 但 git 不解决**同时**写同一文件互相覆盖的问题 —— 并行开多个 agent 时仍需分工避开同一文件。

---

## 里程碑总览

| | 内容 | 状态 |
|---|---|---|
| **M0** | 地基:解析 + 时钟 + timeline + `stateAt` + 调试渲染器 | ✅ **完成** |
| **M1** | circle 渲染 + approach circle + combo 数字 + circle 判定 | 🟡 只传 `.osr` 即可播放;分数、HP、正式渲染未做 |
| M2 | 滑条(路径生成 + WebGL slider body)← 最难 | ⬜ 未开始 |
| M3 | spinner + 记分/HP/连击 HUD | ⬜ 未开始 |
| M4 | stable 皮肤系统(.osk,预设 + 用户上传) | ⬜ 未开始 |
| M5 | lazer 记分体系 + mod | ⬜ 未开始 |
| M6 | Argon 风格皮肤 + 网页 UI 打磨 | ⬜ 未开始 |

---

## M1 明细

### 已完成(2026-08-23)

**素材配对** —— A2 的前置

- [x] 按 `.osr` 头部的 `beatmapHashMD5` 在本机 osu! Songs 库(1131 个 `.osu`)与 `.osz` 包里扫 MD5 配对,**命中 5/6**
- [x] `fixtures/` 现有 **4 组完整配对**:stable NM / stable HDFL / lazer NM / lazer Moonlight;另留 1 个只有回放的(`lazer-ap`)做降级路径

**`.osu` 谱面解析**(`core/load/beatmapLoader.ts`)

- [x] `.osu` → `SimBeatmap` 适配器:物件、break、难度、`stackLeniency`、元信息
- [x] **combo 索引自己推** —— osu-parsers 不填(`currentComboIndex`/`indexInCombo` 恒为 undefined)
- [x] **补上 lazer `PreProcess()` 强制的 new combo**:第一个物件、转盘之后的第一个物件。漏了会整体错位
- [x] `hitType` 位域判别三类物件;mode != 0 直接拒绝并给可读错误
- [x] D6 的另一半解除:`.osu` fileFormat 14,4/4 解析通过

**A2 测试骨架**(`core/sim/judgementAccuracy.test.ts`)

- [x] **L1 断言实测 4/4 精确通过**:物件数 == `count300+100+50+miss`。这是不依赖判定器就能跑的强断言(见 [TECH-NOTES B9](./TECH-NOTES.md))
- [x] L2 下界断言;L3 留 24 个 `todo` 占位,判定器写完逐条填

**真实数据上的性能验证**(`core/sim/performance.test.ts`)

- [x] 核心架构主张成立:`buildTimeline` < 200ms、单次 `stateAt` μs 量级、**随机 seek 与顺序播放同速**、同屏物件数有界

**UI 接线**

- [x] `.osu` 文件输入 + `?osu=` 自动载入;谱面与回放**独立槽位**,任一变化重建时间线(谱面缺失时退回 placeholder,只播光标)
- [x] 侧栏显示谱面信息(曲目/难度/作者/物件构成/难度值)
- [x] 同时载入谱面与回放时校验 MD5 是否匹配(见 [TECH-NOTES D10](./TECH-NOTES.md))

**物件堆叠**(`core/sim/stacking.ts`)—— [TECH-NOTES D9](./TECH-NOTES.md)

- [x] 逐行对照 `ppy/osu` master 的 `OsuBeatmapProcessor.cs` 实现现代堆叠算法
- [x] 两处 `(int)` 截断、circle/slider 两分支不同的时间比较规则、链式堆叠、负向堆叠全部落地
- [x] `SimHitObject` 新增 `endX/endY`(考虑 repeat 的滑条末端)、`stackHeight`、`stackedX/stackedY`、`spans`
- [x] `DebugRenderer` 改用堆叠后坐标。实测 `stable-hdfl.osu` 上 61/302 个物件有堆叠,层数 `[-2, 11]`
- [x] **调研并否决 `osu-standard-stable`** —— 它与 master 有两处实质分歧,见 [TECH-NOTES B11](./TECH-NOTES.md)
- [x] 51 条测试,期望值全按 lazer 算法手推;真实谱面判据是"独立算出的候选对数量"

**判定器**(`core/sim/judgement.ts`)—— circle + 滑条头

- [x] 对照 `DrawableHitCircle.CheckForResult` / `LegacyHitPolicy` / `HitWindows` 三处源码
- [x] **纠正一处心智模型**:自动 miss 的阈值是 **meh 窗口**,不是 400ms;400 只是 hit policy 的 `hittableRange`
- [x] 由此推出 stable 的真实行为:在 `(meh, 400]` 区间点击会**判 Miss 并消耗物件**("点早了吃 miss")
- [x] notelock(含 3ms 宽容)、按键边沿提取、圆形命中区用堆叠坐标
- [x] **用真实回放抓出两个真 bug**(见下方"教训"),都靠 FC 回放上的 miss 数铁证定位
- [x] 65 条测试;四个样本的 circle miss 数全部不超过 `.osr` 全图 miss 上界

**滑条刻度与理论最大 combo**(`core/sim/sliderParts.ts`)

- [x] `tickDistance = velocity × beatLength / tickRate`,刻度铺法照 `SliderEventGenerator`
- [x] 理论最大 combo = 物件 + 刻度 + repeat + 滑条尾
- [x] **`lazer.osu` 精确验证**:理论 346 == `.osr` 实得 346(真 full combo)
- [x] **纠正一个基于错误前提的推论**:`countMiss == 0` **不等于** full combo(slider break 打断 combo 但不计 miss),见 [TECH-NOTES B12](./TECH-NOTES.md)

### 两个"靠 ground truth 抓出来"的真 bug

判据:`.osr` 头部的 `countMiss` 是全图 miss 数,而一个 circle 恰好产生一个判定,
所以它是我们判出的 circle miss 数的**上界**。在 FC 回放(0 miss)上判出任何
circle miss 都是铁证。

1. **跳过滑条 → 按下漏到后面的 circle 上。** 最初以为"只判 circle,至少 circle
   部分是对的"。错了:`stable.osr` 是 FC 却判出 1 个 circle miss。滑条在 155841、
   circle 在 156169,玩家在 155836 按下(那是给滑条头的),但滑条不参与判定,
   这次按下漏到 333ms 后的 circle 上 —— 距离 32.0 落在半径 36.49 内,333ms 落在
   `(meh, 400]` 区间,判出 Miss 并消耗掉那个 circle。
   **"跳过滑条"不是部分实现,是主动引入错误:按下必须被正确的物件吃掉。**

2. **滑条在"头命中"时就被当作判定完成。** 修了 1 之后仍有 1 个误判:滑动过程中
   (155932)的按下又漏出去了。真实 osu 里滑条要到 `endTime` 才算 `AllJudged`。
   → 引入 `resolveTime`:circle 解析于自己的判定时刻,slider/spinner 解析于 `endTime`。

**自动获取谱面与音乐**(`core/load/{mirror,oszLoader,beatmapHash,autoFetch}.ts`)

- [x] **只传 `.osr` 即可播放** —— 按谱面 MD5 从镜像站取回 `.osz`,解包挑出正确难度,连音乐一起装好
- [x] 先验证成败点 **CORS**:`osu.direct` 两个端点都可跨域,`content-length` 可读(能做进度);另两个镜像当时 502/530(服务端故障,非 CORS)。见 [TECH-NOTES D11](./TECH-NOTES.md)
- [x] **MD5 先证明可信再用**:RFC 1321 的 7 个标准向量 7/7 通过 + 与 Node crypto 对分块边界逐位比对
- [x] **D10 解决**:谱面与回放匹配校验落地,状态栏明确显示 ✅/❌ 并列出两个哈希
- [x] **必须按 MD5 挑难度**,谱面被更新过时报错而不是硬凑(否则物件与判定错位却无提示)
- [x] 新增 dev-only 的验证结果回传通道(`verifySink`),解决"headless 拿不到浏览器结果",见 [TECH-NOTES D12](./TECH-NOTES.md)
- [x] 34 条测试;真实 app 端到端验收:**6 秒内只凭一个 `.osr` 装好谱面 + 音乐**

### 待完成

- [ ] **滑条刻度/尾的判定** —— 需要跟踪光标是否在 follow circle 内(M2)。这是
      maxCombo 与滑条整体 300/100/50 精确对上的前提
- [ ] **stable 分数公式** —— **刻意排在滑条判定之后**:每个刻度都加分,在刻度判定
      实现前算出的分数无法与 `.osr` 比对。难度系数公式已核过(见 TECH-NOTES B14)
- [ ] **HP drain** —— `drainPerMs` 仍是占位值(D1)
- [ ] circle 的正式渲染(combo 数字、combo 颜色、命中/miss 动画)
- [x] ~~接线 D7:DT/HT 的播放倍率补偿~~ ✅
- [ ] L3 的 24 个 `todo` 逐条填绿

---

## M0 明细(已完成,存档)

### 已完成

**决策与文档**

- [x] 否决 danser-go 作为渲染后端,理由成文(ARCHITECTURE.md 第 0 节)
- [x] 核心架构定案:**预编译时间线**,取代最初提的 checkpoint + 增量重放方案(推理见 ARCHITECTURE.md 第 1 节 / TECH-NOTES C1)
- [x] 三份文档:ARCHITECTURE / TECH-NOTES / PROGRESS

**项目脚手架**

- [x] `package.json` — Vite + TS + vitest,依赖 `osu-parsers` 4.1.7 / `osu-classes` 3.1.0
- [x] `tsconfig.json` — strict,`verbatimModuleSyntax`,`@/*` 路径别名
- [x] `vite.config.ts`、`.gitignore`(排除 .osz/.osr/.osk 素材)
- [x] `index.html` — 深色 lazer 风格 spike 界面
- [x] **`npm install` + `tsc --noEmit` 跑通**(2026-08-23)

**核心模块(`src/core/`)**

| 文件 | 内容 |
|---|---|
| `util/search.ts` | 二分查找(`lastIndexAtOrBefore` / `firstIndexAtOrAfter`)—— 整个 seek 的地基 |
| `clock/Clock.ts` | `Clock` 接口 + `ManualClock`(逐帧与单测用) |
| `clock/AudioClock.ts` | 基于 `AudioContext.currentTime` 的时钟,支持负时间(lead-in)、seek、变速、低速静音 |
| `replay/frames.ts` | 回放帧 SoA 存储、按键位域规范化、`cursorAt` 插值、剔除 `-12345` seed 哨兵帧 |
| `sim/types.ts` | 全部核心类型:`JudgementEvent` / `CumulativeState` / `ReplayTimeline` / `PlaybackState` 等 |
| `sim/difficulty.ts` | AR→preempt、OD→命中窗口、CS→半径,公式对齐 lazer |
| `sim/timeline.ts` | `buildTimeline`(Pass 1)+ 视觉窗口索引 + HP drain 分段;判定环节留了 `JudgementPass` 插桩接口 |
| `sim/query.ts` | `stateAt` / `hpAt` / `activeObjectsAt` —— 纯查询,无副作用 |
| `load/replayLoader.ts` | `.osr` 适配器。字段映射已按实测结果**写死**(不再探测),含 legacy mod 位掩码解码 |

**播放与渲染**

- [x] `player/PlaybackController.ts` — 播放控制收敛层。**关键:五个功能各只需三五行**,这是预编译时间线架构的直接红利
  - `togglePlay` / `seek` / `skip` / `setRate`
  - `stepDisplayFrame(±1)` — 步进 1/60 秒(多数人说"逐帧"的意思)
  - `stepReplayFrame(±1)` — 步进一个**回放输入帧**(不等间隔,分析型用途;预渲染视频方案永远做不到)
- [x] `render/DebugRenderer.ts` — canvas2d 调试渲染器:判定区、光标、拖尾、物件占位圈 + approach circle
- [x] `main.ts` — 接线:文件载入、播放控件、键盘快捷键、rAF 循环、侧栏 HUD

**验证(2026-08-23)**

- [x] **A1 已解除** —— 三层验证:静态 import 分析 → `vite build` 产物零 `node:` 引用 → headless Chrome 实跑 4 个真实回放。详见 [TECH-NOTES A1](./TECH-NOTES.md)
- [x] 按实测结果重写 `replayLoader.ts`:改用 osu-parsers 自带类型(去掉 `as unknown` 体操),修掉 `mods` 显示成 `"0"` 的 bug,补上 legacy mod 位掩码解码
- [x] **对照 lazer 源码核 `difficulty.ts`**,发现并修正三处偏差(详见 [TECH-NOTES B7](./TECH-NOTES.md))
- [x] **发现并修复渲染器的 canvas 状态泄漏**(详见 [TECH-NOTES C4](./TECH-NOTES.md))
- [x] 加了 `?osr=&t=` 的开发用自动载入,让 headless 验收可无人值守跑
- [x] **186 个单测全绿** —— 每个核心模块都有专属测试文件:

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `search.test.ts` | 17 | 二分查找**对照暴力扫描**(11 种数组形态 × 每元素 ±1 的查询点);重复值取首/取末的语义;`clamp` 负区间 |
| `frames.test.ts` | 17 | 哨兵帧、稳定排序、**零间隔帧不去重**、按键规范化、`cursorAt` 插值与边界 |
| `difficulty.test.ts` | 19 | 全部公式对照 lazer 手算值(不从本项目实现反推) |
| `AudioClock.test.ts` | 27 | 假 `AudioContext` 驱动:0.05×~4× 倍速、lead-in 负时间调度、低速静音、seek 幂等 |
| `PlaybackController.test.ts` | 18 | 逐帧往返、输入帧吸附语义、边界饱和、夹取 |
| `timeline.test.ts` | 32 | break 区间的裁剪/合并、时间轴范围的物件∪帧并集、`assertAscending` 守卫 |
| `query.test.ts` | 18 | `stateAt` 幂等/顺序无关/倒序一致、`activeObjectsAt` **对照暴力扫描**、`hpAt` 的 break 分段 |
| `replayLoader.test.ts` | 46 | mod 位掩码格式化 + 5 个真实 `.osr` 的字段映射(素材缺失则跳过) |

> M1 又加了六个文件:`beatmapLoader.test.ts`(61)、`judgementAccuracy.test.ts`(23 + 24 todo)、
> `performance.test.ts`(16)、`stacking.test.ts`(51)、`judgement.test.ts`(65)、
> `sliderParts.test.ts`(26),另有 `judgementReport.test.ts`(诊断报告,只打印)。
> 当前总计 **437 通过 + 24 todo**。

> `timeline.test.ts` 由另一次会话补写(补的原因:`timeline.ts` 当时是唯一没有专属测试的核心模块 ——
> `query.test.ts` 只间接覆盖到它,而 `buildDrainProfile` 的 break 裁剪/合并、`buildTimeline` 的
> 范围并集计算这两块一行未测)。那次会话 shell 不可用、无法执行,**已于本次会话跑通:32 个全过,
> `tsc --noEmit` 亦通过**,故计入绿灯数。
>
> `search.test.ts` 补的是同类空白:`search.ts` 号称"整个 seek 的地基"却零测试,而二分最容易在
> 边界与**重复值**上错 —— 而 B6 刚证实真实数据里就有重复值。

### M0 验收标准 —— 全部通过

| | 标准 | 结果 | 判据 |
|---|---|---|---|
| 1 | 载入真实 `.osr`,侧栏正确显示玩家名/分数/帧数/mods/来源 | ✅ | 4 个样本实跑,mods 显示 `NM`/`HDFL`/`AP` 均正确 |
| 2 | 光标轨迹随播放正确移动,按键指示与实际操作吻合 | ✅ | 200 个时刻取到 187~195 个不同光标位置;帧时刻上光标与帧数据逐位吻合;导出画面确认 M1 在上半环、M2 在下半环,与原始位域一致 |
| 3 | **随机拖动进度条,每次画面都正确** | ✅ | 40 个时刻「顺序渲染 vs 乱序渲染」`canvas.toDataURL()` **逐像素相同**;同一时刻重渲 6 次一致;跳到末尾再跳回画面还原 |
| 4 | 倍速 0.05× ~ 4× 均可用,极低倍速静音 | ✅ | `AudioClock.test.ts` 覆盖 10 档倍速 + 静音阈值 + 变速不跳变 |
| 5 | 逐帧前进 N 次再后退 N 次,回到完全相同的画面 | ✅ | 显示帧与输入帧两种步进,+30/-30 后画面**逐像素还原** |

> 验收 3 与 5 的判据是 `canvas.toDataURL()` 逐像素比对,而不是人眼 —— 正是这个判据抓出了那个一像素的 canvas 状态泄漏(TECH-NOTES C4),人眼看不出来。
>
> 仍**建议**人工跑一次 `npm run dev` 做主观确认(动画手感、音画同步)。带音频的同步验证目前没有自动化判据。

---

## 关键决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 渲染后端 | ❌ danser-go → ✅ 浏览器原生 | CPU-only 服务器 + 用户上传皮肤 + 期望浏览器计算,三条各自都能否决 danser |
| 状态管理 | ❌ checkpoint 增量重放 → ✅ 预编译时间线 | 回放输入在加载时已完全已知,没理由把模拟推迟到 seek 时 |
| 时钟来源 | ❌ `<audio>.currentTime` → ✅ `AudioContext.currentTime` | 前者抖动可达数十 ms,足以让 approach circle 视觉抖动 |
| 回放帧存储 | ❌ 对象数组 → ✅ SoA TypedArray | 3 万帧 × 对象 = 3 万个 GC 对象 |
| 模拟层与解析层 | 解耦,`SimBeatmap` 自定义类型 + 适配器 | 若 osu-parsers 不可用需自写解析器,不应波及模拟与渲染 |
| `.osr` 解析器 | ✅ 沿用 osu-parsers(不自写) | A1 已验证 browser 构建可用;自写解析器 + wasm LZMA 的备选方案**不必启动** |
| 解析器加载方式 | ✅ 动态 `import()` + 命名解构 | 解析器独立成 chunk 不进首屏;命名解构让 Rollup 能 tree-shake。M0 只用 `ScoreDecoder` 时 71 KB,M1 加 `BeatmapDecoder` 后 141 KB(它内部拉进故事板解析)|
| `.osr` 测试素材 | 不入库,放 `fixtures/`,测试条件执行 | 体积 + 再分发问题;缺素材时跳过而非失败,CI 仍能跑纯函数部分 |
| 游戏逻辑公式来源 | ✅ 逐条对照 `ppy/osu` 源码,不凭印象 | 实测一对就发现三处偏差,全都影响判定边界(TECH-NOTES B7) |
| "无跨帧状态"的边界 | ✅ 含 canvas context,每帧开头归零 | context 本身就是跨帧可变状态,泄漏会导致"回到同一时刻画面不同"(TECH-NOTES C4) |
| 验收判据 | ✅ `canvas.toDataURL()` 逐像素比对,而非人眼 | 那个一像素的状态泄漏人眼看不出来 |

---

## 当前阻塞与风险

| 编号 | 问题 | 状态 |
|---|---|---|
| ~~A1~~ | ~~osu-parsers 能否在浏览器里解 `.osr` 的 LZMA 帧数据~~ | ✅ **已解除**(2026-08-23) |
| **A2** | 自己模拟的判定能否复现 `.osr` 头部的原始成绩 | 🟡 **骨架已建,L1 实测 4/4 通过**;L3(判定器)未开始 —— 仍是最高风险 |
| ~~D9~~ | ~~物件堆叠未实现~~ | ✅ **已解决**(2026-08-23)。实测 61/302 物件堆叠,层数 `[-2, 11]` |
| ~~D10~~ | ~~谱面与回放是否匹配未校验~~ | ✅ **已解决**(2026-08-23)。引 spark-md5,已用 RFC 1321 向量 + Node crypto 双重验证 |
| D11 | 自动获取谱面依赖外部镜像站 | 🟡 **已确认的权衡**:osu.direct 可用,另两个当时故障。手动上传路径必须保留 |
| D1 | HP drain 的分段计算 | 🟡 结构与 `hpAt` 已实现且有单测;`drainPerMs` 仍是占位值。stable 的 `replay.lifeBar` 可作 ground truth |
| D2 | 倍速的音高保持 | 🟡 M0 接受变调,待确认用户预期 |
| ~~D6~~ | ~~osu-parsers 格式版本时效性~~ | ✅ **已完全解除**:`.osr` 10/10、`.osu` 4/4(fileFormat 14) |
| ~~D7~~ | ~~DT/HT 回放的播放倍率未补偿~~ | ✅ **已解决**(2026-08-23)。时钟速率 = modRate × userRate |
| D8 | 渲染层没有常驻的自动化回归保护 | 🟡 逐像素验收是临时页面跑的,未入库。改渲染器时要手动重建 |
| D4 | 滑条体 WebGL 渲染 | ⬜ M2 专项。好消息:`SliderPath` 带 `positionAt()`,路径细分不必自己写 |

详见 [TECH-NOTES.md](./TECH-NOTES.md)。

---

## 下一步(按优先级)

1. **滑条刻度 / repeat / 尾的判定** —— 需要跟踪光标是否落在 follow circle 内、按键是否保持按住。这是 maxCombo 与滑条整体 300/100/50 精确对上的**唯一前提**,也是 M2 的一半工作量。
2. **stable 分数公式** —— **刻意排在滑条判定之后**:每个刻度都加分,所以在刻度判定实现前,算出的分数无法与 `.osr` 比对。写一个验不了的公式等于埋雷。难度系数公式已核过(`CalculateDifficultyPeppyStars`,见 TECH-NOTES B14)。
3. **circle 的正式渲染** —— combo 数字、combo 颜色、命中/miss 动画。目前是 `DebugRenderer` 的占位圈。
4. **HP drain(D1)** —— `drainPerMs` 的真实推导。stable 回放自带 `replay.lifeBar` 可作 ground truth。
5. **L3 的 24 个 `todo` 逐条填绿** —— 随上面几项自然完成。


## 复现验收的方法

```bash
npm test          # 477 通过 + 24 todo,~13s
npm run build     # tsc --noEmit + vite build
npm run dev       # 然后开(只需要一个 .osr,谱面与音乐自动获取):
                  #   http://localhost:5173/?osr=/fixtures/stable.osr
                  # 想手动指定谱面就再加 &osu=/fixtures/stable.osu
                  # 想直接跳到某时刻就加 &t=76989
```

`?osr=` / `?osu=` / `?t=` 是开发用的自动载入参数(文件选择框没法从脚本填,headless 验收需要它)。

### 无人值守的浏览器验收

浏览器专属的东西(CORS、`decodeAudioData`、canvas 像素)只能在真实浏览器里验,而 headless Chrome 的 `--dump-dom` 是一次性快照 —— 等不到网络与音频解码,而且它本身会让 Chrome 立刻退出。

所以加了 `verifySink`(见 `vite.config.ts`,仅 dev):

```bash
npm run dev   # 另开一个终端
# 不要加 --dump-dom!页面需要活着把结果 POST 出来
chrome --headless=new --disable-gpu --user-data-dir=<tmp> \
  "http://localhost:5173/?osr=/fixtures/stable.osr&verify=app"
# 然后轮询 .verify-out/app.txt(读的时候要显式 UTF-8)
```

自己写的验证页面也可以 `fetch('/__verify/<name>', { method: 'POST', body: ... })`。

渲染层的逐像素验收(M0 验收 3 / 5)仍是用临时页面跑的,**没有留在仓库里** —— 但现在有了 `verifySink` 这条通道,把它做成常驻用例的门槛低了很多(见 [TECH-NOTES D8](./TECH-NOTES.md))。

---

## 版本控制约定

2026-08-23 起纳入 git(此前无版本控制)。分支 `main`,远端 `KawakazeNotFound/osu-replay-web`(**私有**)。

### 每个 commit 都必须是绿的

`.githooks/pre-commit` 会在提交前跑 `tsc --noEmit` + `vitest run`,不通过就中止。
理由:「保管好每个 checkpoint」的前提是每个 checkpoint 都能编译、测试都绿 ——
否则 `git bisect` 会踩到一堆坏提交,历史就失去排查价值。

**新 clone 需要执行一次**(hook 路径是 per-clone 配置,不随仓库自动生效):

```bash
git config core.hooksPath .githooks
```

临时跳过(存 WIP、实验性提交):`git commit --no-verify`。

> ⚠️ hook 校验的是**工作区**而非暂存区。单人项目按全量提交时无碍;若开始做
> 部分提交(`git add -p`),需要改成先 stash 未暂存内容再校验。

### 什么时候切一个 checkpoint

- 一个可独立描述的能力做完并验证通过(如"`.osu` 解析层落地")
- 一个 bug 修掉并加了回归测试
- 一批文档更新落定
- 动手改高风险代码**之前**(留一个已知良好的退回点)

不为"写了几行"提交。commit message 用中文,首行是能一眼看懂的结论,正文说
**为什么**这么做 —— 尤其是那些"看起来能简化、简化了就对不上 stable"的地方。

### 素材与个人配置不入库

`.osu` / `.osr` / `.osz` / `.osk` 全部排除(体积 + 再分发问题)。
`.claude/settings.local.json` 是个人权限配置,按约定不共享。

依赖真实素材的测试对缺失是**跳过**而非失败,所以 clone 下来即可 `npm test`。

### 换行符

`.gitattributes` 设了 `* text=auto`:仓库内统一存 LF,检出时按平台还原。
不加这条的后果是 Windows 上写的 CRLF 原样入库,换机器或走 CI 时整仓库显示被改动。
校验方式:`git ls-files --eol`,应全部为 `i/lf`。

---

## 待办杂项

- **仓库改名**:目录名 `OSUReplay-Danser` 已不准确(danser 不再是后端),建议改为 `osu-replay-web`(`package.json` 里的 name 已经是这个)。不阻塞。
- **git**:✅ 已纳入版本控制(2026-08-23),约定见上一节。远端 `KawakazeNotFound/osu-replay-web`(私有)。
- **`fixtures/` 现有素材**(不入库):
  - 4 组完整配对:`stable` / `stable-hdfl` / `lazer` / `lazer-moonlight`(各含 `.osu` + `.osr`)
  - 1 个只有回放的:`lazer-ap.osr`(谱面 MD5 `43c04b70…` 本机没有,留作降级路径测试)
  - `fixtures/user/`:原始素材(2 个 `.osz` 谱面包 + 2 个回放),配对脚本从这里解 `.osu`
- **权限**:生态调研需要的 WebSearch / `git clone` 曾被权限拦截。`raw.githubusercontent.com` 的 WebFetch 已放开(核对 lazer 源码用的就是它)。
