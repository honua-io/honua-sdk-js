import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sample = process.argv[2] ?? 'mcp-gis-assistant';
const root = resolve(process.cwd(), 'examples', sample);
const dist = join(root, 'dist');

function createStaticServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const local = join(dist, p || 'index.html');
    const file = p.endsWith('/') || p === '' ? join(dist, p, 'index.html') : local;
    const safe = resolve(file);
    if (!safe.startsWith(resolve(dist) + '\\')) {
      res.writeHead(400); return res.end('invalid');
    }
    try {
      const st = statSync(file);
      const target = st.isDirectory() ? join(file, 'index.html') : file;
      const bytes = readFileSync(target);
      const ext = target.split('.').pop().toLowerCase();
      const map = {html:'text/html',js:'application/javascript',css:'text/css',json:'application/json',mjs:'application/javascript',svg:'image/svg+xml',png:'image/png',webp:'image/webp'};
      res.writeHead(200, {'content-type': map[ext] || 'application/octet-stream'});
      res.end(bytes);
    } catch (err) {
      res.writeHead(404); res.end('missing ' + file);
    }
  });
}

const server = createStaticServer();
const failures=[];
const port = await new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const page = await chromium.launch({headless:true}).then((b)=>b.newPage());
const browser = page.context().browser();
const cpage = page;
cpage.on('console', m=>{ if(m.type()==='error') failures.push('console '+m.text());});
cpage.on('pageerror', e=>failures.push('pageerror '+e.message));
cpage.on('response', r=>{const u=r.url(); if(r.status()>=400 && u.includes(sample)) failures.push('resp '+r.status()+' '+u);});
await cpage.goto(`http://127.0.0.1:${port}/`, {waitUntil:'domcontentloaded'});
await cpage.waitForTimeout(5000);
await cpage.screenshot({path:`tmp-${sample}-app.png`, fullPage:true});
const body = await cpage.locator('body').innerText().catch(()=> 'no body');
console.log(JSON.stringify({sample, title: await cpage.title(), bodySnippet: body.slice(0,200), failures}, null, 2));
await browser.close();
server.close();
