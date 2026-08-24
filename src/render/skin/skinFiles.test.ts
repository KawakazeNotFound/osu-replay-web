import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { resolveTexture, hasFont, unpackSkin } from './skinFiles';
import {
  DEFAULT_SKIN_VERSION,
  FONT_DEFAULTS,
  LATEST_SKIN_VERSION,
  parseSkinIni,
} from './skinIni';

/**
 * # 皮肤解析与贴图查找
 *
 * 这一层完全是纯函数(不碰 `createImageBitmap` / `AudioContext`),所以能在
 * Node 下逐项断言 —— 这正是把解码隔离出去的收益。
 */

/* ---------------- skin.ini ---------------- */

describe('skin.ini:Version', () => {
  it('没写 Version → 1.0,不是 latest', () => {
    // 核 LegacySkinDecoder.CreateTemplateObject():config.LegacyVersion = 1.0m
    const ini = parseSkinIni('[General]\nName: foo\n');
    expect(ini.version).toBe(DEFAULT_SKIN_VERSION);
    expect(ini.version).toBe(1.0);
    expect(ini.isLatestVersion).toBe(false);
  });

  it('Version: latest → LATEST_VERSION(2.7)且置 isLatestVersion', () => {
    const ini = parseSkinIni('[General]\nVersion: latest\n');
    expect(ini.version).toBe(LATEST_SKIN_VERSION);
    expect(ini.version).toBe(2.7);
    expect(ini.isLatestVersion).toBe(true);
  });

  it('数值版本按小数解析', () => {
    expect(parseSkinIni('[General]\nVersion: 2.5\n').version).toBe(2.5);
    expect(parseSkinIni('[General]\nVersion: 1\n').version).toBe(1);
  });

  it('解析不出来的 Version 退回 1.0(而不是 NaN)', () => {
    const ini = parseSkinIni('[General]\nVersion: banana\n');
    expect(ini.version).toBe(DEFAULT_SKIN_VERSION);
    expect(Number.isNaN(ini.version)).toBe(false);
  });
});

describe('skin.ini:[Colours]', () => {
  it('Combo1..N 按文件顺序读入', () => {
    const ini = parseSkinIni(
      ['[Colours]', 'Combo1 : 10,20,30', 'Combo2 : 40,50,60'].join('\n'),
    );
    expect(ini.comboColours).toEqual([
      { r: 10, g: 20, b: 30 },
      { r: 40, g: 50, b: 60 },
    ]);
  });

  it('🔒 顺序就是索引 —— 编号不参与定位', () => {
    // 核 LegacyDecoder.HandleColours:编号只做 1..8 的范围校验,
    // 通过就 CustomComboColours.Add(colour),数字随即丢弃
    const ini = parseSkinIni(
      ['[Colours]', 'Combo3 : 1,1,1', 'Combo1 : 2,2,2'].join('\n'),
    );
    expect(ini.comboColours).toEqual([
      { r: 1, g: 1, b: 1 }, // Combo3 写在前面 ⇒ 它就是第 0 个
      { r: 2, g: 2, b: 2 },
    ]);
  });

  it('🔒 alpha 被丢弃 —— 皮肤路径同样是 allowAlpha: false', () => {
    // LegacySkinDecoder 对 Section.Colours 不拦截,落到基类的
    // HandleColours(output, line, false)。只有 [CatchTheBeat] 传 true
    const ini = parseSkinIni('[Colours]\nCombo1 : 10,20,30,128\n');
    expect(ini.comboColours).toEqual([{ r: 10, g: 20, b: 30 }]);
    // 没有 a 字段可言 —— Rgb 类型本身就不含 alpha
    expect(Object.keys(ini.comboColours[0]!)).toEqual(['r', 'g', 'b']);
  });

  it('编号越界的 ComboN 不算 combo 色', () => {
    // lazer:comboIndex 必须落在 1..MAX_COMBO_COLOUR_COUNT(=8)
    const ini = parseSkinIni(
      ['[Colours]', 'Combo0 : 1,1,1', 'Combo9 : 2,2,2', 'Combo1 : 3,3,3'].join('\n'),
    );
    expect(ini.comboColours).toEqual([{ r: 3, g: 3, b: 3 }]);
    // 它们掉进 custom-colour 字典
    expect(ini.raw.get('Combo0')).toBe('1,1,1');
    expect(ini.raw.get('Combo9')).toBe('2,2,2');
  });

  it('最多 8 个', () => {
    const lines = ['[Colours]'];
    for (let i = 1; i <= 8; i++) lines.push(`Combo${i} : ${i},${i},${i}`);
    expect(parseSkinIni(lines.join('\n')).comboColours).toHaveLength(8);
  });

  it('SliderBorder / SliderTrackOverride 单独取出', () => {
    const ini = parseSkinIni(
      ['[Colours]', 'SliderBorder : 1,2,3', 'SliderTrackOverride : 4,5,6'].join('\n'),
    );
    expect(ini.sliderBorder).toEqual({ r: 1, g: 2, b: 3 });
    expect(ini.sliderTrackOverride).toEqual({ r: 4, g: 5, b: 6 });
    // 它们不该混进 combo 色
    expect(ini.comboColours).toHaveLength(0);
  });

  it('分量非法的颜色整条作废,不影响其他行', () => {
    const ini = parseSkinIni(
      ['[Colours]', 'Combo1 : 1,2', 'Combo2 : 3,4,5', 'Combo3 : x,y,z'].join('\n'),
    );
    expect(ini.comboColours).toEqual([{ r: 3, g: 4, b: 5 }]);
  });
});

