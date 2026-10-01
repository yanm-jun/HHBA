// HHBA 网关:静态文件 + API 反向代理.
// /health /api/* /internal/* -> 后端 127.0.0.1:8787, 其余 -> 仓库根目录静态文件.
// 本地: npm run ui (127.0.0.1:4173,前端直连 8787,走 CORS)
// ECS: HHBA_WEB_HOST=0.0.0.0 HHBA_WEB_PORT=8080 (前端同源经代理,不触发 CORS)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.HHBA_API_PORT || 8787);
const WEB_PORT = Number(process.env.HHBA_WEB_PORT || 4173);
const WEB_HOST = process.env.HHBA_WEB_HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

http.createServer((request, response) => {
  const urlPath = new URL(request.url, 'http://localhost').pathname;
  // API 代理(ECS 同源部署用;本地 4173 下前端直连 8787,代理闲置)
  if (urlPath === '/health' || urlPath.startsWith('/api/') || urlPath.startsWith('/internal/')) {
    const proxy = http.request(
      { host: '127.0.0.1', port: API_PORT, path: request.url, method: request.method, headers: request.headers },
      (pres) => { response.writeHead(pres.statusCode, pres.headers); pres.pipe(response); }
    );
    proxy.on('error', () => { response.writeHead(502); response.end('bad gateway'); });
    request.pipe(proxy);
    return;
  }
  const file = path.resolve(root, '.' + (urlPath === '/' ? '/index.html' : urlPath));
  if (!file.startsWith(root)) { response.writeHead(403); return response.end(); }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404); return response.end('Not found'); }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store, max-age=0, must-revalidate', 'Pragma': 'no-cache' });
    response.end(data);
  });
}).listen(WEB_PORT, WEB_HOST, () => console.log(`HHBA UI listening at http://${WEB_HOST}:${WEB_PORT}`));
