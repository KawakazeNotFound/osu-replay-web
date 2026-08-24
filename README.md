# osu-replay-web

浏览器原生的 osu! 回放(`.osr`)播放器,支持**逐帧精确的任意跳转**。

> ⚠️ 开发中(M1 阶段)。目前能自动获取谱面与音乐、渲染物件、判定 circle 与滑条头;
> 分数公式、HP、滑条刻度判定、正式皮肤渲染尚未完成。详见 [docs/PROGRESS.md](docs/PROGRESS.md)。

## 现在能做什么

**丢一个 `.osr` 进来就行** —— 按谱面 MD5 自动从镜像站取回 `.osz`,解包挑出正确难度,
连音乐一起装好(实测约 6 秒)。然后:

- 任意拖动进度条,画面**逐像素正确**(不存在"只在顺序播放时对"的问题)
- 0.05× ~ 4× 倍速;DT/HT 回放按玩家当时的实际节奏播
- **两种逐帧**:按 1/60 秒步进,或按**回放输入帧**步进(不等间隔,分析用)
- 校验谱面与回放是否匹配(MD5),不匹配会明确报错而不是默默画错

## 快速开始

```bash
npm install
npm run dev
# 开 http://localhost:5173,选一个 .osr 即可
```

谱面与回放**不入库**(版权 + 体积)。想让测试跑到真实数据,把 `.osr` / `.osu` 放进
`fixtures/`(皮肤放 `fixtures/user/*.osk`);缺素材时相关测试会**跳过**而非失败,
所以 clone 下来直接 `npm test` 就能跑。

默认皮肤的贴图**在仓库里**(`public/skins/default/`,CC BY-NC,见下方"许可")。
要重新抓取或更新:

```bash
node scripts/fetch-default-skin.mjs   # 已存在的跳过,加 --force 重下
```

```bash
npm test        # 722 通过,0 todo
npm run build   # tsc --noEmit + vite build
```

## 架构要点

核心是**预编译时间线**:加载时把 (谱面, 回放) 一次性编译成不可变的 `ReplayTimeline`,
之后所有查询都是纯读。于是 seek 退化为二分查找,"快进/快退/逐帧/倍速"全部等价于
对不同的 `t` 调用 `stateAt()` —— **不存在"倒退"这个特例**,因为查询从不依赖上一帧的结果。

已在真实谱面上验证:随机 seek 与顺序播放**同速**,同屏物件数有界。

```
core/util/search    二分查找,整个 seek 的地基
core/clock          Clock 接口 + ManualClock + AudioClock(基于 AudioContext.currentTime)
core/replay/frames  回放帧 SoA(TypedArray)存储、按键位域规范化、光标插值
core/load           .osr / .osu / .osz 适配器、镜像站客户端、MD5
core/sim            难度换算、堆叠、判定、时间线、纯查询
player              播放控制收敛层
render              canvas2d 调试渲染器(M1 后期换 WebGL)
```

## 一条贯穿全项目的原则

**判定 / 难度 / 滑条这些地方一律对照 [ppy/osu](https://github.com/ppy/osu) 源码,不凭印象。**

这条不是洁癖。实测每次对照都会发现真问题:

- `preemptFromAR` 少了 `(int)` 截断、`hitWindowsFromOD` 少了 `floor(x) - 0.5`、
  `radiusFromCS` 少了 `1.00041` 的 fudge —— 三处都影响判定边界
- 自动 miss 的阈值是 **meh 窗口**而不是 400ms(400 只是 hit policy 的 `hittableRange`)
- 堆叠算法里**只有两处** `(int)` 截断,且 circle 与 slider 两个分支的时间比较规则**不同**

而且**能对答案**:`.osr` 头部记了原始成绩,它是判定实现的黄金标准。靠它抓出过
三个错误(其中一个是我自己的推理前提错了 —— `countMiss == 0` **不等于** full combo,
因为 slider break 打断 combo 但不计 miss)。

细节见 [docs/TECH-NOTES.md](docs/TECH-NOTES.md)。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构推理:为什么否决 danser-go、为什么用预编译时间线 |
| [docs/TECH-NOTES.md](docs/TECH-NOTES.md) | 已确认的事实、踩过的坑、待解决的问题 |
| [docs/PROGRESS.md](docs/PROGRESS.md) | 进度、验收标准、版本控制约定 |

## 依赖

| 包 | 用途 |
|---|---|
| `osu-parsers` / `osu-classes` | `.osu` / `.osr` 解析(自带 browser 构建,零 Node API) |
| `fflate` | `.osz` 解包(zip),零依赖 |
| `spark-md5` | 谱面 MD5(`crypto.subtle` 不支持 MD5) |

**刻意没用** `osu-standard-stable` —— 它与当前 lazer master 有两处实质分歧
(preempt 不截断、圈半径缺 fudge),而那会传导进堆叠结果。详见 TECH-NOTES B11。

## 外部服务依赖

自动获取谱面依赖镜像站(当前用 `osu.direct`)。**镜像站挂了这个功能就用不了**,
所以手动上传谱面的路径永久保留,UI 上"自动获取"是个可关掉的开关。

## 许可

本项目自身的许可**未定**。但仓库里有第三方内容,它们各自的条件已经生效:

| 内容 | 来源 | 许可 | 实际约束 |
|---|---|---|---|
| `public/skins/default/*.png`(75 个) | [`ppy/osu-resources`](https://github.com/ppy/osu-resources) 的 legacy 默认皮肤 | **CC BY-NC 4.0** | 需**署名**;**本项目不得商用** |
| 判定 / 难度 / 渲染的公式实现 | [`ppy/osu`](https://github.com/ppy/osu) | MIT | 保留版权声明即可 |

⚠️ **CC BY-NC 的 NC 是硬约束:只要 `public/skins/default/` 还在仓库里,本项目就不能
用于商业用途。** 若将来要商用,必须先移除该目录并改用自有素材,或取得 ppy 的授权。
署名与细节见 [`public/skins/default/NOTICE.md`](public/skins/default/NOTICE.md)。

另外 `ppy/osu-resources` 明确:该许可**不覆盖** "osu!" / "ppy" 的**商标** ——
贴图可以用,但不能拿 osu! 的名称或 logo 当本项目的标识。

**谱面与音频**仍然一概不入库(版权 + 体积),见上面的"快速开始"。
