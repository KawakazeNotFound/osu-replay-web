# 架构设计

> 状态:M0 设计阶段。本文档描述目标架构,不代表已实现。
> 最后更新:2026-08-23

## 0. 项目定位

浏览器内运行的 osu! 回放(.osr)播放器,目标能力:

- 帧精确的快进 / 快退 / 暂停 / 任意倍速 / 逐帧步进
- osu!lazer 的判定 / 记分 / mod 体系
- 自定义皮肤(预设 + 用户上传),运行时即时切换
- 网页 UI 尽量贴近 lazer 客户端观感

**全部计算在用户浏览器完成。** 服务端只做谱面代理与缓存(CPU 即可,无 GPU)。

### 为什么不用 danser-go 做渲染后端

原方案是服务端跑 danser `-record` 出 mp4,浏览器用 `<video>` 播。已否决,三个硬冲突:

| 约束 | 冲突 |
|---|---|
| 部署环境只有普通 CPU 云服务器 | danser 硬性要求 OpenGL 3.3+ 真实 GPU。Mesa llvmpipe 软渲染理论可行,但 1080p60 只有个位数 fps,3 分钟的图约 10800 帧需数十分钟到数小时。不可用。 |
| 用户可上传皮肤 | 预渲染的经济性完全依赖缓存命中。皮肤/分辨率任一变化即需重渲染,命中率归零。 |
| 期望在用户浏览器计算 | 这本身就是浏览器原生渲染路线。 |

补充:danser 的 CLI 没有任何交互式 seek / scrub / 暂停接口,也没有 headless 模式(已核对其 README)。它本质是"把整个回放批处理成视频"的工具,游戏状态机从头单向前推。即便有 GPU,也不匹配本项目需求。

danser 仍有一个潜在价值:作为**判定结果的交叉验证参照**(见 `TECH-NOTES.md` 的判定复现问题)。

---

## 1. 核心设计:预编译时间线

这是整个项目最重要的一个决策,几乎决定了后续所有代码的形状。

### 问题

osu! 的分数 / 连击 / 准确率 / HP 是**路径依赖**的:t=60s 时的连击数取决于前 60 秒发生过什么。所以"跳到 60 秒"不能只是把时钟一改了事,必须知道那一刻的完整游戏状态。

### 曾考虑但否决的方案:checkpoint + 增量重放

每隔 N 秒存一份状态快照,seek 时从最近快照前推到目标时刻。

这是**实时交互场景**(用户真的在打图)的正确解法,因为未来输入未知,只能边走边算。但回放场景不是这样:

> **回放的全部输入在加载完成的那一刻就已经完全已知了。**

既然如此,没有任何理由把模拟推迟到 seek 时。checkpoint 方案在这里是过度设计:它保留了"增量前推"的成本(每次 seek 最多 N 秒的模拟量),换来的是应对不确定输入的能力 —— 而这个能力我们并不需要。

### 采用方案:加载时全量模拟一次,编译成不可变时间线

**Pass 1(加载时执行一次)**:跑完整个回放的模拟,产出一条按时间排序的判定事件流。关键在于**每个事件上直接存该事件生效后的累积聚合值**(分数、连击、HP、各判定计数)。

**运行时查询 `stateAt(t)`**:二分查找最后一个 `time ≤ t` 的事件,聚合值直接读出来。**不跑任何模拟。**

```
复杂度:  seek = O(log n)     (n = 判定事件数,典型 2000~10000)
         逐帧 = 同一个操作
         倒退 = 同一个操作
```

### 这个设计的收益

1. **四个功能塌缩成一个操作**。快进 / 快退 / 逐帧 / 倍速 全部等价于"求 `stateAt(t)`"。不存在"倒退"这个特例,因为渲染层从不依赖上一帧的状态。
2. **渲染层无状态**。每一帧都是 `render(stateAt(clock.now()))`。没有需要重置的可变状态,没有"倒退时忘了回滚某个字段"这类 bug。
3. **Pass 1 成本可忽略**。约 2000 个物件 × 约 30000 个回放帧,一次性 <100ms。
4. **天然可测试**。Pass 1 是纯函数,输入 (beatmap, replay, mods) 输出 timeline,可以直接对着原始成绩做断言。

### 代价与边界

- **mod / 谱面 / 转谱设置变更需要重跑 Pass 1**。可接受(<100ms),但意味着 timeline 必须是不可变的,不能就地改。
- **内存**。timeline 存全量事件 + 每事件的聚合快照。粗估每事件约 64 字节,10000 事件约 640KB。可忽略。
- **HP 是连续量,不是纯事件驱动**(物件之间有被动流失)。不能只存事件点的 HP,需要分段函数。见下。

---

## 2. 数据流

```
                     ┌─────────────────────────────────────┐
   .osz / .osr  ───▶ │ 解析层  osu-parsers / osu-classes   │
   (上传或镜像代理)   └─────────────────┬───────────────────┘
                                       │  Beatmap + Score + ReplayFrames
                                       ▼
                     ┌─────────────────────────────────────┐
                     │ Pass 1  buildTimeline()             │  ← 每次 (map, replay, mods) 变更跑一次
                     │  全量模拟 → 判定事件流 + 累积聚合    │
                     └─────────────────┬───────────────────┘
                                       │  ReplayTimeline (不可变)
                                       ▼
   Clock ──── t ────▶ ┌─────────────────────────────────────┐
   (音频驱动)          │ stateAt(timeline, t)  纯查询 O(log n)│
                      └─────────────────┬───────────────────┘
                                        │  PlaybackState (每帧新建)
                                        ▼
                      ┌─────────────────────────────────────┐
                      │ 渲染层(无状态) + HUD + UI           │
                      └─────────────────────────────────────┘
```

