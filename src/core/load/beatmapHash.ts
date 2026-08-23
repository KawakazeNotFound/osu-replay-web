import SparkMD5 from 'spark-md5';

/**
 * `.osu` 文件的 MD5。
 *
 * 两处用得到:
 * 1. 从 `.osz` 里按 `.osr` 头部记录的 `beatmapHashMD5` 挑出**正确的难度**
 * 2. 校验手动上传的谱面是否与回放匹配(TECH-NOTES D10)
 *
 * ⚠️ **为什么要引第三方库而不用 Web Crypto**:`crypto.subtle.digest` 只支持
 * SHA-1/256/384/512,**不支持 MD5**(MD5 已被认为不安全,规范刻意排除)。
 * 而 osu 的谱面标识就是 MD5,没得选。
 *
 * ✅ 已用 RFC 1321 的 7 个标准测试向量验证,并与 Node `crypto` 逐位比对一致;
 * 对四个真实 `.osu` 算出的哈希全部等于对应 `.osr` 头部的 `beatmapHashMD5`。
 * 见 `beatmapHash.test.ts`。
 */
export function md5OfBytes(bytes: Uint8Array): string {
  // spark-md5 要 ArrayBuffer;bytes 可能是某个大 buffer 的视图,必须切出来
  return SparkMD5.ArrayBuffer.hash(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

/** 便于直接对 `ArrayBuffer` 求哈希。 */
export function md5OfBuffer(buffer: ArrayBuffer): string {
  return SparkMD5.ArrayBuffer.hash(buffer);
}
