import { describe, expect, it, vi } from 'vitest';

import {
  NO_SPRITES,
  OSU_STD_COMPONENTS,
  fontComponents,
  loadSkinSprites,
  type ImageDecoder,
} from './skinTextures';
import { parseSkinIni } from './skinIni';
import type { SkinLayer } from './skinStack';

/**
 * # 贴图装载
 *
 * 这一层的价值全在**纪律**上:贴图必须在渲染开始前一次性装好,之后不再变化。
 * 否则"同一时刻的绘制序列逐项相同"这条核心不变式会被破坏 ——
 * 第一次画到 t 时贴图没好(线框),seek 回 t 时好了(贴图)。
 */

/** 造一层,`load` 按表返回字节。 */
function layer(
  name: string,
  files: Record<string, Uint8Array | Error>,
): SkinLayer {
  return {
    name,
    ini: parseSkinIni(''),
    files: new Set(Object.keys(files)),
    load: async (path) => {
      const hit = files[path];
      if (hit === undefined) throw new Error(`${name} 无 ${path}`);
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
}

const BYTES = new Uint8Array([1, 2, 3]);

/** 一个假解码器:按字节长度编出宽高,便于断言"确实是这张图"。 */
const fakeDecode: ImageDecoder = async (bytes, mime) => ({
  width: bytes.length * 10,
  height: mime === 'image/jpeg' ? 7 : 5,
} as never);

describe('loadSkinSprites', () => {
  it('装好的贴图带上像素尺寸、scale 与来源层', async () => {
    const sprites = await loadSkinSprites(
      [layer('用户皮肤', { 'hitcircle@2x.png': BYTES })],
      ['hitcircle'],
      fakeDecode,
    );

    const s = sprites.get('hitcircle');
    expect(s).not.toBeNull();
    expect(s!.width).toBe(30);
    expect(s!.height).toBe(5);
    expect(s!.scale).toBe(2);
    expect(s!.layer).toBe('用户皮肤');
  });

  it('🔒 scale 跟着**命中的那一层**,不是跟着栈', async () => {
    const user = layer('用户皮肤', { 'hitcircle.png': BYTES });
    const fallback = layer('默认皮肤', {
      'hitcircle@2x.png': BYTES,
      'approachcircle@2x.png': BYTES,
    });

    const sprites = await loadSkinSprites(
      [user, fallback],
      ['hitcircle', 'approachcircle'],
      fakeDecode,
    );

    // 用户的是 SD
    expect(sprites.get('hitcircle')!.scale).toBe(1);
    expect(sprites.get('hitcircle')!.layer).toBe('用户皮肤');
    // 用户没有 approachcircle ⇒ 落到默认皮肤,那边是 @2x
    expect(sprites.get('approachcircle')!.scale).toBe(2);
    expect(sprites.get('approachcircle')!.layer).toBe('默认皮肤');
  });

  it('皮肤没提供的组件 → get 返回 null,且**不算失败**', async () => {
    const sprites = await loadSkinSprites(
      [layer('皮肤', { 'hitcircle.png': BYTES })],
      ['hitcircle', 'reversearrow'],
      fakeDecode,
    );

    expect(sprites.get('reversearrow')).toBeNull();
    // 缺组件是常态(实测用户皮肤就缺 approachcircle),不该混进 failed
    expect(sprites.failed).toEqual([]);
    expect(sprites.size).toBe(1);
  });

  it('🔒 一张坏图不能让整个皮肤装不上', async () => {
    const sprites = await loadSkinSprites(
      [
        layer('皮肤', {
          'hitcircle.png': BYTES,
          'cursor.png': new Error('取字节失败'),
        }),
      ],
      ['hitcircle', 'cursor'],
      fakeDecode,
    );

    // 好的那张仍然装上了
    expect(sprites.get('hitcircle')).not.toBeNull();
    expect(sprites.get('cursor')).toBeNull();
    expect(sprites.failed).toEqual(['cursor']);
  });

  it('解码抛错也归入 failed', async () => {
    const boom: ImageDecoder = async () => {
      throw new Error('坏 png');
    };

    const sprites = await loadSkinSprites(
      [layer('皮肤', { 'hitcircle.png': BYTES })],
      ['hitcircle'],
      boom,
    );

    expect(sprites.failed).toEqual(['hitcircle']);
    expect(sprites.get('hitcircle')).toBeNull();
  });

  it('重复的组件名只装一次', async () => {
    const decode = vi.fn(fakeDecode);
    await loadSkinSprites(
      [layer('皮肤', { 'hitcircle.png': BYTES })],
      ['hitcircle', 'hitcircle', 'hitcircle'],
      decode,
    );
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('MIME 按扩展名给', async () => {
    const sprites = await loadSkinSprites(
      [layer('皮肤', { 'bg.jpg': BYTES })],
      ['bg'],
      fakeDecode,
    );
    // fakeDecode 在 jpeg 上给 height 7
    expect(sprites.get('bg')!.height).toBe(7);
  });

  it('空栈 / 空名单不炸', async () => {
    expect((await loadSkinSprites([], ['hitcircle'], fakeDecode)).size).toBe(0);
    expect((await loadSkinSprites([layer('a', {})], [], fakeDecode)).size).toBe(0);
  });

  it('🔒 装好之后 get 的结果稳定 —— 这是核心不变式的前提', async () => {
    const sprites = await loadSkinSprites(
      [layer('皮肤', { 'hitcircle.png': BYTES })],
      ['hitcircle'],
      fakeDecode,
    );

    // 同一个名字多次取到的是同一个对象。若哪天有人改成"懒加载 + 写回缓存",
    // 第一次会是 null、第二次才有值 —— 那正是这条要防的
    const a = sprites.get('hitcircle');
    const b = sprites.get('hitcircle');
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });
});

describe('NO_SPRITES', () => {
  it('一切返回 null —— 没皮肤时全走自绘', () => {
    expect(NO_SPRITES.get('hitcircle')).toBeNull();
    expect(NO_SPRITES.size).toBe(0);
    expect(NO_SPRITES.failed).toEqual([]);
  });
});

describe('组件名单', () => {
  it('fontComponents 展开 0..9', () => {
    expect(fontComponents('default')).toEqual([
      'default-0', 'default-1', 'default-2', 'default-3', 'default-4',
      'default-5', 'default-6', 'default-7', 'default-8', 'default-9',
    ]);
  });

  it('名单里没有重复项', () => {
    expect(new Set(OSU_STD_COMPONENTS).size).toBe(OSU_STD_COMPONENTS.length);
  });

  it('名单全小写、不带扩展名与 @2x', () => {
    for (const n of OSU_STD_COMPONENTS) {
      expect(n, n).toBe(n.toLowerCase());
      expect(n, n).not.toMatch(/\.(png|jpg)$/);
      expect(n, n).not.toContain('@2x');
    }
  });
});