关键约束:**箭头是单向的。渲染层不得回写状态,`stateAt` 不得有副作用。** 一旦破坏,scrub 就会出现"只在顺序播放时正确"的 bug。

---

## 3. 核心类型

见 `src/core/sim/types.ts` 为准,这里说明设计意图。

### JudgementEvent

```ts
interface JudgementEvent {
  time: number         // 判定发生的时刻(ms,谱面时间)
  objectIndex: number  // 指向 hitObjects 的下标
  part: JudgementPart  // circle / sliderHead / sliderTick / sliderTail / spinner...
  result: HitResult

  cum: CumulativeState // ★ 此事件生效"之后"的累积状态
}
```

`cum` 是让 `stateAt` 变成 O(log n) 的全部原因。用空间换掉了运行时的模拟。

### HP 的分段处理

HP 同时受两件事影响:判定事件(离散跳变)和被动流失(连续下降,且仅在 drain section 内生效,break 期间和第一个物件之前不流失)。

所以 `cum.hp` 只记录事件时刻的值,另有一份 `DrainProfile` 描述流失区间:

```
hpAt(t) = clamp(lastEvent.cum.hp - drainRateInEffect(lastEvent.time, t))
```

`drainRateInEffect` 需要跳过 break 区间。**这是最容易写错的一处**,见 TECH-NOTES。

### 可见物件查询

每个物件预计算视觉窗口 `[visualStart, visualEnd]`(含 preempt / fade in / fade out / 命中动画尾巴)。按 `visualStart` 排序,并记录全局 `maxVisualDuration`。

```
activeAt(t) = 二分找到 visualStart ≤ t 的位置,向前回溯直到 visualStart < t - maxVisualDuration
```

O(log n + k),精确,无需扫描全表,也不依赖"上一帧渲染了什么"。

### 光标

回放帧存成 SoA(三个并行 TypedArray:time / x / y / keys),不是对象数组。原因:典型回放 30000 帧,对象数组会产生 30000 个 GC 对象;TypedArray 是三块连续内存,二分查找 cache 友好。

`cursorAt(t)` = 二分找到 `time ≤ t` 的帧,位置对下一帧做线性插值,按键**不插值**(取前一帧的值)。

---

## 4. 时钟

时钟是唯一的时间真相来源,渲染层只读它。

```ts
interface Clock {
  readonly currentTime: number   // ms,谱面时间,可为负(lead-in)
  readonly rate: number
  readonly isRunning: boolean
  play(): void
  pause(): void
  seek(ms: number): void
  setRate(rate: number): void
}
```

两个实现:

- **`AudioClock`** — 生产用。时间从 `AudioContext.currentTime` 推导(采样精确、不受渲染帧率抖动影响),不用 `<audio>.currentTime`(抖动可达数十 ms)。
- **`ManualClock`** — 逐帧步进与单元测试用。时间手动设定,无音频。

### 为什么不能用 `<audio>.currentTime`

它的更新粒度受浏览器实现限制,实测抖动足以让 approach circle 视觉上抖动。`AudioContext.currentTime` 由音频硬件时钟驱动,单调、采样精确。

### AudioClock 的推导公式

播放中:

```
currentTime = anchorBeatmapMs + (ctx.currentTime - anchorCtxSec) * 1000 * rate
```

`seek` / `setRate` / `play` 都归约成同一个操作:停掉当前 `AudioBufferSourceNode`,以新 offset 建一个新的,重设 anchor。暂停则冻结 `currentTime` 的快照值。

**负时间(lead-in)**:谱面时间可以早于音频起点。此时不启动音频源,而是用 `ctx.currentTime` 自由跑,并把音频源调度到未来的 `when` 时刻启动(`AudioBufferSourceNode.start(when, offset)` 支持)。

---

## 5. 渲染层(M1 起)

- WebGL2,PixiJS v8 做批渲染
- 渲染层实现 `Renderer` 接口:`draw(state: PlaybackState): void`,无内部游戏状态
- **滑条体是全项目最难的单点技术**。lazer 用 depth buffer + 三角带做立体渐变,靠深度测试让自重叠处不叠色。M0/M1 用简陋画法占位,M2 专项攻克。

M0 只做一个 canvas2d 的调试渲染器(光标轨迹 + 时间轴),目的是验证时钟与 `stateAt` 架构,不追求观感。

---

## 6. 服务端(最后阶段)

唯一职责:谱面获取代理 + 缓存。普通 CPU 云服务器足够。

- 用户直接上传 .osz / .osr → 完全不需要服务端
- 或经代理拉镜像站(catboy.best / nerinyan / osu.direct)
- 加缓存是为了减轻镜像站压力并绕开 CORS

不在服务端做:渲染、判定、模拟。这些全在浏览器。

---

## 7. 里程碑

| | 内容 | 状态 |
|---|---|---|
| **M0** | 地基:解析 + 时钟 + timeline + `stateAt` + 调试渲染器(光标轨迹)。**目的是验证架构,不是好看** | 进行中 |
| M1 | circle 渲染 + approach circle + combo 数字 + circle 判定 | |
| M2 | 滑条(路径生成 + WebGL slider body)← 最难 | |
| M3 | spinner + 记分/HP/连击 HUD | |
| M4 | stable 皮肤系统(.osk 解析,预设 + 用户上传) | |
| M5 | lazer 记分体系 + mod | |
| M6 | Argon 风格皮肤 + 网页 UI 打磨 | |

M0 做对了架构,后面基本是往里填内容。M0 做错了架构(尤其是让状态泄漏到渲染层),后面要重写。