describe('skin.ini:[Fonts] 的默认值按字体不同', () => {
  it('🔒 HitCircleOverlap 默认 -2,而 Score / Combo 默认 0', () => {
    // 核 LegacySkinExtensions.cs:166-185。
    // ⚠️ 参考实现只建模了一个 hitCircleOverlap: -2,套到 score/combo 上会挤在一起
    const ini = parseSkinIni('');

    expect(ini.hitCircleOverlap).toBe(-2);
    expect(ini.scoreOverlap).toBe(0);
    expect(ini.comboOverlap).toBe(0);

    expect(FONT_DEFAULTS.hitCircleOverlap).toBe(-2);
    expect(FONT_DEFAULTS.scoreOverlap).toBe(0);
    expect(FONT_DEFAULTS.comboOverlap).toBe(0);
  });

  it('前缀默认:hitcircle → "default",score 与 combo 都 → "score"', () => {
    // GetFontPrefix:Combo 也是 "score" —— 不是 "combo"
    const ini = parseSkinIni('');
    expect(ini.hitCirclePrefix).toBe('default');
    expect(ini.scorePrefix).toBe('score');
    expect(ini.comboPrefix).toBe('score');
  });

  it('显式写的值覆盖默认', () => {
    const ini = parseSkinIni(
      ['[Fonts]', 'HitCirclePrefix: custom/num', 'HitCircleOverlap: 5'].join('\n'),
    );
    expect(ini.hitCirclePrefix).toBe('custom/num');
    expect(ini.hitCircleOverlap).toBe(5);
  });

  it('反斜杠路径归一成正斜杠小写,并去掉尾部斜杠', () => {
    const ini = parseSkinIni('[Fonts]\nHitCirclePrefix: Fonts\\HitCircle\\Default\\\n');
    expect(ini.hitCirclePrefix).toBe('fonts/hitcircle/default');
  });

  it('空字符串前缀退回默认', () => {
    expect(parseSkinIni('[Fonts]\nHitCirclePrefix: \n').hitCirclePrefix).toBe('default');
  });
});

