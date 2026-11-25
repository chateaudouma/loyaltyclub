// Local preview: serves the site and the API with an in-memory store (data is lost when stopped).
// Usage: node dev-server.mjs   then open http://localhost:8888/join and /staff (owner PIN 999999, staff PIN 1234)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handle } from './core.mjs';
import { memStore } from './memstore.mjs';

const store = memStore();
const env = { OWNER_PIN: process.env.OWNER_PIN || '999999', STAFF_PIN: process.env.STAFF_PIN || '1234' };
const routes = { '/': '/join.html', '/join': '/join.html', '/card': '/card.html', '/staff': '/staff.html' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const root = path.resolve('.');
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await handle(new Request(u, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), store, { ...env, __now: process.env.NOW });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = routes[u.pathname] || (u.pathname.startsWith('/m/') ? '/m.html' : u.pathname);
  const ext = path.extname(p);
  const file = path.join(root, p);
  if (!types[ext] || !file.startsWith(root) || p.includes('/node_modules') || !fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': types[ext] }); fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 8888, () => console.log('Preview on http://localhost:' + (process.env.PORT || 8888)));
