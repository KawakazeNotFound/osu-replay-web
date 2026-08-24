/**
 * 抓取 osu! 的 legacy 默认皮肤资源到 `public/skins/default/`。
 *
 * ## 为什么把这一步留成脚本而不是"手动下载好就完事"
 *
 * 素材是**别人的**,来源与许可必须可追溯。脚本本身就是出处声明:
 * 谁都能重跑一遍确认 `public/skins/default/` 里的东西确实来自
 * `ppy/osu-resources` 的 `Skins/Legacy`,没有被谁悄悄换掉。
 *
 * ## 许可(CC BY-NC 4.0)
 *
 * `ppy/osu-resources` 的 `LICENCE.md` 是 **Creative Commons
 * Attribution-NonCommercial 4.0 International**。两条实际义务:
 *
 * 1. **署名** —— 见 `public/skins/default/NOTICE.md`
 * 2. **非商用** —— 只要这些文件在仓库里,本项目就不能商用
 *
 * 另外该 README 明确:许可**不覆盖** "osu!" / "ppy" 的**商标**
 * (软件名、资源、广告、宣传中的品牌使用)。所以贴图可以用,
 * 但不能拿 osu! 的名字/logo 当本项目的招牌。
 *
 * ## 只取 std 用得到的那一部分
 *
 * 上游 `Skins/Legacy` 有 286 个文件、19.4 MB —— 含 catch(`fruit-*`)、
 * mania(`mania-*`)、taiko(`taiko*` / `pippidon*`)、菜单音效等。
 * 我们只做 osu!std,所以按 {@link WANTED} 明确列出要哪些,
 * **不用通配** —— 免得上游加了什么就被动跟进。
 *
 * 用法:`node scripts/fetch-default-skin.mjs`(已存在的文件跳过,加 `--force` 重下)
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO = 'ppy/osu-resources';
const REF = 'master';
const SRC_DIR = 'osu.Game.Resources/Skins/Legacy';
const OUT_DIR = 'public/skins/default';

/**
 * 要抓的组件名(**不带** `@2x` 与扩展名)。
 *
 * ⚠️ 上游这批资源**全部是 `@2x`**,一个 SD 版都没有。这正好是我们
 * `resolveTexture` 返回 `scale` 的现实依据:默认皮肤整体是 HD,
 * 若把 `ScaleAdjust` 搞错,画出来的一切都会大一倍。
 */
const WANTED = [
  // 圈
  'hitcircle', 'hitcircleoverlay', 'hitcircleselect', 'approachcircle',
  // 圈内数字(HitCirclePrefix 默认 "default")
  ...digits('default'),
  // 滑条
  'reversearrow', 'sliderfollowcircle', 'sliderscorepoint',
  'sliderendmiss', 'slidertickmiss', 'sliderb-nd', 'sliderb-spec',
  ...Array.from({ length: 10 }, (_, i) => `sliderb${i}`),
  // 转盘
  'spinner-approachcircle', 'spinner-bottom', 'spinner-circle', 'spinner-clear',
  'spinner-glow', 'spinner-middle', 'spinner-middle2', 'spinner-rpm',
  'spinner-spin', 'spinner-top', 'spinner-warning',
  // 判定图标
  'hit0', 'hit50', 'hit100', 'hit100k', 'hit300', 'hit300g', 'hit300k',
  // 命中闪光
  'lighting', 'lightingN',
  // 光标
  'cursor', 'cursormiddle', 'cursortrail', 'cursor-smoke',
  // followpoint
  'followpoint',
  // HUD:分数字体(ScorePrefix / ComboPrefix 默认都是 "score")
  ...digits('score'), 'score-comma', 'score-dot', 'score-percent', 'score-x',
  // HUD:血条与按键覆盖
  'scorebar-bg', 'scorebar-colour', 'scorebar-marker',
  'inputoverlay-background', 'inputoverlay-key',
];

/** `prefix-0` … `prefix-9`。 */
function digits(prefix) {
  return Array.from({ length: 10 }, (_, i) => `${prefix}-${i}`);
}

const force = process.argv.includes('--force');

await mkdir(OUT_DIR, { recursive: true });

const existing = new Set(await readdir(OUT_DIR).catch(() => []));

let fetched = 0;
let skipped = 0;
const missing = [];

for (const name of WANTED) {
  // 上游一律是 @2x
  const upstream = `${name}@2x.png`;

  // ⚠️ **落盘要转小写。** 上游有混合大小写的文件名(实测 `lightingN@2x.png`),
  // 而我们的贴图索引与 `resolveTexture` 都按小写工作。
  //
  // 若原样落盘,会踩一个只在部署时才显形的坑:Windows 开发机的文件系统
  // 大小写不敏感,一切正常;而 `loadDefaultSkin` 把清单转小写后再拼 URL,
  // 到了**大小写敏感的 Linux 服务器**上就 404 —— 本地永远测不出来。
  //
  // 这个坑是 `defaultSkin.test.ts` 的"文件名全小写"那条测出来的。
  const file = upstream.toLowerCase();

  if (!force && existing.has(file)) {
    skipped++;
    continue;
  }

  const url = `https://raw.githubusercontent.com/${REPO}/${REF}/${SRC_DIR}/${upstream}`;
  const res = await fetch(url);

  if (!res.ok) {
    // 不抛错:上游改名/删文件时,我们要看到**完整**的缺失清单,
    // 而不是在第一个错误处停下
    missing.push(`${upstream} (HTTP ${res.status})`);
    continue;
  }

  await writeFile(join(OUT_DIR, file), new Uint8Array(await res.arrayBuffer()));
  fetched++;
}

const total = (
  await Promise.all(
    (await readdir(OUT_DIR)).map(async (f) => (await stat(join(OUT_DIR, f))).size),
  )
).reduce((a, b) => a + b, 0);

// ---- 清单 ----
//
// 运行时需要知道"这一层有哪些文件"才能做贴图查找,但**不该为此发 75 个 HEAD 请求**。
// 所以把文件名列表落成 index.json,由 loadDefaultSkin() 一次取回。
//
// 生成而非手写:手写必然会与磁盘漂移。`defaultSkin.test.ts` 会断言两者一致。
const onDisk = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.png')).sort();
await writeFile(join(OUT_DIR, 'index.json'), `${JSON.stringify(onDisk, null, 2)}\n`);

console.log(`新下载 ${fetched} 个,跳过 ${skipped} 个已存在的。`);
console.log(`${OUT_DIR}:${onDisk.length} 个 png,共 ${(total / 1024).toFixed(0)} KB,清单已写入 index.json。`);

if (missing.length > 0) {
  console.error(`\n⚠️ 以下 ${missing.length} 个没抓到(上游可能改名或删除):`);
  for (const m of missing) console.error(`  ${m}`);
  process.exitCode = 1;
}
