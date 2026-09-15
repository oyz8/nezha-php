/**
 * CF Keepalive Worker
 *  - 定时访问 URL 列表（cron 触发）
 *  - 自动处理 byethost 的 aes.js 挑战（key=a, iv=b, AES-128-CBC，无 padding）
 *  - 前端 UI 管理 URL（需要密码）
 *  - /add-url 公开接口
 */

import { createDecipheriv } from 'node:crypto';

// ============================================================
// 常量
// ============================================================
const UA = "Mozilla/5.0 (compatible; Let's Encrypt validation server; +https://www.letsencrypt.org)";

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

const LOG_KEEP = 500;

// ============================================================
// 工具
// ============================================================
function nowSec() { return Math.floor(Date.now() / 1000); }
function nowMs()  { return Date.now(); }

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token',
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// ============================================================
// 认证
// ============================================================
function checkAuth(request, env) {
  const expected = env.ADMIN_PASSWORD;
  if (!expected) return true;
  const token = request.headers.get('X-Auth-Token');
  return token === expected;
}

// ============================================================
// aes.js 挑战处理
// ============================================================
function isChallenge(body) {
  return typeof body === 'string' &&
    (body.includes('aes.js') || body.includes('slowAES'));
}

function parseChallenge(body) {
  const m = body.match(
    /a\s*=\s*toNumbers\("([0-9a-f]+)"\)\s*,\s*b\s*=\s*toNumbers\("([0-9a-f]+)"\)\s*,\s*c\s*=\s*toNumbers\("([0-9a-f]+)"\)/
  );
  if (!m) return null;
  const cookieName = (body.match(/document\.cookie\s*=\s*"([^=]+)=/) || [, '__test'])[1];
  return { aHex: m[1], bHex: m[2], cHex: m[3], cookieName };
}

function solveChallenge(ch) {
  const decipher = createDecipheriv(
    'aes-128-cbc',
    Buffer.from(ch.aHex, 'hex'),
    Buffer.from(ch.bHex, 'hex')
  );
  decipher.setAutoPadding(false);
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ch.cHex, 'hex')),
    decipher.final(),
  ]);
  return pt.toString('hex');
}

function withI1(url) {
  return url + (url.includes('?') ? '&' : '?') + 'i=1';
}

async function fetchWithChallenge(url) {
  let r1;
  try {
    r1 = await fetch(url, { headers: BASE_HEADERS, redirect: 'manual' });
  } catch (e) {
    return { status: 0, ok: false, body: '', challenged: false, error: e.message };
  }

  const body1 = await r1.text();

  if (!isChallenge(body1)) {
    return {
      status: r1.status,
      ok: r1.status >= 200 && r1.status < 400,
      body: body1,
      challenged: false,
    };
  }

  const ch = parseChallenge(body1);
  if (!ch) {
    return {
      status: r1.status, ok: false, body: body1.slice(0, 300),
      challenged: true, error: 'challenge parse failed',
    };
  }

  let cookieValue;
  try {
    cookieValue = solveChallenge(ch);
  } catch (e) {
    return {
      status: r1.status, ok: false, body: body1.slice(0, 300),
      challenged: true, error: 'challenge solve failed: ' + e.message,
    };
  }

  const step2Url = withI1(url);
  let r2;
  try {
    r2 = await fetch(step2Url, {
      headers: {
        ...BASE_HEADERS,
        'Referer': url,
        'Cookie': `${ch.cookieName}=${cookieValue}`,
      },
      redirect: 'manual',
    });
  } catch (e) {
    return {
      status: 0, ok: false, body: '', challenged: true,
      error: 'step2 fetch failed: ' + e.message,
    };
  }

  const body2 = await r2.text();
  const still = isChallenge(body2);

  return {
    status: r2.status,
    ok: r2.status >= 200 && r2.status < 400 && !still,
    body: body2.slice(0, 400),
    challenged: true,
    stillChallenged: still,
  };
}

// ============================================================
// 数据库初始化
// ============================================================
let dbInitPromise = null;

