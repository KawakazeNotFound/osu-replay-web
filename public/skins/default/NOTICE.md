# 第三方素材声明

本目录下的全部 `*.png` 来自 **osu!** 官方资源仓库,**不是**本项目的原创内容。

| | |
|---|---|
| 来源 | [`ppy/osu-resources`](https://github.com/ppy/osu-resources) — `osu.Game.Resources/Skins/Legacy` |
| 版权 | ppy Pty Ltd 及 osu! 贡献者 |
| 许可 | [Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/)(CC BY-NC 4.0) |
| 抓取方式 | `node scripts/fetch-default-skin.mjs`(脚本里列明了取哪些文件) |

这是 osu! 的 **legacy 默认皮肤**(游戏内名为 `osu! "classic" (2013)`,作者署名
`team osu!`),在本项目中的用途是:**用户没有加载自定义皮肤、或自定义皮肤缺少
某个组件时的兜底贴图**。

## 由此产生的两条硬约束

1. **署名** —— 就是本文件。分发本项目时请保留它。
2. **非商用** —— CC BY-NC 的 NC 是 NonCommercial。**只要这些文件还在仓库里,
   本项目就不能用于商业用途。** 若将来要商用,必须先移除本目录并改用自有素材
   (或取得 ppy 的授权)。

## 商标不在许可范围内

`ppy/osu-resources` 的 README 明确:该许可**不覆盖** "osu!" 与 "ppy" 的**商标**
—— 包括在软件名称、资源、广告与宣传中使用其品牌。

所以:**贴图可以按 CC BY-NC 使用,但不能拿 osu! 的名称或 logo 作为本项目的标识。**

## 其他

- 上游这批资源**全部是 `@2x`(HD)**,没有 SD 版本。绘制时必须按
  `Texture.ScaleAdjust = 2` 折半,见 `src/render/skin/skinFiles.ts`。
- 上游还有 catch / mania / taiko 的素材与全部音效,本项目只做 osu!std,
  **未取用**。
- 上游部分**字体**有独立许可(README 提到),本项目未取用任何字体文件。
