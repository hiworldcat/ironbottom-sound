/* =============================================================================
 *  DeepSeek 本地中转 —— 双 AI 对战模式专用
 *  -----------------------------------------------------------------------------
 *  为什么需要它：
 *    1. 密钥不能进仓库，也不能塞进网页里。它只存在于这个进程的环境变量。
 *    2. 走同一个源，省掉 CORS 的一堆麻烦，页面里只要请求 /api/ds 就行。
 *
 *  用法：
 *    Windows PowerShell:
 *      $env:DEEPSEEK_API_KEY = "sk-..."
 *      node tools/ds-bridge.mjs
 *    然后浏览器打开 http://127.0.0.1:8788/?mode=ds
 *
 *  可选环境变量：
 *    DEEPSEEK_MODEL   默认 deepseek-chat（换成你账号下可用的别的模型名）
 *    DS_PORT          默认 8788
 *    DEEPSEEK_BASE    默认 https://api.deepseek.com
 * ============================================================================= */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DS_PORT || 8788);
const BASE = (process.env.DEEPSEEK_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const KEY = process.env.DEEPSEEK_API_KEY || '';
const MOCK = /^(1|true|yes)$/i.test(process.env.DS_MOCK || '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* --------------------------------------------------------------- 静态文件 */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* --------------------------------------------------------------- 假模型 */
/**
 * DS_MOCK=1 时用它顶替真模型：照着简报做最朴素的事 —— 往最近的接触压上去，
 * 进射程就开火，日军驱逐舰在 7 公里内甩鱼雷。不花钱、不联网，
 * 用来验证整条链路（也方便你先看看这个模式长什么样）。
 */
function mockAdmiral(messages) {
  let brief = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = String(messages[i].content || '');
    const j = c.indexOf('{');
    if (j >= 0) { try { brief = JSON.parse(c.slice(j)); } catch (e) { brief = null; } }
    if (brief) break;
  }
  if (!brief || !brief.ships) return '{"think":"看不到态势，保持航向","ships":{}}';

  const tracks = (brief.tracks || []).slice().sort((a, b) => a.rng_km - b.rng_km);
  const near = tracks[0];
  const ships = {};
  for (const s of brief.ships) {
    const o = {};
    if (near) {
      o.hdg = Math.round(near.brg);
      o.spd = 26;
      if (near.rng_km < 13) { o.engage = true; o.target = near.id; }
      if (near.rng_km < 7 && s.torps > 0) o.torp = near.id;
    } else {
      o.hdg = Math.round(s.hdg || 0);
      o.spd = 18;
    }
    ships[s.id] = o;
  }
  const think = near
    ? '最近接触 ' + near.id + ' 在 ' + near.brg + '° ' + near.rng_km + ' km，全队压上去'
    : '没有接触，保持搜索航向';
  return JSON.stringify({ think: think, ships: ships });
}

/* ------------------------------------------------------------------- 转发 */
async function proxy(req, res) {
  if (MOCK) {
    let payload = {};
    try { payload = JSON.parse(await readBody(req)); } catch (e) { /* 忽略 */ }
    const text = mockAdmiral(payload.messages || []);
    json(res, 200, { ok: true, text: text, model: 'mock-admiral', usage: { total_tokens: 0 }, ms: 40 });
    return;
  }
  if (!KEY) {
    json(res, 500, {
      ok: false,
      error: '没有设置 DEEPSEEK_API_KEY。先设环境变量再启动：$env:DEEPSEEK_API_KEY="sk-..."'
    });
    return;
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    return;
  }

  const body = {
    model: payload.model || MODEL,
    messages: payload.messages || [],
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.5,
    max_tokens: payload.max_tokens || 700,
    stream: false
  };
  if (payload.json) body.response_format = { type: 'json_object' };

  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90000);
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + KEY
      },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!r.ok) {
      json(res, 502, {
        ok: false,
        status: r.status,
        error: (data && data.error && data.error.message) || text.slice(0, 400)
      });
      return;
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    json(res, 200, {
      ok: true,
      text: (msg && msg.content) || '',
      model: (data && data.model) || body.model,
      usage: (data && data.usage) || null,
      ms: Date.now() - t0
    });
  } catch (e) {
    json(res, 504, { ok: false, error: '调用超时或网络不通：' + (e && e.message ? e.message : e) });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- 服务 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/api/health') {
    json(res, 200, {
      ok: true, hasKey: !!KEY || MOCK, model: MOCK ? 'mock-admiral' : MODEL,
      base: MOCK ? '(本地假模型)' : BASE, mock: MOCK
    });
    return;
  }
  if (p === '/api/ds' && req.method === 'POST') {
    proxy(req, res).catch((e) => json(res, 500, { ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, p);
    return;
  }
  res.writeHead(405);
  res.end('method not allowed');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('双 AI 对战：http://127.0.0.1:' + PORT + '/?mode=ds');
  if (MOCK) console.log('模型 本地假模型（DS_MOCK=1，不联网、不花钱）');
  else console.log('模型 ' + MODEL + ' · 密钥 ' + (KEY ? '已设置' : '**缺失**（设 $env:DEEPSEEK_API_KEY 再重启）'));
});
