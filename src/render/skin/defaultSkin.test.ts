import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_SKIN_INDEX, loadDefaultSkin, userSkinLayer } from './defaultSkin';
import { resolveTexture } from './skinFiles';
import {
  DEFAULT_SLIDER_BALL_COLOUR,
  circleComponentName,
  defaultSkinIni,
  findProvider,
  resolveInLayers,
  type SkinLayer,
} from './skinStack';
import { DEFAULT_SKIN_VERSION, LATEST_SKIN_VERSION, parseSkinIni } from './skinIni';

/**
 * # 默认皮肤与分层查找
 *
 * 两部分:
 * - **磁盘一致性**:`public/skins/default/` 的清单与实际文件必须对得上
 * - **分层语义**:逐组件回退、`findProvider`、圈类命名决策
 */

const SKIN_DIR = join(process.cwd(), 'public', 'skins', 'default');

/* ---------------- 默认皮肤的配置(代码里写死的那些) ---------------- */

describe('🔒 默认皮肤的配置来自代码,不是解析空 ini', () => {
  /**
   * `ppy/osu-resources` 的 `Skins/Legacy` **没有 skin.ini**,而
   * `DefaultLegacySkin` 的构造函数把配置直接赋上了。图省事写成
   * `parseSkinIni('')` 会让默认皮肤拿到 1.0,圈内数字的动画就走错分支
   * (`LegacyMainCirclePiece.cs:183` 的 `legacyVersion > 1.0m`)。
   */
  it('版本是 2.7 / latest,而不是空 ini 的 1.0', () => {
    const ini = defaultSkinIni();

    expect(ini.version).toBe(LATEST_SKIN_VERSION);
    expect(ini.isLatestVersion).toBe(true);

    // 与"解析空 ini"明确区分开 —— 这是本条的全部意义
    expect(parseSkinIni('').version).toBe(DEFAULT_SKIN_VERSION);
    expect(ini.version).not.toBe(parseSkinIni('').version);
  });

  it('自带 osu 的 combo 四色', () => {
    // DefaultLegacySkin.DEFAULT_COMBO_COLOURS
    expect(defaultSkinIni().comboColours).toEqual([
      { r: 255, g: 192, b: 0 },
      { r: 0, g: 202, b: 0 },
      { r: 18, g: 124, b: 255 },
      { r: 242, g: 24, b: 57 },
    ]);
  });

  it('AllowSliderBallTint 显式为 true', () => {
    // Configuration.ConfigDictionary[nameof(LegacySetting.AllowSliderBallTint)] = "true"
    expect(defaultSkinIni().raw.get('AllowSliderBallTint')).toBe('true');
  });

  it('滑条球色 (2, 170, 255)', () => {
    expect(DEFAULT_SLIDER_BALL_COLOUR).toEqual({ r: 2, g: 170, b: 255 });
  });

  it('[Fonts] 的默认值仍与 parseSkinIni 同源,没有各写一遍', () => {
    const ini = defaultSkinIni();
    const empty = parseSkinIni('');

    expect(ini.hitCirclePrefix).toBe(empty.hitCirclePrefix);
    expect(ini.hitCircleOverlap).toBe(empty.hitCircleOverlap);
    expect(ini.scorePrefix).toBe(empty.scorePrefix);
  });
});

/* ---------------- 磁盘一致性(素材缺失则跳过) ---------------- */

const hasAssets = existsSync(join(SKIN_DIR, DEFAULT_SKIN_INDEX));