describe('skin.ini:行处理', () => {
  it('行内注释被截断,但行首 // 整行跳过', () => {
    // 核 LegacyDecoder.StripComments:index > 0 才截
    const ini = parseSkinIni(
      ['[General]', 'Name: skin // 这是注释', '// Author: nobody'].join('\n'),
    );
    expect(ini.name).toBe('skin');
    expect(ini.author).toBe('');
  });

  it('未识别的键原样进 raw,保留大小写', () => {
    const ini = parseSkinIni('[General]\nAllowSliderBallTint: 1\nAnimationFramerate: 30\n');
    expect(ini.raw.get('AllowSliderBallTint')).toBe('1');
    expect(ini.raw.get('AnimationFramerate')).toBe('30');
  });

  it('值里含冒号时只按第一个冒号拆', () => {
    const ini = parseSkinIni('[General]\nName: a:b:c\n');
    expect(ini.name).toBe('a:b:c');
  });

  it('CRLF、空行、缺冒号的行都不会让解析崩', () => {
    const ini = parseSkinIni('[General]\r\n\r\nName: x\r\ngarbage line\r\n');
    expect(ini.name).toBe('x');
  });

  it('空文件给出全默认值', () => {
    const ini = parseSkinIni('');
    expect(ini.name).toBe('');
    expect(ini.comboColours).toHaveLength(0);
    expect(ini.sliderBorder).toBeNull();
    expect(ini.version).toBe(1.0);
  });
});

/* ---------------- 贴图查找 ---------------- */

/** 只关心"有哪些文件",用 Set 更直观。 */
function fileSet(...names: string[]): ReadonlySet<string> {
  return new Set(names);
}

describe('贴图查找:@2x 优先', () => {
  it('两个都有时取 @2x,并报 scale = 2', () => {
    const files = fileSet('hitcircle.png', 'hitcircle@2x.png');
    expect(resolveTexture(files, 'hitcircle')).toEqual({
      path: 'hitcircle@2x.png',
      scale: 2,
    });
  });

  it('只有 SD 时取 SD,scale = 1', () => {
    expect(resolveTexture(fileSet('hitcircle.png'), 'hitcircle')).toEqual({
      path: 'hitcircle.png',
      scale: 1,
    });
  });

  it('只有 @2x 时也能取到', () => {
    expect(resolveTexture(fileSet('hitcircle@2x.png'), 'hitcircle')).toEqual({
      path: 'hitcircle@2x.png',
      scale: 2,
    });
  });

  it('都没有 → null', () => {
    expect(resolveTexture(fileSet('other.png'), 'hitcircle')).toBeNull();
  });

  it('🔒 scale 必须报出来 —— @2x 贴图要按半尺寸画', () => {
    // 对应 lazer 的 texture.ScaleAdjust = ratio。参考实现的
    // `images.get(stem+'@2x.png') ?? images.get(stem+'.png')` 拿不到这个信息,
    // 于是每个调用点都得自己再查一遍才知道用了哪档
    const hd = resolveTexture(fileSet('a@2x.png'), 'a');
    const sd = resolveTexture(fileSet('b.png'), 'b');
    expect(hd?.scale).toBe(2);
    expect(sd?.scale).toBe(1);
  });
});

describe('🔒 贴图查找:两个 lazer 有、参考实现没有的细节', () => {
  it('请求名里自带的 @2x 会先被剥掉', () => {
    // 源码注释:"stable happens to check for that and strip them,
    //           so do the same to match stable behaviour."
    const files = fileSet('hitcircle.png', 'hitcircle@2x.png');

    // 传 hitcircle@2x 与传 hitcircle 结果完全一样
    expect(resolveTexture(files, 'hitcircle@2x')).toEqual(
      resolveTexture(files, 'hitcircle'),
    );
  });

  it('剥掉之后不会去找 hitcircle@2x@2x', () => {
    // 若不剥,`hitcircle@2x` 会被拼成 `hitcircle@2x@2x.png`(不存在),
    // 然后退回 SD 分支查 `hitcircle@2x.png` —— 路径碰巧对,但 scale 会报成 1,
    // 于是 HD 贴图被按原尺寸画成两倍大
    const found = resolveTexture(fileSet('hitcircle@2x.png'), 'hitcircle@2x');
    expect(found).toEqual({ path: 'hitcircle@2x.png', scale: 2 });
  });

  it('@2x 插在扩展名之前,不是名字末尾', () => {
    // Path.ChangeExtension(name, null) + "@2x" + Path.GetExtension(name)
    const files = fileSet('hitcircle@2x.png');
    expect(resolveTexture(files, 'hitcircle.png')?.path).toBe('hitcircle@2x.png');
  });
});

