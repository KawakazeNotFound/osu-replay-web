import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { md5OfBuffer, md5OfBytes } from './beatmapHash';
import { loadReplay } from './replayLoader';
import { findAudio, pickBeatmapByMd5, unpackOsz } from './oszLoader';
import { OSU_DIRECT } from './mirror';

/* ---------------- MD5:先用标准向量证明实现可信 ---------------- */

/**
 * RFC 1321 附录 A.5 的测试向量。
 *
 * 为什么要测第三方库:整个"按 MD5 挑难度"都建立在它之上,而 MD5 错了症状很隐蔽
 * —— 会变成"镜像站没有这张图",而不是明显的崩溃。
 */
const RFC1321_VECTORS: readonly (readonly [string, string])[] = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  [
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    'd174ab98d277d9f5a5611c2c9f419d9f',
  ],
  [
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
    '57edf4a22be3c955ac49da2e2107b67a',
  ],
];

describe('md5 —— RFC 1321 标准测试向量', () => {
  it.each(RFC1321_VECTORS)('md5(%j) === %s', (input, expected) => {
    expect(md5OfBytes(new TextEncoder().encode(input))).toBe(expected);
  });

  it('与 Node crypto 对随机字节逐位一致', () => {
    // 确定性 PRNG,失败可复现
    let seed = 20260823;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;

    for (const size of [1, 55, 56, 57, 63, 64, 65, 1000, 4096]) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = rnd();

      expect(md5OfBytes(bytes), `size=${size}`).toBe(
        createHash('md5').update(bytes).digest('hex'),
      );
    }
  });

  it('对 buffer 视图求哈希只算视图那一段', () => {
    // 这条防的是"忘记切 byteOffset/byteLength"这类 bug
    const backing = new Uint8Array([0xff, 0xff, 0x61, 0x62, 0x63, 0xff]);
    const view = backing.subarray(2, 5); // "abc"

    expect(md5OfBytes(view)).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('md5OfBuffer 与 md5OfBytes 结果一致', () => {
    const bytes = new TextEncoder().encode('osu!');
    expect(md5OfBuffer(bytes.buffer as ArrayBuffer)).toBe(md5OfBytes(bytes));
  });
});

/* ---------------- 谱面哈希 == 回放头部(顺带解决 D10) ---------------- */

const FIXTURE_DIR = join(process.cwd(), 'fixtures');
const PAIRS = ['stable', 'stable-hdfl', 'lazer', 'lazer-moonlight'].filter(
  (n) =>
    existsSync(join(FIXTURE_DIR, `${n}.osu`)) && existsSync(join(FIXTURE_DIR, `${n}.osr`)),
);

function read(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe.skipIf(PAIRS.length === 0)('谱面 MD5 == .osr 头部的 beatmapHashMD5', () => {
  it.each(PAIRS)('%s', async (name) => {
    const osuMd5 = md5OfBuffer(read(join(FIXTURE_DIR, `${name}.osu`)));
    const replay = await loadReplay(read(join(FIXTURE_DIR, `${name}.osr`)));

    expect(osuMd5).toBe(replay.info.beatmapHashMD5);
  });
});

/* ---------------- .osz 解包 ---------------- */

const USER_DIR = join(FIXTURE_DIR, 'user');
const OSZ_FILES = (() => {
  try {
    return readdirSync(USER_DIR)
      .filter((n) => n.toLowerCase().endsWith('.osz'))
      .map((n) => join(USER_DIR, n));
  } catch {
    return [];
  }
})();

describe('unpackOsz —— 不是 zip 时给可读错误', () => {
  it('开头不是 PK 就直接拒绝', () => {
    const html = new TextEncoder().encode('<html><body>502 Bad Gateway</body></html>');
    expect(() => unpackOsz(html.buffer as ArrayBuffer)).toThrow(/不是有效的 \.osz|PK/);
  });

  it('空输入不崩', () => {
    expect(() => unpackOsz(new ArrayBuffer(0))).toThrow();
  });
});

describe.skipIf(OSZ_FILES.length === 0)('unpackOsz —— 真实 .osz', () => {
  for (const file of OSZ_FILES) {
    const label = file.split(/[\\/]/).pop()!;

    describe(label, () => {
      const contents = (): ReturnType<typeof unpackOsz> => unpackOsz(read(file));

      it('解出至少一个 .osu', () => {
        expect(contents().beatmaps.length).toBeGreaterThan(0);
      });

      it('每个 .osu 都算好了 MD5,且互不相同', () => {
        const c = contents();
        const md5s = c.beatmaps.map((b) => b.md5);

        for (const md5 of md5s) expect(md5).toMatch(/^[0-9a-f]{32}$/);
        expect(new Set(md5s).size, '同一包内出现了重复 MD5').toBe(md5s.length);
      });

      it('MD5 与 Node crypto 对同一条目一致', () => {
        const c = contents();
        for (const b of c.beatmaps) {
          expect(b.md5, b.name).toBe(createHash('md5').update(b.bytes).digest('hex'));
        }
      });

      it('能按 MD5 精确挑出难度', () => {
        const c = contents();
        for (const target of c.beatmaps) {
          expect(pickBeatmapByMd5(c, target.md5).name).toBe(target.name);
          // 大写也要认
          expect(pickBeatmapByMd5(c, target.md5.toUpperCase()).name).toBe(target.name);
        }
      });

      it('MD5 找不到时抛错并列出包内实际有哪些难度', () => {
        const c = contents();
        try {
          pickBeatmapByMd5(c, '0'.repeat(32));
          expect.unreachable('应该抛错');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 错误信息要能帮人诊断:含"更新过"的提示与实际难度列表
          expect(message).toContain('更新过');
          for (const b of c.beatmaps) expect(message).toContain(b.md5);
        }
      });

      it('能找到音频,且不会误取打击音效', () => {
        const c = contents();
        // 用第一个难度里写的音频名
        const audio = findAudio(c, 'audio.mp3');
        expect(audio, '没找到音频').not.toBeNull();
        expect(audio!.bytes.length).toBeGreaterThan(1000);
        expect(/^(normal|soft|drum)-/.test(audio!.name.toLowerCase())).toBe(false);
      });

      it('音频名大小写不敏感', () => {
        const c = contents();
        const lower = findAudio(c, 'audio.mp3');
        const upper = findAudio(c, 'AUDIO.MP3');
        expect(upper?.bytes.length).toBe(lower?.bytes.length);
      });
    });
  }
});

/* ---------------- 镜像站 provider(纯函数部分) ---------------- */

describe('OSU_DIRECT provider', () => {
  it('URL 拼接正确', () => {
    expect(OSU_DIRECT.lookupUrl('abc123')).toBe('https://osu.direct/api/v2/md5/abc123');
    expect(OSU_DIRECT.downloadUrl(2375111)).toBe('https://osu.direct/api/d/2375111');
  });

  it('解析真实响应形状(取自 2026-08-23 的实测)', () => {
    const real = {
      id: 5222620,
      beatmapset_id: 2375111,
      version: "killian & Tachi's Insane",
      status: 'ranked',
      count_circles: 426,
      count_sliders: 340,
      count_spinners: 0,
      beatmapset: { artist: 'Hikari no Naka ni', title: 'Moonlight' },
    };

    expect(OSU_DIRECT.parseLookup(real)).toEqual({
      beatmapId: 5222620,
      beatmapSetId: 2375111,
      version: "killian & Tachi's Insane",
      status: 'ranked',
      artist: 'Hikari no Naka ni',
      title: 'Moonlight',
    });
  });

  it('缺 beatmapset 子对象时 artist/title 为 null 而不是崩', () => {
    const parsed = OSU_DIRECT.parseLookup({ id: 1, beatmapset_id: 2, version: 'x', status: 'y' });
    expect(parsed?.artist).toBeNull();
    expect(parsed?.title).toBeNull();
  });

  it('形状不对时返回 null 而不是抛错', () => {
    expect(OSU_DIRECT.parseLookup(null)).toBeNull();
    expect(OSU_DIRECT.parseLookup('nope')).toBeNull();
    expect(OSU_DIRECT.parseLookup({})).toBeNull();
    // 少了 beatmapset_id
    expect(OSU_DIRECT.parseLookup({ id: 1 })).toBeNull();
  });
});