describe.skipIf(!hasAssets)('public/skins/default 的清单与磁盘', () => {
  function indexNames(): string[] {
    return JSON.parse(readFileSync(join(SKIN_DIR, DEFAULT_SKIN_INDEX), 'utf-8')) as string[];
  }

  it('🔒 清单与磁盘上的 png 完全一致 —— 防漂移', () => {
    // 清单是脚本生成的,但生成之后有人手动删/加文件就会漂移。
    // 漂移的后果:resolveTexture 说"有",load() 却 404
    const onDisk = readdirSync(SKIN_DIR).filter((f) => f.endsWith('.png')).sort();
    expect(indexNames().slice().sort()).toEqual(onDisk);
  });

  it('文件名全小写 —— resolveTexture 假定索引是小写', () => {
    for (const n of indexNames()) expect(n, n).toBe(n.toLowerCase());
  });

  it('⚠️ 上游这批资源全部是 @2x,没有 SD 版', () => {
    // 这就是 resolveTexture 必须返回 scale 的现实依据:默认皮肤整体是 HD,
    // ScaleAdjust 搞错的话画出来的一切都大一倍
    const names = indexNames();
    expect(names.length).toBeGreaterThan(50);
    for (const n of names) expect(n, `${n} 应带 @2x`).toContain('@2x');
  });

  it('覆盖了用户皮肤缺的那两个组件', () => {
    // test.osk 缺 approachcircle 与 reversearrow —— 兜底层必须有,否则白做
    const files = new Set(indexNames());
    expect(resolveTexture(files, 'approachcircle')).not.toBeNull();
    expect(resolveTexture(files, 'reversearrow')).not.toBeNull();
  });

  it('圈内数字与分数字体的 0..9 都齐', () => {
    const files = new Set(indexNames());
    for (let d = 0; d <= 9; d++) {
      expect(resolveTexture(files, `default-${d}`), `default-${d}`).not.toBeNull();
      expect(resolveTexture(files, `score-${d}`), `score-${d}`).not.toBeNull();
    }
  });

  it('⚠️ 记录:默认皮肤没有 sliderstartcircle —— 所以滑条头就用 hitcircle', () => {
    // 这条不是缺陷,是 osu 的实际情况。circleComponentName 的回退依赖它
    const files = new Set(indexNames());
    expect(resolveTexture(files, 'sliderstartcircle')).toBeNull();
    expect(resolveTexture(files, 'hitcircle')).not.toBeNull();
  });

  it('NOTICE.md 在,且写明了 CC BY-NC 与非商用', () => {
    // 署名是 CC BY-NC 的硬义务。这条防"某次清理顺手把它删了"
    const notice = readFileSync(join(SKIN_DIR, 'NOTICE.md'), 'utf-8');
    expect(notice).toContain('CC BY-NC');
    expect(notice).toContain('ppy/osu-resources');
    expect(notice).toMatch(/非商用|NonCommercial/);
  });
});

/* ---------------- loadDefaultSkin ---------------- */

/** 一个假 fetch:按路径查表。 */
function fakeFetch(table: Record<string, string | Uint8Array>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const hit = table[url];
    if (hit === undefined) return { ok: false, status: 404 } as Response;

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(hit as string),
      arrayBuffer: async () => {
        const bytes = typeof hit === 'string' ? new TextEncoder().encode(hit) : hit;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    } as Response;
  }) as typeof fetch;
}

describe('loadDefaultSkin', () => {
  it('从清单建出文件索引', async () => {
    const layer = await loadDefaultSkin(
      '/s',
      fakeFetch({ '/s/index.json': '["hitcircle@2x.png","cursor@2x.png"]' }),
    );

    expect(layer.files.has('hitcircle@2x.png')).toBe(true);
    expect(resolveTexture(layer.files, 'hitcircle')).toEqual({
      path: 'hitcircle@2x.png',
      scale: 2,
    });
  });

  it('字节是懒加载的 —— 建层时不取任何贴图', async () => {
    const asked: string[] = [];
    const spy: typeof fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ['hitcircle@2x.png'],
        arrayBuffer: async () => new ArrayBuffer(4),
      } as Response;
    }) as typeof fetch;

    const layer = await loadDefaultSkin('/s', spy);
    expect(asked, '建层只该取清单').toEqual(['/s/index.json']);

    await layer.load('hitcircle@2x.png');
    expect(asked).toEqual(['/s/index.json', '/s/hitcircle@2x.png']);
  });

  it('清单取不到时抛出可操作的错误(而不是静默降级)', async () => {
    await expect(loadDefaultSkin('/s', fakeFetch({}))).rejects.toThrow(
      /取不到默认皮肤清单.*fetch-default-skin/s,
    );
  });

  it('清单不是字符串数组时抛出', async () => {
    await expect(
      loadDefaultSkin('/s', fakeFetch({ '/s/index.json': '{"a":1}' })),
    ).rejects.toThrow(/不是字符串数组/);
  });

  it('清单与实际不一致时,load 报出来', async () => {
    const layer = await loadDefaultSkin(
      '/s',
      fakeFetch({ '/s/index.json': '["ghost@2x.png"]' }),
    );
    await expect(layer.load('ghost@2x.png')).rejects.toThrow(/缺文件.*清单与实际内容不一致/s);
  });
});

/* ---------------- 分层查找 ---------------- */

/** 造一层。 */
function layer(name: string, files: readonly string[], ini = parseSkinIni('')): SkinLayer {
  return {
    name,
    ini,
    files: new Set(files),
    load: async () => new Uint8Array(0),
  };
}