function ensureDB(db) {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await db.batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS urls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL UNIQUE,
          interval_sec INTEGER DEFAULT 300,
          fail_count INTEGER DEFAULT 0,
          disabled INTEGER DEFAULT 0,
          last_visit INTEGER DEFAULT 0,
          last_success INTEGER DEFAULT 0,
          last_status INTEGER DEFAULT 0,
          last_error TEXT DEFAULT '',
          created_at INTEGER NOT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_urls_disabled ON urls(disabled)`),
        db.prepare(`CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL
        )`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC)`),
      ]);
    })().catch(err => {
      dbInitPromise = null;
      throw err;
    });
  }
  return dbInitPromise;
}

// ============================================================
// 数据库操作
// ============================================================
async function addLog(db, level, message) {
  try {
    await db.prepare(
      `INSERT INTO logs (ts, level, message) VALUES (?, ?, ?)`
    ).bind(nowSec(), level, message.slice(0, 500)).run();
  } catch (e) {
    console.error('addLog failed:', e.message);
  }
}

async function pruneLogs(db) {
  try {
    await db.prepare(
      `DELETE FROM logs WHERE id NOT IN (
         SELECT id FROM logs ORDER BY id DESC LIMIT ?
       )`
    ).bind(LOG_KEEP).run();
  } catch (e) {}
}

async function listUrls(db) {
  const r = await db.prepare(`SELECT * FROM urls ORDER BY id DESC`).all();
  return r.results || [];
}

async function addUrl(db, url, intervalSec = 300) {
  const clean = url.trim();
  await db.prepare(
    `INSERT OR IGNORE INTO urls (url, interval_sec, created_at) VALUES (?, ?, ?)`
  ).bind(clean, intervalSec, nowSec()).run();
}

async function deleteUrl(db, id) {
  await db.prepare(`DELETE FROM urls WHERE id = ?`).bind(id).run();
}

async function clearLogs(db) {
  await db.prepare(`DELETE FROM logs`).run();
}

async function recordResult(db, id, result) {
  const ok = result.ok;
  if (ok) {
    await db.prepare(
      `UPDATE urls SET fail_count=0, last_visit=?, last_success=?, last_status=?, last_error='' WHERE id=?`
    ).bind(nowMs(), nowSec(), result.status, id).run();
  } else {
    const row = await db.prepare(`SELECT fail_count FROM urls WHERE id=?`).bind(id).first();
    const fails = (row?.fail_count || 0) + 1;
    const willDisable = fails >= 5 ? 1 : 0;
    await db.prepare(
      `UPDATE urls SET fail_count=?, disabled=?, last_visit=?, last_status=?, last_error=? WHERE id=?`
    ).bind(
      fails, willDisable, nowMs(), result.status || 0,
      (result.error || '').slice(0, 200), id
    ).run();
  }
}

// ============================================================
// 检查逻辑
// ============================================================
function shouldSkip(record) {
  const now = nowMs();
  return now - (record.last_visit || 0) < (record.interval_sec || 300) * 1000;
}

async function checkOne(db, record, force = false) {
  if (!force && shouldSkip(record)) return { skipped: true };

  const r = await fetchWithChallenge(record.url);
  await recordResult(db, record.id, r);

  const level = r.ok ? 'INFO' : (r.status ? 'WARN' : 'ERROR');
  let msg = `${r.ok ? 'OK' : 'FAIL'} ${record.url} [${r.status || 'ERR'}]`;
  if (r.challenged) msg += ' (challenge)';
  if (r.error) msg += ` ${r.error}`;

  await addLog(db, level, msg);
  return r;
}

async function checkAll(db, force = false) {
  const urls = await listUrls(db);
  const results = [];
  for (const u of urls) {
    if (u.disabled && !force) {
      results.push({ id: u.id, url: u.url, skipped: true, reason: 'disabled' });
      continue;
    }
    try {
      const r = await checkOne(db, u, force);
      results.push({ id: u.id, url: u.url, ...r });
    } catch (e) {
      results.push({ id: u.id, url: u.url, error: e.message });
    }
  }
  await pruneLogs(db);
  return results;
}

