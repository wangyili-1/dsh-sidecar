// Optional local-only UI fixture: node docs/tab-preview-server.mjs
// It serves two independent pages to check iframe state across tab moves.
import { createServer } from 'node:http';

const server = createServer((request, response) => {
  const page = ({ '/page-a': 'A', '/page-b': 'B' })[request.url];
  if (!page) { response.writeHead(404); response.end('Not found'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>页面 ${page}</title>
    <style>body{margin:0;padding:28px;background:#171719;color:#ddd;font:14px system-ui}small{color:#929298}h1{font-size:25px;font-weight:500}input,button{box-sizing:border-box;background:#29292c;color:#ddd;border:1px solid #48484d;border-radius:9px;padding:10px;font:inherit}input{width:100%;margin:16px 0}button{cursor:pointer}</style>
    <small>DSH SIDECAR · 标签验收页面</small><h1>独立网页 ${page}</h1>
    <p>切换、排序或分屏后，下面的文字和计数应保持不变。</p>
    <input aria-label="页面 ${page} 便签" placeholder="输入便签，检验页面状态是否保留">
    <button onclick="this.textContent='点击次数 '+(++window.clicks)">点击次数 0</button>
    <script>window.clicks=0</script></html>`);
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })));