describe('🔒 逐层回退是逐组件的,不是逐皮肤的', () => {
  /**
   * 对应 `SkinProvidingContainer.GetTexture` 的 foreach。
   *
   * 这条是"用默认资源兜底"这个需求的**全部内容**:用户皮肤有 hitcircle
   * 但缺 approachcircle 时,approachcircle 要能从默认皮肤取到,
   * 而不是"整套用用户的"或"整套用默认的"。
   */
  const user = layer('用户皮肤', ['hitcircle.png', 'cursor@2x.png']);
  const fallback = layer('默认皮肤', [
    'hitcircle@2x.png',
    'approachcircle@2x.png',
    'cursor@2x.png',
  ]);
  const stack = [user, fallback];

  it('上层有就用上层', () => {
    const found = resolveInLayers(stack, 'hitcircle');
    expect(found?.layer.name).toBe('用户皮肤');
    expect(found?.path).toBe('hitcircle.png');
    // 用户是 SD、默认是 @2x —— scale 必须跟着**命中的那层**
    expect(found?.scale).toBe(1);
  });

  it('上层没有就落到下层,且 scale 跟着下层', () => {
    const found = resolveInLayers(stack, 'approachcircle');
    expect(found?.layer.name).toBe('默认皮肤');
    expect(found?.scale).toBe(2);
  });

  it('两层都有时下层不参与', () => {
    expect(resolveInLayers(stack, 'cursor')?.layer.name).toBe('用户皮肤');
  });

  it('都没有 → null(调用方降级成自绘)', () => {
    expect(resolveInLayers(stack, 'reversearrow')).toBeNull();
  });

  it('空栈不炸', () => {
    expect(resolveInLayers([], 'hitcircle')).toBeNull();
  });
});

describe('findProvider', () => {
  it('返回第一个满足条件的层', () => {
    const a = layer('a', ['x.png']);
    const b = layer('b', ['x.png', 'y.png']);

    expect(findProvider([a, b], (l) => l.files.has('x.png'))?.name).toBe('a');
    expect(findProvider([a, b], (l) => l.files.has('y.png'))?.name).toBe('b');
  });

  it('没有满足的 → null', () => {
    expect(findProvider([layer('a', [])], (l) => l.files.has('z.png'))).toBeNull();
  });
});

describe('🔒 圈类物件的命名决策:决策看单层,取图看全栈', () => {
  /**
   * `LegacyMainCirclePiece.load()` 的那段注释:
   *
   * > - Beatmap provides `hitcircle`
   * > - User skin provides `sliderstartcircle`
   * > In such a case, the `hitcircle` should be used for slider start circles
   * > rather than the user's skin override.
   */
  it('提供 hitcircle 的那层也有前缀 → 用前缀', () => {
    const user = layer('用户皮肤', ['hitcircle.png', 'sliderstartcircle.png']);
    expect(circleComponentName([user], 'sliderstartcircle')).toBe('sliderstartcircle');
  });

  it('🔒 前缀在**另一层** → 不用前缀,退回 hitcircle', () => {
    // 上层提供 hitcircle,下层提供 sliderstartcircle。
    // 若拿整个栈判断,会错误地选中 sliderstartcircle —— 那正是源码要避免的情形
    const top = layer('谱面皮肤', ['hitcircle.png']);
    const bottom = layer('用户皮肤', ['sliderstartcircle.png']);

    expect(circleComponentName([top, bottom], 'sliderstartcircle')).toBe('hitcircle');
  });

  it('同一层同时有两者 → 用前缀', () => {
    const top = layer('谱面皮肤', ['hitcircle.png', 'sliderstartcircle.png']);
    const bottom = layer('用户皮肤', ['sliderstartcircle.png']);

    expect(circleComponentName([top, bottom], 'sliderstartcircle')).toBe('sliderstartcircle');
  });

  it('没有前缀需求时恒为 hitcircle', () => {
    const user = layer('用户皮肤', ['hitcircle.png', 'sliderstartcircle.png']);
    expect(circleComponentName([user], null)).toBe('hitcircle');
  });

  it('没有任何层提供 hitcircle 时,退化成对整个栈判断', () => {
    // 源码:`?? skin` —— FindProvider 返回 null 时用整个层级
    const only = layer('用户皮肤', ['sliderstartcircle.png']);
    expect(circleComponentName([only], 'sliderstartcircle')).toBe('sliderstartcircle');
  });
});

describe('userSkinLayer', () => {
  it('把字节表包成一层,load 命中', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const l = userSkinLayer(parseSkinIni(''), new Map([['hitcircle.png', bytes]]));

    expect(l.files.has('hitcircle.png')).toBe(true);
    expect(await l.load('hitcircle.png')).toEqual(bytes);
  });

  it('load 不存在的路径时抛出', async () => {
    const l = userSkinLayer(parseSkinIni(''), new Map());
    await expect(l.load('nope.png')).rejects.toThrow(/没有 nope\.png/);
  });
});
