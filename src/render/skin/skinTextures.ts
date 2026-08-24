import { resolveInLayers, type SkinLayer } from './skinStack';

/**
 * # 贴图的解码与缓存
 *
 * ## 这一层为什么必须"先装好再画"
 *
 * `draw()` 是**同步**的(每帧调用),而解码是**异步**的
 * (`createImageBitmap` 返回 Promise)。最省事的写法是"画的时候发现没解码就先画
 * 线框,解码完下一帧自然换成贴图"—— 但那会**破坏本项目唯一的核心不变式**:
 *
 * > 同一时刻的绘制调用序列必须逐项相同(正放到达 == 直接 seek 到达)
 *
 * 因为第一次画到 t 时贴图还没好(画线框),再 seek 回 t 时贴图好了(画贴图),
 * 同一个 t 出来两种结果。`DebugRenderer.test.ts` 里那条"🔒 核心约束"会直接红,
 * 而且真实表现是"拖动进度条时画面会闪变"。
 *
 * 所以纪律是:**贴图在开始渲染之前一次性装好,之后这份表不再变化。**
 * 装好之后它是**不可变**的,于是持有它不违反"渲染层不得持有跨帧状态"——
 * 判据是幂等性,不是"有没有字段"(与 `DebugRenderer.palette` 同一条理由)。
 *
 * ## 预装的名单是显式的
 *
 * 不做"按需懒加载",而是给一份明确的组件名单({@link OSU_STD_COMPONENTS})。
 * 好处是这份名单本身就是文档:渲染器到底会用到哪些贴图,一眼能看完;
 * 而懒加载会让"哪些贴图参与渲染"散落在各个绘制函数里。
 *
 * ## 解码是注入的
 *
 * `createImageBitmap` 是浏览器 API。注入之后这一层在 Node 下可测 ——
 * 与 `skinIni.ts` / `skinFiles.ts` 保持同样的纪律。
 */

/** 一张已解码的皮肤贴图。 */
export interface SkinSprite {
  /** 可直接喂给 `ctx.drawImage` */
  readonly image: CanvasImageSource;
  /** 贴图的**像素**宽高。注意这是原始像素,不是判定区尺寸 */
  readonly width: number;
  readonly height: number;
  /**
   * 缩放分母:`2` = @2x(HD)。对应 lazer 的 `Texture.ScaleAdjust`。
   *
   * **绘制时必须把像素尺寸除以它** —— 默认皮肤整体是 @2x,搞错的话一切大一倍。
   */
  readonly scale: 1 | 2;
  /** 来自皮肤栈的哪一层。仅调试与测试用 */
  readonly layer: string;
}

/** 解码器:字节 + MIME → 可绘制对象。浏览器里就是 `createImageBitmap`。 */
export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<CanvasImageSource & {
  readonly width: number;
  readonly height: number;
}>;

/**
 * 装好的贴图表 —— **不可变**。
 *
 * `get()` 是同步的,这正是让 `draw()` 保持同步的关键。
 */
export interface SkinSprites {
  /** 没有这个组件时返回 `null`,调用方应降级成自绘线框 */
  get(componentName: string): SkinSprite | null;
  /** 已装好的组件数,供 UI 显示与测试断言 */
  readonly size: number;
  /** 装载时逐个失败的组件(解码失败等),供 UI 提示 */
  readonly failed: readonly string[];
}

/** 空表 —— 没有任何皮肤时用它,一切走自绘。 */
export const NO_SPRITES: SkinSprites = {
  get: () => null,
  size: 0,
  failed: [],
};

/**
 * 渲染器会用到的组件名单。
 *
 * ⚠️ 这里**只列 osu!std 会画的东西**。名单之外的组件不会被装载,
 * 所以加新的绘制代码时要记得把名字加进来 —— 否则 `get()` 永远返回 `null`,
 * 表现为"那个部件一直是线框",而且不会报错。
 *
 * 数字字体不在这里:它的前缀由 `skin.ini` 的 `HitCirclePrefix` / `ScorePrefix`
 * 决定,是**运行期才知道**的,所以由 {@link fontComponents} 按前缀展开。
 */
export const OSU_STD_COMPONENTS: readonly string[] = [
  // 圈
  'hitcircle',
  'hitcircleoverlay',
  'approachcircle',
  // 滑条
  'sliderstartcircle',
  'sliderstartcircleoverlay',
  'sliderendcircle',
  'sliderendcircleoverlay',
  'sliderfollowcircle',
  'sliderscorepoint',
  'reversearrow',
  // 光标
  'cursor',
  'cursormiddle',
  'cursortrail',
];

/** 某个数字字体的 10 个字形组件名。 */
export function fontComponents(prefix: string): string[] {
  return Array.from({ length: 10 }, (_, d) => `${prefix}-${d}`);
}

/**
 * 装载并解码一批组件。
 *
 * **逐个组件独立 try/catch**:一张坏图不能让整个皮肤装不上 ——
 * 那样用户换个皮肤就可能整屏白。坏掉的那个记进 {@link SkinSprites.failed},
 * 绘制时它自然退回线框。
 *
 * @param layers 皮肤栈,前面的层优先(见 `skinStack.ts`)
 * @param componentNames 要装的组件名。重复项会被去重
 */
export async function loadSkinSprites(
  layers: readonly SkinLayer[],
  componentNames: readonly string[],
  decode: ImageDecoder,
): Promise<SkinSprites> {
  const sprites = new Map<string, SkinSprite>();
  const failed: string[] = [];

  // 去重:调用方可能把 hitcircle 既列在通用名单里、又按前缀展开一次
  const wanted = [...new Set(componentNames)];

  // 并发解码。不做并发上限 —— 名单是几十个量级,而且 createImageBitmap
  // 本身在浏览器里是走独立线程的,排队反而更慢
  await Promise.all(
    wanted.map(async (name) => {
      const found = resolveInLayers(layers, name);
      if (found === null) return; // 皮肤没提供 —— 正常情况,不算失败

      try {
        const bytes = await found.layer.load(found.path);
        const image = await decode(bytes, mimeOf(found.path));

        sprites.set(name, {
          image,
          width: image.width,
          height: image.height,
          scale: found.scale,
          layer: found.layer.name,
        });
      } catch {
        // 取字节失败(网络)或解码失败(坏图)。两者都降级成"没有这个贴图"
        failed.push(name);
      }
    }),
  );

  return {
    get: (name) => sprites.get(name) ?? null,
    size: sprites.size,
    failed,
  };
}

/** 按扩展名给 MIME。`resolveTexture` 只会给出这两种。 */
function mimeOf(path: string): string {
  return path.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
}

/**
 * 浏览器的解码器。
 *
 * 单独抽出来是为了让 `loadSkinSprites` 本身不引用任何浏览器 API ——
 * 那样它在 Node 下可测。
 */
export const browserDecoder: ImageDecoder = async (bytes, mime) => {
  // fflate 给出的永远是普通 ArrayBuffer 支撑的视图,不会是 SharedArrayBuffer
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  return createImageBitmap(blob);
};