describe('贴图查找:扩展名与路径', () => {
  it('不带扩展名时按 .png → .jpg 顺序补', () => {
    expect(resolveTexture(fileSet('bg.jpg'), 'bg')?.path).toBe('bg.jpg');
    // 两个都有时 png 优先
    expect(resolveTexture(fileSet('bg.jpg', 'bg.png'), 'bg')?.path).toBe('bg.png');
  });

  it('大小写不敏感', () => {
    expect(resolveTexture(fileSet('hitcircle.png'), 'HitCircle')?.path).toBe('hitcircle.png');
  });

  it('保留子目录路径 —— [Fonts] 前缀可以指向子目录', () => {
    const files = fileSet('fonts/hitcircle/default-0.png', 'default-0.png');
    expect(resolveTexture(files, 'fonts/hitcircle/default-0')?.path).toBe(
      'fonts/hitcircle/default-0.png',
    );
    // 根目录的同名文件不会被子目录的顶掉
    expect(resolveTexture(files, 'default-0')?.path).toBe('default-0.png');
  });
});

describe('hasFont:判据是有没有 "-0" 那个字形', () => {
  it('有 prefix-0 → true', () => {
    // 核 LegacySkinExtensions.cs:137 —— GetTexture($"{prefix}-0") != null
    expect(hasFont(fileSet('default-0.png'), 'default')).toBe(true);
    expect(hasFont(fileSet('default-0@2x.png'), 'default')).toBe(true);
  });

  it('只有 1..9 但没有 0 → false', () => {
    const files = fileSet('default-1.png', 'default-2.png');
    expect(hasFont(files, 'default')).toBe(false);
  });
});

/* ---------------- .osk 解包 ---------------- */

/** 造一个内存 zip。 */
function makeOsk(entries: Record<string, string>): ArrayBuffer {
  const encoder = new TextEncoder();
  const zipped = zipSync(
    Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, encoder.encode(v)])),
  );
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

describe('unpackSkin', () => {
  it('解出文件并解析根目录的 skin.ini', () => {
    const osk = makeOsk({
      'skin.ini': '[General]\nName: My Skin\n[Colours]\nCombo1: 9,8,7\n',
      'hitcircle.png': 'x',
    });

    const skin = unpackSkin(osk);
    expect(skin.ini.name).toBe('My Skin');
    expect(skin.ini.comboColours).toEqual([{ r: 9, g: 8, b: 7 }]);
    expect(skin.files.has('hitcircle.png')).toBe(true);
  });

  it('🔒 只认根目录的 skin.ini,子目录里的残留不生效', () => {
    const osk = makeOsk({
      'skin.ini': '[General]\nName: root\n',
      'old/skin.ini': '[General]\nName: leftover\n',
    });
    expect(unpackSkin(osk).ini.name).toBe('root');
  });

  it('没有 skin.ini 时给出全默认值而不是报错', () => {
    // 很多皮肤压根不带 skin.ini,只有贴图 —— 那完全合法
    const skin = unpackSkin(makeOsk({ 'hitcircle.png': 'x' }));
    expect(skin.ini.version).toBe(1.0);
    expect(skin.ini.comboColours).toHaveLength(0);
    expect(skin.files.size).toBe(1);
  });

  it('路径归一成小写正斜杠', () => {
    const skin = unpackSkin(makeOsk({ 'Fonts/HitCircle/Default-0.PNG': 'x' }));
    expect([...skin.files.keys()]).toEqual(['fonts/hitcircle/default-0.png']);
  });

  it('不是 zip 时报出可读错误(带首字节)', () => {
    const notZip = new TextEncoder().encode('<html>404</html>');
    expect(() =>
      unpackSkin(notZip.buffer.slice(0, notZip.byteLength) as ArrayBuffer),
    ).toThrow(/不是有效的 \.osk/);
  });

  it('解包后可以直接喂给 resolveTexture', () => {
    const skin = unpackSkin(makeOsk({ 'hitcircle@2x.png': 'x', 'hitcircle.png': 'y' }));
    expect(resolveTexture(skin.files, 'hitcircle')).toEqual({
      path: 'hitcircle@2x.png',
      scale: 2,
    });
  });
});
