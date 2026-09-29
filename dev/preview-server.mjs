// 本地静态预览：服务发布产物目录（默认 dist/），与线上 Pages 站点等价。
// 产物由 `node tools/publish-data.mjs --out dist` 生成，本进程不再兼任 API。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 5173);
const root = `${resolve(process.cwd(), process.argv[3] ?? 'dist')}/`;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', // 本地 dev 工具仍为 .mjs；前端已改经典脚本，不依赖模块 MIME
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    const file = normalize(join(root, pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store', // 预览必须看到刚生成的数据，别让浏览器缓存 JSON
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`showHub preview (${root}): http://127.0.0.1:${port}`);
});