// ============================================================
// URL 校验
// ============================================================
function validateUrl(u) {
  if (!u || typeof u !== 'string') return false;
  let url;
  try { url = new URL(u.trim()); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  const blocked = [
    'localhost', '127.', '0.0.0.0',
    '10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.',
    '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', '169.254.', '.local', '.internal'
  ];
  for (const p of blocked) {
    if (host === p || host.startsWith(p) || host.endsWith(p)) return false;
  }
  return true;
}

// ============================================================
// API 路由
// ============================================================
async function handleAPI(request, env, path) {
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const isPublic = (path === '/add-url' && method === 'POST');
  if (!isPublic && !checkAuth(request, env)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const db = env.DB;
  await ensureDB(db);

  if (method === 'GET' && path === '/state') {
    const urls = await listUrls(db);
    const logs = await db.prepare(
      `SELECT ts, level, message FROM logs ORDER BY id DESC LIMIT 100`
    ).all();
    return jsonResponse({ urls, logs: logs.results || [] });
  }

  if (method === 'POST' && path === '/add') {
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }
    if (!validateUrl(body.url)) return jsonResponse({ error: '无效的 URL' }, 400);
    const interval = Math.max(60, parseInt(body.interval) || 300);
    await addUrl(db, body.url, interval);
    await addLog(db, 'INFO', `ADD ${body.url.trim()}`);
    return jsonResponse({ success: true });
  }

  if (method === 'POST' && path === '/delete') {
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }
    if (!body.id) return jsonResponse({ error: '缺少 id' }, 400);
    const row = await db.prepare(`SELECT url FROM urls WHERE id=?`).bind(body.id).first();
    await deleteUrl(db, body.id);
    if (row) await addLog(db, 'INFO', `DELETE ${row.url}`);
    return jsonResponse({ success: true });
  }

  if (method === 'POST' && path === '/check') {
    const results = await checkAll(db, true);
    return jsonResponse({ success: true, results });
  }

  if (method === 'POST' && path === '/check-one') {
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }
    const row = await db.prepare(`SELECT * FROM urls WHERE id=?`).bind(body.id).first();
    if (!row) return jsonResponse({ error: 'not found' }, 404);
    const r = await checkOne(db, row, true);
    return jsonResponse({ success: true, result: r });
  }

  if (method === 'DELETE' && path === '/logs') {
    await clearLogs(db);
    return jsonResponse({ success: true });
  }

  if (method === 'POST' && path === '/add-url') {
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }
    if (!validateUrl(body.url)) return jsonResponse({ error: '无效的 URL' }, 400);
    const interval = Math.max(60, parseInt(body.interval) || 300);
    await addUrl(db, body.url, interval);
    await addLog(db, 'INFO', `ADD (public) ${body.url.trim()}`);
    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'not found' }, 404);
}

// ============================================================
// 前端 HTML
// ============================================================
function createAppHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>URL 保活监控</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<script>
  (function() {
    var savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  })();
