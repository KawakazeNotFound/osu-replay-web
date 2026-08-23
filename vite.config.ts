import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * 开发期的验证结果回传通道。
 *
 * 起因:浏览器专属的东西(CORS、`decodeAudioData`、canvas 像素)只能在真实
 * 浏览器里验,而 headless Chrome 的 `--dump-dom` 是**一次性快照** ——
 * 虚拟时钟不等真实网络与音频解码,页面常常在跑完之前就被 dump 了。
 *
 * 于是给页面一条出口:`POST /__verify/<name>` 把结果写到
 * `.verify-out/<name>.txt`,外部脚本轮询那个文件即可。
 *
 * ⚠️ **仅 dev**(`apply: 'serve'`),不进生产构建。
 */
function verifySink(): Plugin {
  const outDir = resolve(root, '.verify-out');

  return {
    name: 'verify-sink',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/__verify/') || req.method !== 'POST') return next();

        // 只允许简单的文件名,避免路径穿越
        const name = req.url.slice('/__verify/'.length).replace(/[^A-Za-z0-9._-]/g, '');
        if (!name) {
          res.statusCode = 400;
          res.end('bad name');
          return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);

        const target = join(outDir, `${name}.txt`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat(chunks));

        res.statusCode = 204;
        res.end();
      });
    },
  };
}

export default defineConfig({
  plugins: [verifySink()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
});