</script>
<style>
:root, :root[data-theme="light"] {
  color-scheme: light;
  --bg-gradient: radial-gradient(circle at top left, rgba(15,118,110,.07), transparent 40%),
                 radial-gradient(circle at right 20%, rgba(2,132,199,.05), transparent 35%),
                 linear-gradient(180deg, #f8fafc 0%, #eef2f6 100%);
  --panel: rgba(255,255,255,.85);
  --panel-border: rgba(15,23,42,.06);
  --text: #0f172a;
  --text-muted: #475569;
  --primary: #0f766e;
  --primary-hover: #0d9488;
  --primary-strong: #115e59;
  --primary-glow: rgba(15,118,110,.15);
  --danger: #b91c1c;
  --danger-hover: #dc2626;
  --danger-glow: rgba(185,28,28,.15);
  --success: #059669;
  --warn: #d97706;
  --shadow: 0 20px 50px rgba(15,23,42,.05);
  --card-shadow: 0 4px 20px rgba(15,23,42,.03);
  --input-bg: #ffffff;
  --input-border: #cbd5e1;
  --btn-ghost-bg: #e2e8f0;
  --btn-ghost-hover: #cbd5e1;
  --table-header-bg: #f8fafc;
  --table-border: #e2e8f0;
  --table-row-hover: #f1f5f9;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg-gradient: radial-gradient(circle at top left, rgba(20,184,166,.1), transparent 45%),
                 radial-gradient(circle at right 20%, rgba(14,165,233,.06), transparent 40%),
                 linear-gradient(180deg, #0b0f19 0%, #030712 100%);
  --panel: rgba(17,24,39,.7);
  --panel-border: rgba(255,255,255,.06);
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --primary: #14b8a6;
  --primary-hover: #2dd4bf;
  --primary-strong: #99f6e4;
  --primary-glow: rgba(20,184,166,.25);
  --danger: #ef4444;
  --danger-hover: #f87171;
  --danger-glow: rgba(239,68,68,.25);
  --success: #34d399;
  --warn: #fbbf24;
  --shadow: 0 20px 50px rgba(0,0,0,.3);
  --card-shadow: 0 4px 20px rgba(0,0,0,.2);
  --input-bg: #1e293b;
  --input-border: #334155;
  --btn-ghost-bg: #334155;
  --btn-ghost-hover: #475569;
  --table-header-bg: #1e293b;
  --table-border: #334155;
  --table-row-hover: #1e293b;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  min-height: 100vh;
  font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
  color: var(--text);
  background: var(--bg-gradient);
  -webkit-font-smoothing: antialiased;
  transition: background .3s, color .3s;
}
.shell { width: min(1200px, calc(100vw - 32px)); margin: 0 auto; padding: 24px 0 40px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.brand { display: flex; align-items: center; gap: 8px; }
.brand .logo { color: var(--primary); }
.eyebrow {
  display: inline-flex; align-items: center;
  padding: 6px 12px; border-radius: 999px;
  font-family: 'Outfit', sans-serif;
  font-size: 11px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase;
  color: var(--primary-strong);
  background: var(--primary-glow);
  border: 1px solid var(--panel-border);
}
.theme-toggle {
  width: 40px; height: 40px; border-radius: 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel); color: var(--text);
  cursor: pointer; box-shadow: var(--card-shadow);
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; outline: none; transition: all .2s;
}
.theme-toggle:hover { background: var(--table-row-hover); transform: translateY(-2px); }
.theme-toggle svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: transform .5s, opacity .2s; }
:root[data-theme="dark"] .sun-icon { opacity: 1; transform: rotate(0) scale(1); }
:root[data-theme="dark"] .moon-icon { opacity: 0; transform: rotate(90deg) scale(0); position: absolute; }
:root[data-theme="light"] .sun-icon { opacity: 0; transform: rotate(-90deg) scale(0); position: absolute; }
:root[data-theme="light"] .moon-icon { opacity: 1; transform: rotate(0) scale(1); }

/* ── GitHub 角标 ── */
.github-corner {
  position: fixed; top: 0; right: 0;
  z-index: 1100;                 /* ★ 高于登录遮罩(1000)，登录页也可见 */
  line-height: 0; display: block;
}
.github-corner svg { width: 80px; height: 80px; border: 0; display: block; }
.github-corner .gh-bg {
  fill: var(--primary);
  transition: fill .3s;
}
.github-corner .gh-arm,
.github-corner .gh-body {
  fill: #fff;
  transition: fill .3s;
}
.github-corner:hover .gh-bg { fill: var(--primary-hover); }
.github-corner:active .gh-bg { fill: var(--primary-strong); }
.github-corner:hover .gh-arm { animation: octocat-wave 560ms ease-in-out; }
@keyframes octocat-wave {
  0%, 100% { transform: rotate(0); }
  20%, 60% { transform: rotate(-25deg); }
  40%, 80% { transform: rotate(10deg); }
}
@media (max-width: 640px) {
  .github-corner svg { width: 62px; height: 62px; }
  .github-corner:hover .gh-arm { animation: none; }
  .github-corner .gh-arm { animation: octocat-wave 560ms ease-in-out; }
}
/* 窄视口下给 header 右侧留出角标空间 */
@media (max-width: 1180px) {
  .header { padding-right: 70px; }
}

.hero {
  display: grid; gap: 12px; margin-bottom: 20px;
  padding: 28px; border: 1px solid var(--panel-border);
  border-radius: 24px; background: var(--panel);
  box-shadow: var(--shadow); backdrop-filter: blur(16px);
}
h1 { font-family: 'Outfit', sans-serif; font-weight: 800; font-size: clamp(24px, 3.5vw, 38px); line-height: 1.15; letter-spacing: -.03em; }
.lead { color: var(--text-muted); font-size: 15px; line-height: 1.6; }

.card {
  padding: 24px; margin-bottom: 18px;
  border: 1px solid var(--panel-border); border-radius: 20px;
  background: var(--panel); box-shadow: var(--card-shadow);
  backdrop-filter: blur(16px);
}
.card h2 { font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 18px; margin-bottom: 16px; letter-spacing: -.01em; }

.row { display: flex; gap: 8px; align-items: center; }
input[type="text"], input[type="number"], input[type="password"] {
  flex: 1; padding: 12px 14px;
  border: 1px solid var(--input-border); border-radius: 12px;
  font-family: inherit; font-size: 14px;
  background: var(--input-bg); color: var(--text);
  outline: none; transition: all .2s;
}
input:focus { border-color: var(--primary); box-shadow: 0 0 0 4px var(--primary-glow); }
input::placeholder { color: var(--text-muted); opacity: .6; }

button {
  appearance: none; border: 0; border-radius: 12px;
  padding: 12px 20px; font-family: 'Outfit', sans-serif;
  font-weight: 700; font-size: 14px; cursor: pointer;
  transition: all .2s;
}
button:hover { transform: translateY(-1.5px); }
button:active { transform: scale(.97); }
button:disabled { cursor: not-allowed; transform: none !important; opacity: .5; }
.btn-primary { color: #fff; background: linear-gradient(135deg, var(--primary), #0891b2); box-shadow: 0 4px 14px var(--primary-glow); }
.btn-primary:hover { background: linear-gradient(135deg, var(--primary-hover), #0e7490); }
.btn-ghost { color: var(--text); background: var(--btn-ghost-bg); }
.btn-ghost:hover { background: var(--btn-ghost-hover); }
.btn-danger { color: #fff; background: linear-gradient(135deg, var(--danger), #dc2626); box-shadow: 0 4px 14px var(--danger-glow); }
.btn-xs { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

/* 登录遮罩 */
.login-overlay {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-gradient); padding: 24px;
}
.login-overlay.hidden { display: none; }
.login-box {
  width: 100%; max-width: 400px;
  padding: 36px 32px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 24px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(16px);
}
.login-box h2 {
  font-family: 'Outfit', sans-serif;
  font-size: 22px; font-weight: 800;
  margin-bottom: 6px; letter-spacing: -.02em;
}
.login-box p {
  color: var(--text-muted); font-size: 13px;
  margin-bottom: 24px; line-height: 1.6;
}
.login-box .field { margin-bottom: 14px; }
.login-box .field input { width: 100%; flex: none; }
.login-box .err {
  display: none; padding: 10px 14px; border-radius: 10px;
  background: rgba(185,28,28,.1); border: 1px solid rgba(185,28,28,.2);
  color: var(--danger); font-size: 13px; margin-bottom: 14px;
}
.login-box .err.show { display: block; }

.table-wrap {
  overflow: auto;
  border: 1px solid var(--panel-border); border-radius: 16px;
  background: var(--input-bg);
}
table { width: 100%; border-collapse: collapse; min-width: 900px; }
thead { background: var(--table-header-bg); position: sticky; top: 0; z-index: 1; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--table-border); text-align: left; vertical-align: middle; font-size: 13px; }
th {
  font-family: 'Outfit', sans-serif; font-size: 12px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
}
tbody tr { transition: background .2s; }
tbody tr:hover { background: var(--table-row-hover); }
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; word-break: break-all; }
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 8px;
  font-size: 11.5px; font-weight: 600; line-height: 1; border: 1px solid transparent;
}
.badge-ok { background: rgba(16,185,129,.1); color: #059669; border-color: rgba(16,185,129,.15); }
:root[data-theme="dark"] .badge-ok { background: rgba(16,185,129,.15); color: #34d399; }
.badge-fail { background: rgba(239,68,68,.1); color: #dc2626; border-color: rgba(239,68,68,.15); }
:root[data-theme="dark"] .badge-fail { background: rgba(239,68,68,.15); color: #fca5a5; }
.badge-idle { background: rgba(100,116,139,.1); color: #475569; border-color: rgba(100,116,139,.15); }
:root[data-theme="dark"] .badge-idle { background: rgba(148,163,184,.15); color: #cbd5e1; }
.badge-disabled { background: rgba(217,119,6,.1); color: #b45309; border-color: rgba(217,119,6,.15); }
:root[data-theme="dark"] .badge-disabled { background: rgba(251,191,36,.15); color: #fbbf24; }

.log {
  max-height: 360px; overflow: auto;
  padding: 16px; border-radius: 16px;
  background: #0f172a; color: #e2e8f0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px; line-height: 1.6; white-space: pre-wrap;
  border: 1px solid rgba(255,255,255,.05);
}
.log-item { display: block; }
.log-item.ok { color: #4ade80; }
.log-item.warn { color: #facc15; }
.log-item.error { color: #f87171; }

.empty { padding: 24px; text-align: center; color: var(--text-muted); }
.site-footer { text-align: center; font-size: 12px; color: var(--text-muted); padding-top: 22px; line-height: 1.8; }
.flex-between { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; gap: 8px; flex-wrap: wrap; }
</style>
</head>
<body>

<!-- ══════════════ GitHub 角标 ══════════════ -->
<a href="https://github.com/oyz8" target="_blank" rel="noopener"
   class="github-corner" aria-label="View source on GitHub">
  <svg viewBox="0 0 250 250" aria-hidden="true">
    <path class="gh-bg" d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
    <path class="gh-arm" style="transform-origin:130px 106px"
      d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2"></path>
    <path class="gh-body"
      d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z"></path>
  </svg>
</a>

<!-- 登录遮罩 -->
<div id="loginOverlay" class="login-overlay hidden">
  <div class="login-box">
    <h2>管理登录</h2>
    <p>请输入访问密码以继续</p>
    <div class="err" id="loginErr">密码错误</div>
    <div class="field">
      <input id="pwdInput" type="password" placeholder="访问密码" autocomplete="current-password" />
    </div>
    <button id="loginBtn" class="btn-primary" style="width:100%;margin-top:4px;">登 录</button>
  </div>
</div>

<div class="shell">
  <header class="header">
    <div class="brand">
      <svg class="logo" viewBox="0 0 24 24" width="24" height="24">
        <path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/>
      </svg>
      <span class="eyebrow">CF Keepalive</span>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button id="logoutBtn" class="btn-ghost btn-xs">退出</button>
      <button id="themeToggle" class="theme-toggle" aria-label="切换主题">
        <svg class="sun-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg class="moon-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </header>

  <section class="hero">
    <h1>URL 保活监控</h1>
    <p class="lead">定时访问 URL，自动处理 JS 挑战（aes.js）。支持手动触发、失败计数、5 次失败自动禁用。</p>
  </section>

  <section class="card">
    <h2>添加 URL</h2>
    <div class="row" style="margin-bottom: 10px;">
      <input id="urlInput" type="text" placeholder="https://example.com/path" />
      <input id="intervalInput" type="number" style="max-width: 110px;" value="300" min="60" title="检查间隔（秒）" />
      <button id="addBtn" class="btn-primary">添加</button>
    </div>
    <div style="font-size: 12px; color: var(--text-muted);">第二个输入框是检查间隔秒数（默认 300，最小 60）</div>
  </section>

  <section class="card">
    <div class="flex-between">
      <h2 style="margin: 0;">监控列表</h2>
      <div style="display: flex; gap: 8px;">
        <button id="runAllBtn" class="btn-primary btn-xs">立即检查全部</button>
        <button id="refreshBtn" class="btn-ghost btn-xs">刷新</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 60px;">ID</th>
            <th>URL</th>
            <th style="width: 90px;">间隔</th>
            <th style="width: 110px;">状态</th>
            <th style="width: 80px;">失败次数</th>
            <th style="width: 160px;">最后访问</th>
            <th style="width: 160px;">最后成功</th>
            <th style="width: 150px;">操作</th>
          </tr>
        </thead>
        <tbody id="tbody">
          <tr><td colspan="8" class="empty">加载中…</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <section class="card">
    <div class="flex-between">
      <h2 style="margin: 0;">最近日志</h2>
      <button id="clearLogsBtn" class="btn-ghost btn-xs">清空日志</button>
    </div>
    <div id="logBox" class="log">加载中…</div>
  </section>

  <footer class="site-footer">CF Keepalive Worker · D1 + Cron</footer>
</div>

<script>
var $ = function(id) { return document.getElementById(id); };
var AUTH_KEY = 'cf-keepalive-pwd';

function getToken() { return localStorage.getItem(AUTH_KEY) || ''; }
function setToken(t) { localStorage.setItem(AUTH_KEY, t); }
function clearToken() { localStorage.removeItem(AUTH_KEY); }

$('themeToggle').addEventListener('click', function() {
  var cur = document.documentElement.getAttribute('data-theme') || 'light';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
});

function fmtTime(ts) {
  if (ts === null || ts === undefined || ts === '') return '-';
  var n = Number(ts);
  if (!isFinite(n) || n <= 0) return '-';
  var ms = n > 1e12 ? n : n * 1000;
  var d = new Date(ms + 8 * 3600 * 1000);
  if (isNaN(d.getTime())) return '-';
  var p = function(v) { return String(v).padStart(2, '0'); };
  return d.getUTCFullYear() + '-' +
         p(d.getUTCMonth() + 1) + '-' +
         p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' +
         p(d.getUTCMinutes()) + ':' +
         p(d.getUTCSeconds());
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function showLogin() {
  $('loginOverlay').classList.remove('hidden');
  setTimeout(function() { $('pwdInput').focus(); }, 100);
}
function hideLogin() {
  $('loginOverlay').classList.add('hidden');
  $('loginErr').classList.remove('show');
  $('pwdInput').value = '';
}
function showLoginErr(msg) {
  var el = $('loginErr');
  el.textContent = msg || '密码错误';
  el.classList.add('show');
}

async function doLogin() {
  var pwd = $('pwdInput').value;
  if (!pwd) { showLoginErr('请输入密码'); return; }
  $('loginBtn').disabled = true;
  $('loginBtn').textContent = '验证中…';
  try {
    var r = await fetch('/api/state', { headers: { 'X-Auth-Token': pwd } });
    if (r.status === 401) { showLoginErr('密码错误'); return; }
    if (!r.ok) { showLoginErr('验证失败: HTTP ' + r.status); return; }
    setToken(pwd);
    hideLogin();
    await refresh();
    startAutoRefresh();
  } catch (e) {
    showLoginErr('连接失败: ' + e.message);
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = '登 录';
  }
}

$('loginBtn').addEventListener('click', doLogin);
$('pwdInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});
$('logoutBtn').addEventListener('click', function() {
  clearToken();
  stopAutoRefresh();
  showLogin();
});

async function api(path, method, body) {
  var opts = { method: method || 'GET', headers: {} };
  var pwd = getToken();
  if (pwd) opts.headers['X-Auth-Token'] = pwd;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  var r = await fetch('/api' + path, opts);
  if (r.status === 401) {
    clearToken();
    showLogin();
    throw new Error('登录已失效，请重新登录');
  }
  var data = await r.json().catch(function() { return {}; });
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function renderUrls(urls) {
  var tb = $('tbody');
  if (!urls.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">还没有监控 URL，先添加一个。</td></tr>';
    return;
  }
  var html = '';
  for (var i = 0; i < urls.length; i++) {
    var u = urls[i];
    var status;
    if (u.disabled) status = '<span class="badge badge-disabled">已禁用</span>';
    else if (u.fail_count > 0) status = '<span class="badge badge-fail">失败 ' + u.fail_count + '</span>';
    else if (u.last_success) status = '<span class="badge badge-ok">正常</span>';
    else status = '<span class="badge badge-idle">未检查</span>';

    html += '<tr>' +
      '<td>' + u.id + '</td>' +
      '<td class="mono">' + escapeHtml(u.url) + '</td>' +
      '<td>' + u.interval_sec + 's</td>' +
      '<td>' + status + '</td>' +
      '<td>' + u.fail_count + '</td>' +
      '<td>' + fmtTime(u.last_visit) + '</td>' +
      '<td>' + fmtTime(u.last_success) + '</td>' +
      '<td>' +
        '<button class="btn-ghost btn-xs" data-act="check" data-id="' + u.id + '">检查</button> ' +
        '<button class="btn-danger btn-xs" data-act="del" data-id="' + u.id + '">删除</button>' +
      '</td>' +
    '</tr>';
  }
  tb.innerHTML = html;
}

function renderLogs(logs) {
  var box = $('logBox');
  if (!logs.length) {
    box.textContent = '暂无日志';
    return;
  }
  var html = '';
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i];
    var cls = l.level === 'INFO' ? 'ok'
            : l.level === 'WARN' ? 'warn'
            : l.level === 'ERROR' ? 'error' : '';
    html += '<span class="log-item ' + cls + '">[' + fmtTime(l.ts) + '] [' + l.level + '] ' + escapeHtml(l.message) + '</span>';
  }
  box.innerHTML = html;
}

async function refresh() {
  try {
    var data = await api('/state');
    renderUrls(data.urls || []);
    renderLogs(data.logs || []);
  } catch (e) {
    if (e.message.indexOf('登录') === -1) {
      $('tbody').innerHTML = '<tr><td colspan="8" class="empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
    }
  }
}

$('addBtn').addEventListener('click', async function() {
  var url = $('urlInput').value.trim();
  var interval = parseInt($('intervalInput').value) || 300;
  if (!url) { alert('请输入 URL'); return; }
  $('addBtn').disabled = true;
  try {
    await api('/add', 'POST', { url: url, interval: interval });
    $('urlInput').value = '';
    await refresh();
  } catch (e) {
    alert('添加失败: ' + e.message);
  } finally {
    $('addBtn').disabled = false;
  }
});

$('tbody').addEventListener('click', async function(ev) {
  var btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  var id = parseInt(btn.dataset.id);
  var act = btn.dataset.act;
  btn.disabled = true;
  try {
    if (act === 'del') {
      if (!confirm('确认删除？')) { btn.disabled = false; return; }
      await api('/delete', 'POST', { id: id });
    } else if (act === 'check') {
      await api('/check-one', 'POST', { id: id });
    }
    await refresh();
  } catch (e) {
    alert('操作失败: ' + e.message);
  } finally {
    btn.disabled = false;
  }
});

$('runAllBtn').addEventListener('click', async function() {
  $('runAllBtn').disabled = true;
  $('runAllBtn').textContent = '检查中…';
  try {
    await api('/check', 'POST', {});
    await refresh();
  } catch (e) {
    alert('检查失败: ' + e.message);
  } finally {
    $('runAllBtn').disabled = false;
    $('runAllBtn').textContent = '立即检查全部';
  }
});

$('refreshBtn').addEventListener('click', refresh);

$('clearLogsBtn').addEventListener('click', async function() {
  if (!confirm('确认清空日志？')) return;
  try {
    await api('/logs', 'DELETE');
    await refresh();
  } catch (e) {
    alert('清空失败: ' + e.message);
  }
});

$('urlInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') $('addBtn').click();
});

var refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 30000);
}
function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

(async function init() {
  var pwd = getToken();
  if (!pwd) { showLogin(); return; }
  try {
    var r = await fetch('/api/state', { headers: { 'X-Auth-Token': pwd } });
    if (r.status === 401) { clearToken(); showLogin(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    renderUrls(data.urls || []);
    renderLogs(data.logs || []);
    startAutoRefresh();
  } catch (e) {
    showLogin();
  }
})();
</script>
</body>
</html>`;
}

// ============================================================
// 入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      try {
        return await handleAPI(request, env, path.slice(4));
      } catch (e) {
        console.error('API error:', e);
        return jsonResponse({ error: e.message || String(e) }, 500);
      }
    }

    if (request.method === 'POST' && path === '/add-url') {
      try {
        return await handleAPI(request, env, '/add-url');
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      return htmlResponse(createAppHtml());
    }

    return new Response('Method Not Allowed', { status: 405 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        await ensureDB(env.DB);
        await checkAll(env.DB, false);
      } catch (e) {
        console.error('cron error:', e);
        try { await addLog(env.DB, 'ERROR', 'CRON ERROR ' + e.message); } catch (err) {}
      }
    })());
  },
};