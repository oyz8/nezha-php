/**
 * CF Keepalive Worker
 *  - 定时访问 URL 列表（cron 触发）
 *  - 自动处理 byethost 的 aes.js 挑战（key=a, iv=b, AES-128-CBC，无 padding）
 *  - Streamlit 应用保活（disambiguate + resume）
 *  - 添加 URL 时自动错峰
 *  - 禁用的 URL 默认折叠，可手动展开
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
const FAIL_THRESHOLD = 5;
const RETRY_AFTER_DISABLE_MS = 30 * 60 * 1000;   // 30 分钟

const DEFAULT_INTERVAL           = 300;
const DEFAULT_INTERVAL_STREAMLIT = 600;

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
// Streamlit 保活
// ============================================================
function isStreamlitUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return h === 'streamlit.app' || h.endsWith('.streamlit.app');
  } catch {
    return false;
  }
}

function resolveInterval(url, raw) {
  const fallback = isStreamlitUrl(url)
    ? DEFAULT_INTERVAL_STREAMLIT
    : DEFAULT_INTERVAL;
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(60, n);
}

function uuidFromString(str) {
  let h1 = 0x811c9dc5, h2 = 0x811c9dc5, h3 = 0x811c9dc5, h4 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c,         0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + 1),   0x01000193) >>> 0;
    h3 = Math.imul(h3 ^ (c + 2),   0x01000193) >>> 0;
    h4 = Math.imul(h4 ^ (c + 3),   0x01000193) >>> 0;
  }
  const p = (n, l) => n.toString(16).padStart(l, '0');
  const hex = p(h1, 8) + p(h2, 8) + p(h3, 8) + p(h4, 8);
  return hex.slice(0, 8) + '-' +
         hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' +
         hex.slice(17, 20) + '-' + hex.slice(20);
}

async function doStreamlitKeepalive(url) {
  let u;
  try { u = new URL(url); } catch (e) {
    return { status: 0, ok: false, error: 'invalid url' };
  }
  const base = u.origin;
  const machineId = uuidFromString(base);

  let r1;
  try {
    r1 = await fetch(base + '/api/v2/app/disambiguate', {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'accept': 'application/json',
        'referer': base + '/sub',
        'x-streamlit-machine-id': machineId,
      },
      redirect: 'manual',
    });
  } catch (e) {
    return { status: 0, ok: false, error: 'disambiguate failed: ' + e.message, streamlit: true };
  }

  const csrf = r1.headers.get('x-csrf-token') || '';
  const setCookie = r1.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0].trim();

  try { await r1.text(); } catch (e) {}

  if (!csrf) {
    return {
      status: r1.status, ok: false, streamlit: true,
      error: 'no csrf token (disambiguate http ' + r1.status + ')',
    };
  }

  let r2;
  try {
    r2 = await fetch(base + '/api/v2/app/resume', {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'accept': 'application/json',
        'origin': base,
        'referer': base + '/sub',
        'x-streamlit-machine-id': machineId,
        'x-csrf-token': csrf,
        'Cookie': cookie,
      },
      redirect: 'manual',
    });
  } catch (e) {
    return { status: 0, ok: false, error: 'resume failed: ' + e.message, streamlit: true };
  }

  let body = '';
  try { body = (await r2.text()).slice(0, 400); } catch (e) {}

  return {
    status: r2.status,
    ok: r2.status >= 200 && r2.status < 400,
    body,
    challenged: false,
    streamlit: true,
  };
}

// ============================================================
// PID 提取
// ============================================================
function extractPidInfo(body) {
  if (!body || typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/运行中/.test(trimmed) || /已自动拉起/.test(trimmed)) {
      const m = trimmed.match(/((?:运行中|已自动拉起)[^\r\n]{0,60})/);
      if (m) return m[1].trim();
    }
  }
  return null;
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
          disabled_at INTEGER DEFAULT 0,
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

      try {
        await db.prepare(`ALTER TABLE urls ADD COLUMN disabled_at INTEGER DEFAULT 0`).run();
      } catch (e) { /* 字段已存在 */ }
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

async function addUrl(db, url, intervalSec = DEFAULT_INTERVAL) {
  const clean = url.trim();
  const phaseMs = Math.floor(Math.random() * intervalSec * 1000);
  const initialLastVisit = nowMs() - phaseMs;
  await db.prepare(
    `INSERT OR IGNORE INTO urls (url, interval_sec, created_at, last_visit)
     VALUES (?, ?, ?, ?)`
  ).bind(clean, intervalSec, nowSec(), initialLastVisit).run();
}

async function deleteUrl(db, id) {
  await db.prepare(`DELETE FROM urls WHERE id = ?`).bind(id).run();
}

async function clearLogs(db) {
  await db.prepare(`DELETE FROM logs`).run();
}

async function recordResult(db, id, result) {
  const row = await db.prepare(
    `SELECT fail_count, disabled, disabled_at FROM urls WHERE id=?`
  ).bind(id).first();

  const isManualDisabled = row && row.disabled === 1 && (!row.disabled_at || row.disabled_at === 0);

  if (result.ok) {
    await db.prepare(
      `UPDATE urls SET fail_count=0, disabled=0, disabled_at=0,
       last_visit=?, last_success=?, last_status=?, last_error='' WHERE id=?`
    ).bind(nowMs(), nowSec(), result.status, id).run();
    return;
  }

  if (isManualDisabled) {
    await db.prepare(
      `UPDATE urls SET last_visit=?, last_status=?, last_error=? WHERE id=?`
    ).bind(nowMs(), result.status || 0, (result.error || '').slice(0, 200), id).run();
    return;
  }

  const fails = (row?.fail_count || 0) + 1;
  const willDisable = fails >= FAIL_THRESHOLD ? 1 : 0;
  const disabledAt = willDisable ? nowMs() : 0;

  await db.prepare(
    `UPDATE urls SET fail_count=?, disabled=?, disabled_at=?,
     last_visit=?, last_status=?, last_error=? WHERE id=?`
  ).bind(
    fails, willDisable, disabledAt, nowMs(), result.status || 0,
    (result.error || '').slice(0, 200), id
  ).run();
}

// ============================================================
// 检查逻辑
// ============================================================
function shouldSkip(record) {
  const now = nowMs();
  return now - (record.last_visit || 0) < (record.interval_sec || DEFAULT_INTERVAL) * 1000;
}

async function checkOne(db, record, force = false) {
  if (!force && shouldSkip(record)) return { skipped: true };

  const r = isStreamlitUrl(record.url)
    ? await doStreamlitKeepalive(record.url)
    : await fetchWithChallenge(record.url);

  await recordResult(db, record.id, r);

  const pidInfo = extractPidInfo(r.body || '');
  const isRunning    = pidInfo && /运行中/.test(pidInfo);
  const isAutoStart  = pidInfo && /已自动拉起/.test(pidInfo);

  let msg;
  const level = r.ok ? 'INFO' : (r.status ? 'WARN' : 'ERROR');
  const tag = r.streamlit ? ' [streamlit]' : '';

  if (r.ok && isAutoStart) {
    msg = `✅ ${pidInfo} ${record.url}${tag}`;
  } else if (r.ok && isRunning) {
    msg = `OK ${pidInfo} ${record.url} [${r.status}]${tag}`;
    if (r.challenged) msg += ' (challenge)';
  } else if (r.ok) {
    msg = `OK ${record.url} [${r.status}]${tag}`;
    if (r.challenged) msg += ' (challenge)';
  } else {
    msg = `FAIL ${record.url} [${r.status || 'ERR'}]${tag}`;
    if (r.challenged) msg += ' (challenge)';
    if (r.error) msg += ` ${r.error}`;
  }

  await addLog(db, level, msg);
  return r;
}

async function checkAll(db, force = false) {
  const urls = await listUrls(db);
  const now = nowMs();
  const results = [];

  for (const u of urls) {
    let forceThis = force;

    if (u.disabled && !force) {
      const canRetry = u.disabled_at && u.disabled_at > 0
                    && (now - u.disabled_at) >= RETRY_AFTER_DISABLE_MS;

      if (!canRetry) {
        results.push({ id: u.id, url: u.url, skipped: true, reason: 'disabled' });
        continue;
      }

      forceThis = true;
    }

    try {
      const r = await checkOne(db, u, forceThis);
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
    const interval = resolveInterval(body.url, body.interval);
    await addUrl(db, body.url, interval);
    await addLog(db, 'INFO', `ADD ${body.url.trim()} (interval=${interval}s)`);
    return jsonResponse({ success: true, interval });
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

  if (method === 'POST' && path === '/toggle') {
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }
    if (!body.id) return jsonResponse({ error: '缺少 id' }, 400);

    const row = await db.prepare(
      `SELECT url, disabled FROM urls WHERE id=?`
    ).bind(body.id).first();
    if (!row) return jsonResponse({ error: 'not found' }, 404);

    if (row.disabled) {
      await db.prepare(
        `UPDATE urls SET disabled=0, disabled_at=0, fail_count=0 WHERE id=?`
      ).bind(body.id).run();
      await addLog(db, 'INFO', `ENABLE ${row.url}`);
      return jsonResponse({ success: true, disabled: 0 });
    } else {
      await db.prepare(
        `UPDATE urls SET disabled=1, disabled_at=0 WHERE id=?`
      ).bind(body.id).run();
      await addLog(db, 'INFO', `DISABLE (manual) ${row.url}`);
      return jsonResponse({ success: true, disabled: 1 });
    }
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
    const interval = resolveInterval(body.url, body.interval);
    await addUrl(db, body.url, interval);
    await addLog(db, 'INFO', `ADD (public) ${body.url.trim()} (interval=${interval}s)`);
    return jsonResponse({ success: true, interval });
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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='100' y2='100' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0%25' stop-color='%2314b8a6'/%3E%3Cstop offset='100%25' stop-color='%230891b2'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100' height='100' rx='25' ry='25' fill='url(%23g)'/%3E%3Cg fill='%23fff' font-family='Arial,Helvetica,sans-serif' font-weight='800'%3E%3Ctext x='3.5' y='71' font-size='54' letter-spacing='-2'%3EK%3C/text%3E%3Ctext x='46.5' y='71' font-size='30'%3Ee%3C/text%3E%3Ctext x='57.5' y='71' font-size='30'%3Ee%3C/text%3E%3Ctext x='78' y='71' font-size='30'%3Ep%3C/text%3E%3C/g%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<script>
  (function() {
    var t = localStorage.getItem('theme');
    document.documentElement.setAttribute('data-theme',
      t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
  })();
</script>
<style>
:root, :root[data-theme="light"] {
  color-scheme: light;
  --bg: #f8fafc;
  --bg-gradient: radial-gradient(circle at top left, rgba(15,118,110,.07), transparent 40%),
                 radial-gradient(circle at right 20%, rgba(2,132,199,.05), transparent 35%),
                 linear-gradient(180deg, #f8fafc 0%, #eef2f6 100%);
  --panel: rgba(255,255,255,.85);
  --panel-solid: #fff;
  --panel-border: rgba(15,23,42,.06);
  --text: #0f172a;
  --text-muted: #475569;
  --text-tertiary: #94a3b8;
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
  --input-focus: #0f766e;
  --btn-ghost-bg: #e2e8f0;
  --btn-ghost-hover: #cbd5e1;
  --table-header-bg: #f8fafc;
  --table-border: #e2e8f0;
  --table-row-hover: #f1f5f9;
  --code-bg: #f1f5f9;
  --tip-bg: rgba(15,23,42,.96);
  --tip-text: #e2e8f0;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0b0f19;
  --bg-gradient: radial-gradient(circle at top left, rgba(20,184,166,.1), transparent 45%),
                 radial-gradient(circle at right 20%, rgba(14,165,233,.06), transparent 40%),
                 linear-gradient(180deg, #0b0f19 0%, #030712 100%);
  --panel: rgba(17,24,39,.85);
  --panel-solid: #111827;
  --panel-border: rgba(255,255,255,.08);
  --text: #f1f5f9;
  --text-muted: #94a3b8;
  --text-tertiary: #64748b;
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
  --input-focus: #14b8a6;
  --btn-ghost-bg: #334155;
  --btn-ghost-hover: #475569;
  --table-header-bg: #1e293b;
  --table-border: #334155;
  --table-row-hover: #1e293b;
  --code-bg: #1e293b;
  --tip-bg: rgba(2,6,23,.98);
  --tip-text: #e2e8f0;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  min-height: 100vh;
  font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
  color: var(--text);
  background: var(--bg-gradient);
  -webkit-font-smoothing: antialiased;
  transition: background .3s, color .3s;
  overflow-x: hidden;
}

/* ── 布局 ───────────────────────────── */
.shell { width: min(1200px, calc(100vw - 24px)); margin: 0 auto; padding: 16px 0 60px; }

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  gap: 12px;
  flex-wrap: wrap;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-logo {
  width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 14px var(--primary-glow);
  overflow: hidden;
}
.brand-logo svg { width: 100%; height: 100%; display: block; }
.brand-title {
  font-family: 'Outfit', sans-serif; font-weight: 800;
  font-size: 19px; letter-spacing: -.02em;
  line-height: 1.2;
}
.brand-sub { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
.header-right { display: flex; gap: 6px; align-items: center; }

.theme-toggle {
  width: 34px; height: 34px; border-radius: 10px;
  border: 1px solid var(--panel-border);
  background: var(--panel); color: var(--text);
  cursor: pointer; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0; outline: none; transition: all .2s;
  position: relative;
}
.theme-toggle:hover { background: var(--table-row-hover); }
.theme-toggle svg {
  width: 18px; height: 18px;
  fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
  transition: transform .5s, opacity .2s;
}
:root[data-theme="dark"] .sun-icon { opacity: 1; transform: rotate(0) scale(1); }
:root[data-theme="dark"] .moon-icon { opacity: 0; transform: rotate(90deg) scale(0); position: absolute; }
:root[data-theme="light"] .sun-icon { opacity: 0; transform: rotate(-90deg) scale(0); position: absolute; }
:root[data-theme="light"] .moon-icon { opacity: 1; transform: rotate(0) scale(1); }

/* ── 卡片 ─────────────────────────── */
.card {
  padding: 18px;
  margin-bottom: 14px;
  border: 1px solid var(--panel-border);
  border-radius: 16px;
  background: var(--panel);
  box-shadow: var(--card-shadow);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.card-title {
  font-family: 'Outfit', sans-serif;
  font-weight: 700;
  font-size: 12.5px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: .08em;
  display: flex;
  align-items: center;
  gap: 7px;
}
.card-title svg { width: 15px; height: 15px; color: var(--primary); flex-shrink: 0; }
.card-title .count-badge {
  display: inline-flex; align-items: center;
  padding: 1px 7px; border-radius: 6px;
  font-size: 10.5px; font-weight: 700;
  letter-spacing: 0; text-transform: none;
  background: var(--primary-glow); color: var(--primary-strong);
  margin-left: 2px;
}
.card-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* ── 表单 ─────────────────────────── */
.row { display: flex; gap: 8px; align-items: center; }
input[type="text"], input[type="number"], input[type="password"] {
  flex: 1;
  padding: 11px 14px;
  border: 1px solid var(--input-border);
  border-radius: 10px;
  font-family: inherit;
  font-size: 14px;
  background: var(--input-bg);
  color: var(--text);
  outline: none;
  transition: all .2s;
  min-width: 0;
}
input:focus {
  border-color: var(--input-focus);
  box-shadow: 0 0 0 3px var(--primary-glow);
}
input::placeholder { color: var(--text-muted); opacity: .6; }

/* ── 按钮 ─────────────────────────── */
button {
  appearance: none; border: 0; border-radius: 10px;
  padding: 10px 18px;
  font-family: 'Outfit', sans-serif;
  font-weight: 700; font-size: 13.5px;
  cursor: pointer;
  transition: all .2s;
  display: inline-flex; align-items: center; justify-content: center;
  gap: 6px;
  line-height: 1;
  white-space: nowrap;
}
button svg { width: 14px; height: 14px; flex-shrink: 0; }
button:hover { transform: translateY(-1.5px); }
button:active { transform: scale(.97); }
button:disabled { cursor: not-allowed; transform: none !important; opacity: .55; }
.btn-primary {
  color: #fff;
  background: linear-gradient(135deg, var(--primary), #0891b2);
  box-shadow: 0 4px 14px var(--primary-glow);
}
.btn-primary:hover { background: linear-gradient(135deg, var(--primary-hover), #0e7490); }
.btn-ghost { color: var(--text); background: var(--btn-ghost-bg); }
.btn-ghost:hover { background: var(--btn-ghost-hover); }
.btn-danger {
  color: #fff;
  background: linear-gradient(135deg, var(--danger), #dc2626);
  box-shadow: 0 4px 14px var(--danger-glow);
}
.btn-danger:hover { background: linear-gradient(135deg, var(--danger-hover), #b91c1c); }
.btn-xs { padding: 6px 12px; font-size: 12px; border-radius: 8px; gap: 4px; }
.btn-xs svg { width: 12px; height: 12px; }

/* ── 登录 ─────────────────────────── */
.login-overlay {
  position: fixed; inset: 0; z-index: 1500;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-gradient);
  padding: 24px;
}
.login-overlay.hidden { display: none; }
.login-box {
  width: 100%; max-width: 400px;
  padding: 34px 30px 28px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 20px;
  box-shadow: var(--shadow);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
}
.login-box h2 {
  font-family: 'Outfit', sans-serif;
  font-size: 22px; font-weight: 800;
  margin-bottom: 6px;
  letter-spacing: -.02em;
  display: flex; align-items: center; gap: 10px;
}
.login-box h2 .login-logo {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 14px var(--primary-glow);
  overflow: hidden;
}
.login-box h2 .login-logo svg { width: 100%; height: 100%; display: block; }
.login-box > p {
  color: var(--text-muted); font-size: 13px;
  margin-bottom: 20px; line-height: 1.6;
}
.login-box .field { margin-bottom: 12px; }
.login-box .field input { width: 100%; }
.login-box .err {
  display: none;
  padding: 10px 14px; border-radius: 10px;
  background: rgba(185,28,28,.1);
  border: 1px solid rgba(185,28,28,.2);
  color: var(--danger);
  font-size: 13px;
  margin-bottom: 12px;
}
.login-box .err.show { display: block; }

/* ── 表格 ─────────────────────────── */
.table-wrap {
  overflow: auto;
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  background: var(--input-bg);
  -webkit-overflow-scrolling: touch;
}
.table-wrap + .table-wrap { margin-top: 0; }
table { width: 100%; border-collapse: collapse; min-width: 900px; }
thead { background: var(--table-header-bg); position: sticky; top: 0; z-index: 1; }
th, td {
  padding: 11px 12px;
  border-bottom: 1px solid var(--table-border);
  text-align: left;
  vertical-align: middle;
  font-size: 12.5px;
}
th {
  font-family: 'Outfit', sans-serif;
  font-size: 11px; font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--text-muted);
}
tbody tr { transition: background .2s; }
tbody tr:hover { background: var(--table-row-hover); }
tbody tr:last-child td { border-bottom: 0; }

/* URL 单元格 */
.url-cell {
  max-width: 320px;
  cursor: help;
}
.url-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
}

/* 操作列：3 个按钮并排一行 */
.actions-cell {
  display: flex;
  gap: 4px;
  flex-wrap: nowrap;
  align-items: center;
}

/* 折叠控制条 */
.disabled-toggle {
  display: flex;
  justify-content: center;
  margin-top: 10px;
}
#toggleDisabledBtn {
  color: var(--text-muted);
  background: var(--btn-ghost-bg);
  border: 1px dashed var(--panel-border);
  gap: 6px;
}
#toggleDisabledBtn:hover { color: var(--text); background: var(--btn-ghost-hover); }
#toggleDisabledBtn svg {
  transition: transform .25s;
  width: 12px; height: 12px;
}
#toggleDisabledBtn.expanded svg { transform: rotate(180deg); }

#disabledWrap { opacity: .85; }

/* 全局 URL 悬停浮层 */
#urlTip {
  position: fixed;
  z-index: 9999;
  padding: 8px 12px;
  background: var(--tip-bg);
  color: var(--tip-text);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,.08);
  box-shadow: 0 12px 32px rgba(0,0,0,.35);
  max-width: min(560px, 80vw);
  word-break: break-all;
  pointer-events: none;
  opacity: 0;
  transition: opacity .12s;
}
#urlTip.show { opacity: 1; }

/* ── 徽章 ─────────────────────────── */
.badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px; border-radius: 7px;
  font-size: 11px; font-weight: 600;
  line-height: 1; border: 1px solid transparent;
  white-space: nowrap;
}
.badge-ok { background: rgba(16,185,129,.1); color: #059669; border-color: rgba(16,185,129,.15); }
:root[data-theme="dark"] .badge-ok { background: rgba(16,185,129,.15); color: #34d399; }
.badge-fail { background: rgba(239,68,68,.1); color: #dc2626; border-color: rgba(239,68,68,.15); }
:root[data-theme="dark"] .badge-fail { background: rgba(239,68,68,.15); color: #fca5a5; }
.badge-idle { background: rgba(100,116,139,.1); color: #475569; border-color: rgba(100,116,139,.15); }
:root[data-theme="dark"] .badge-idle { background: rgba(148,163,184,.15); color: #cbd5e1; }
.badge-disabled { background: rgba(217,119,6,.1); color: #b45309; border-color: rgba(217,119,6,.15); }
:root[data-theme="dark"] .badge-disabled { background: rgba(251,191,36,.15); color: #fbbf24; }
.badge-streamlit { background: rgba(139,92,246,.1); color: #7c3aed; border-color: rgba(139,92,246,.2); }
:root[data-theme="dark"] .badge-streamlit { background: rgba(167,139,250,.15); color: #c4b5fd; }
.badge-shield { background: rgba(59,130,246,.1); color: #1d4ed8; border-color: rgba(59,130,246,.2); }
:root[data-theme="dark"] .badge-shield { background: rgba(96,165,250,.15); color: #93c5fd; }

/* ── 日志 ─────────────────────────── */
.log {
  max-height: 380px; overflow: auto;
  padding: 14px 16px;
  border-radius: 12px;
  background: #0f172a; color: #e2e8f0;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-size: 12px; line-height: 1.65;
  white-space: pre-wrap;
  border: 1px solid rgba(255,255,255,.05);
}
.log-item { display: block; }
.log-item.ok { color: #4ade80; }
.log-item.warn { color: #facc15; }
.log-item.error { color: #f87171; }

/* ── 提示 ─────────────────────────── */
.hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
  margin-top: 10px;
}
.hint b { color: var(--primary); font-weight: 600; }
.hint code {
  background: var(--code-bg);
  padding: 2px 6px; border-radius: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
  color: var(--primary-strong);
  border: 1px solid var(--panel-border);
}

.empty { padding: 26px; text-align: center; color: var(--text-muted); font-size: 13px; }
.site-footer {
  text-align: center;
  font-size: 11.5px;
  color: var(--text-muted);
  padding-top: 20px;
  line-height: 1.8;
}

/* ── GitHub 角标（仅登录页） ─────────── */
.github-corner {
  position: fixed; top: 0; right: 0;
  z-index: 2000;
  line-height: 0; display: block;
  border: 0; overflow: hidden;
}
.github-corner svg { width: 88px; height: 88px; display: block; color: #fff; }
.github-corner .gh-bg { fill: var(--primary); transition: fill .3s; }
.github-corner .gh-arm,
.github-corner .gh-body { fill: currentColor; }
.github-corner:hover .gh-bg { fill: var(--primary-hover); }
.github-corner:hover .gh-arm { animation: octocat-wave 560ms ease-in-out; }
@keyframes octocat-wave {
  0%, 100% { transform: rotate(0); }
  20%, 60% { transform: rotate(-25deg); }
  40%, 80% { transform: rotate(10deg); }
}
.github-corner.hidden { display: none !important; }

/* ═══════════════════════════════════
   移动端：监控列表 = 4 格布局
   ═══════════════════════════════════ */
@media (max-width: 640px) {
  .shell { padding: 12px 0 60px; }
  .brand-title { font-size: 16px; }
  .brand-logo { width: 30px; height: 30px; }
  .brand-logo svg { width: 100%; height: 100%; }
  .card { padding: 14px; }
  .card-title { font-size: 11.5px; }
  .card-title svg { width: 14px; height: 14px; }

  .row { flex-wrap: wrap; }
  .row > input[type="text"] { flex: 1 1 100%; }
  .row > input[type="number"] { flex: 1 1 calc(50% - 4px); max-width: none !important; }
  .row > button { flex: 1 1 calc(50% - 4px); padding: 11px 8px; }

  .header-right { gap: 4px; }
  .btn-xs span { display: none; }
  .btn-xs { padding: 8px 10px; }
  .btn-xs svg { width: 14px; height: 14px; }

  /* 折叠按钮：移动端保留文字 */
  #toggleDisabledBtn span { display: inline; }
  #toggleDisabledBtn {
    padding: 10px 16px;
    font-size: 13px;
    gap: 8px;
  }
  #toggleDisabledBtn svg { width: 14px; height: 14px; }

  .log { font-size: 11.5px; padding: 12px; max-height: 320px; }

  .github-corner svg { width: 62px; height: 62px; }
  .github-corner:hover .gh-arm { animation: none; }
  .github-corner .gh-arm { animation: octocat-wave 560ms ease-in-out; }

  #urlTip { display: none !important; }

  /* 表格转卡片 */
  .table-wrap {
    border: 0;
    background: transparent;
    overflow: visible;
  }
  table { min-width: 0; width: 100%; }
  thead { display: none; }
  tbody { display: block; }

  tbody tr {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    column-gap: 8px;
    row-gap: 10px;
    background: var(--input-bg);
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    padding: 14px;
    margin-bottom: 12px;
    box-shadow: var(--card-shadow);
  }
  tbody tr:hover { background: var(--input-bg); }
  tbody tr:last-child { margin-bottom: 0; }

  tbody td {
    display: block;
    padding: 0;
    border: 0;
    min-width: 0;
    font-size: 12.5px;
    line-height: 1.45;
  }

  tbody td[data-lbl]::before {
    content: attr(data-lbl);
    display: block;
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: .06em;
    font-weight: 700;
    margin-bottom: 3px;
  }

  /* 格 1：类型徽章（右上）+ URL（全宽） */
  tbody td:nth-child(1) {
    grid-column: 4 / 7;
    grid-row: 1;
    text-align: right;
    align-self: center;
  }
  tbody td:nth-child(2) {
    grid-column: 1 / 7;
    grid-row: 2;
    max-width: none;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--table-border);
  }
  tbody td:nth-child(2) .url-text {
    white-space: normal;
    word-break: break-all;
    overflow: visible;
    text-overflow: clip;
  }

  /* 格 2：间隔 | 状态 | 失败 （3 段） */
  tbody td:nth-child(3) { grid-column: 1 / 3; grid-row: 3; }
  tbody td:nth-child(4) { grid-column: 3 / 5; grid-row: 3; }
  tbody td:nth-child(5) { grid-column: 5 / 7; grid-row: 3; }

  /* 格 3：最后访问 | 最后成功 （2 段） */
  tbody td:nth-child(6) {
    grid-column: 1 / 4;
    grid-row: 4;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--table-border);
    font-size: 11.5px;
  }
  tbody td:nth-child(7) {
    grid-column: 4 / 7;
    grid-row: 4;
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--table-border);
    font-size: 11.5px;
  }

  /* 格 4：操作（全宽） */
  tbody td:nth-child(8) {
    grid-column: 1 / 7;
    grid-row: 5;
  }
  tbody td:nth-child(8) .actions-cell {
    display: flex;
    gap: 6px;
    flex-wrap: nowrap;
  }
  tbody td:nth-child(8) .actions-cell button {
    flex: 1;
    min-height: 34px;
    padding: 8px 10px;
    font-size: 12.5px;
  }

  .empty { padding: 20px 8px; }
  .disabled-toggle { margin-top: 14px; }
  #toggleDisabledBtn { width: 100%; justify-content: center; }
}
</style>
</head>
<body>

<!-- ══════════ GitHub 角标（仅登录页显示） ══════════ -->
<a id="githubCorner" href="https://github.com/oyz8/nezha-php" target="_blank" rel="noopener"
   class="github-corner hidden" aria-label="View source on GitHub">
  <svg viewBox="0 0 250 250" aria-hidden="true">
    <path class="gh-bg" d="M0,0 L115,115 L130,115 L142,142 L250,250 L250,0 Z"></path>
    <path class="gh-arm" style="transform-origin:130px 106px"
      d="M128.3,109.0 C113.8,99.7 119.0,89.6 119.0,89.6 C122.0,82.7 120.5,78.6 120.5,78.6 C119.2,72.0 123.4,76.3 123.4,76.3 C127.3,80.9 125.5,87.3 125.5,87.3 C122.9,97.6 130.6,101.9 134.4,103.2"></path>
    <path class="gh-body"
      d="M115.0,115.0 C114.9,115.1 118.7,116.5 119.8,115.4 L133.7,101.6 C136.9,99.2 139.9,98.4 142.2,98.6 C133.8,88.0 127.5,74.4 143.8,58.0 C148.5,53.4 154.0,51.2 159.7,51.0 C160.3,49.4 163.2,43.6 171.4,40.1 C171.4,40.1 176.1,42.5 178.8,56.2 C183.1,58.6 187.2,61.8 190.9,65.4 C194.5,69.0 197.7,73.2 200.1,77.6 C213.8,80.2 216.3,84.9 216.3,84.9 C212.7,93.1 206.9,96.0 205.4,96.6 C205.1,102.4 203.0,107.8 198.3,112.5 C181.9,128.9 168.3,122.5 157.7,114.1 C157.9,116.9 156.7,120.9 152.7,124.9 L141.0,136.5 C139.8,137.7 141.6,141.9 141.8,141.8 Z"></path>
  </svg>
</a>

<!-- ══════════ 登录 ══════════ -->
<div id="loginOverlay" class="login-overlay hidden">
  <div class="login-box">
    <h2>
      <span class="login-logo">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="keepLoginGrad" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#14b8a6"/>
              <stop offset="100%" stop-color="#0891b2"/>
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="25" ry="25" fill="url(#keepLoginGrad)"/>
          <g fill="#fff" font-family="Arial, Helvetica, sans-serif" font-weight="800">
            <text x="3.5" y="71" font-size="54" letter-spacing="-2">K</text>
            <text x="46.5" y="71" font-size="30">e</text>
            <text x="57.5" y="71" font-size="30">e</text>
            <text x="78" y="71" font-size="30">p</text>
          </g>
        </svg>
      </span>
      <span>URL 保活监控</span>
    </h2>
    <p>请输入访问密码以继续</p>
    <div class="err" id="loginErr"></div>
    <div class="field">
      <input id="pwdInput" type="password" placeholder="访问密码" autocomplete="current-password" />
    </div>
    <button id="loginBtn" class="btn-primary" style="width:100%;">登 录</button>
  </div>
</div>

<!-- ══════════ 主应用 ══════════ -->
<div class="shell" id="app" style="display:none">
  <header class="header">
    <div class="brand">
      <div class="brand-logo">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="keepBrandGrad" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#14b8a6"/>
              <stop offset="100%" stop-color="#0891b2"/>
            </linearGradient>
          </defs>
          <rect width="100" height="100" rx="25" ry="25" fill="url(#keepBrandGrad)"/>
          <g fill="#fff" font-family="Arial, Helvetica, sans-serif" font-weight="800">
            <text x="3.5" y="71" font-size="54" letter-spacing="-2">K</text>
            <text x="46.5" y="71" font-size="30">e</text>
            <text x="57.5" y="71" font-size="30">e</text>
            <text x="78" y="71" font-size="30">p</text>
          </g>
        </svg>
      </div>
      <div>
        <div class="brand-title">URL 保活监控</div>
        <div class="brand-sub">CF Keepalive · D1 + Cron</div>
      </div>
    </div>
    <div class="header-right">
      <button id="refreshBtn" class="btn-ghost btn-xs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        <span>刷新</span>
      </button>
      <button id="logoutBtn" class="btn-ghost btn-xs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span>退出</span>
      </button>
      <button id="themeToggle" class="theme-toggle" aria-label="切换主题">
        <svg class="sun-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        <svg class="moon-icon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </header>

  <!-- 添加 URL -->
  <section class="card">
    <div class="card-head">
      <div class="card-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>添加 URL</span>
      </div>
    </div>
    <div class="row">
      <input id="urlInput" type="text" placeholder="https://xxx.streamlit.app 或 https://example.com/path" />
      <input id="intervalInput" type="number" style="max-width: 110px;" value="300" min="60" title="检查间隔（秒）" />
      <button id="addBtn" class="btn-primary">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        <span>添加</span>
      </button>
    </div>
    <div class="hint">
      第二个输入框是检查间隔秒数（最小 <b>60</b>）。<br>
      普通 URL 默认 <b>300s</b>，<span class="badge badge-streamlit" style="margin:0 2px;">streamlit.app</span> 自动切换为 <b>600s</b>；可手动修改，手动值优先。<br>
      所有 URL 添加时会自动错峰，避免同一时刻集中请求。
    </div>
  </section>

  <!-- 监控列表 -->
  <section class="card">
    <div class="card-head">
      <div class="card-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        <span>监控列表</span>
        <span class="count-badge" id="enabledCount">0</span>
      </div>
      <div class="card-actions">
        <button id="runAllBtn" class="btn-primary btn-xs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>全部检查</span>
        </button>
      </div>
    </div>

    <!-- 启用中的 URL -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width: 130px;">类型</th>
            <th>URL</th>
            <th style="width: 82px;">间隔</th>
            <th style="width: 118px;">状态</th>
            <th style="width: 76px;">失败</th>
            <th style="width: 150px;">最后访问</th>
            <th style="width: 150px;">最后成功</th>
            <th style="width: 200px;">操作</th>
          </tr>
        </thead>
        <tbody id="tbody">
          <tr><td colspan="8" class="empty">加载中…</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 折叠控制 -->
    <div class="disabled-toggle" id="disabledToggle" style="display:none">
      <button class="btn-ghost btn-xs" id="toggleDisabledBtn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        <span id="toggleDisabledText">显示已禁用的 URL (0)</span>
      </button>
    </div>

    <!-- 已禁用的 URL -->
    <div class="table-wrap" id="disabledWrap" style="display:none">
      <table>
        <thead>
          <tr>
            <th style="width: 130px;">类型</th>
            <th>URL</th>
            <th style="width: 82px;">间隔</th>
            <th style="width: 118px;">状态</th>
            <th style="width: 76px;">失败</th>
            <th style="width: 150px;">最后访问</th>
            <th style="width: 150px;">最后成功</th>
            <th style="width: 200px;">操作</th>
          </tr>
        </thead>
        <tbody id="tbodyDisabled"></tbody>
      </table>
    </div>
  </section>

  <!-- 日志 -->
  <section class="card">
    <div class="card-head">
      <div class="card-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span>最近日志</span>
      </div>
      <div class="card-actions">
        <button id="clearLogsBtn" class="btn-ghost btn-xs">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
          <span>清空</span>
        </button>
      </div>
    </div>
    <div id="logBox" class="log">加载中…</div>
  </section>

  <footer class="site-footer">CF Keepalive Worker · D1 + Cron · aes.js 盾 / Streamlit 保活</footer>
</div>

<!-- URL 悬停浮层 -->
<div id="urlTip" role="tooltip" aria-hidden="true"></div>

<script>
var $ = function(id) { return document.getElementById(id); };
var AUTH_KEY = 'cf-keepalive-pwd';
var DEFAULT_INTERVAL_NORMAL = 300;
var DEFAULT_INTERVAL_STREAMLIT = 600;
var DISABLED_EXPANDED_KEY = 'cf-keepalive-disabled-expanded';

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

function isStreamlit(u) {
  try {
    var h = new URL(u).hostname.toLowerCase();
    return h === 'streamlit.app' || h.endsWith('.streamlit.app');
  } catch (e) { return false; }
}

/* ── 登录 ────────────────────────── */
function showLogin() {
  $('loginOverlay').classList.remove('hidden');
  $('app').style.display = 'none';
  $('githubCorner').classList.remove('hidden');
  setTimeout(function() { $('pwdInput').focus(); }, 100);
}
function hideLogin() {
  $('loginOverlay').classList.add('hidden');
  $('loginErr').classList.remove('show');
  $('pwdInput').value = '';
  $('githubCorner').classList.add('hidden');
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
    $('app').style.display = '';
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

/* ── API ─────────────────────────── */
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

/* ── 构建单个 URL 行 ─────────────── */
function buildRow(u) {
  var typeCell = isStreamlit(u.url)
    ? '<span class="badge badge-streamlit">streamlit.app</span>'
    : '<span class="badge badge-shield">aes.js 盾</span>';

  var status;
  if (u.disabled) {
    if (u.disabled_at && u.disabled_at > 0) {
      status = '<span class="badge badge-disabled" title="失败 ' + u.fail_count + ' 次，30 分钟后自动重试">自动禁用</span>';
    } else {
      status = '<span class="badge badge-disabled" title="手动禁用，需手动启用">手动禁用</span>';
    }
  } else if (u.fail_count > 0) {
    status = '<span class="badge badge-fail">失败 ' + u.fail_count + '</span>';
  } else if (u.last_success) {
    status = '<span class="badge badge-ok">正常</span>';
  } else {
    status = '<span class="badge badge-idle">未检查</span>';
  }

  var toggleBtn = u.disabled
    ? '<button class="btn-primary btn-xs" data-act="toggle" data-id="' + u.id + '">启用</button>'
    : '<button class="btn-ghost btn-xs" data-act="toggle" data-id="' + u.id + '">禁用</button>';

  var safe = escapeHtml(u.url);

  return '<tr>' +
    '<td>' + typeCell + '</td>' +
    '<td class="url-cell" data-full="' + safe + '" title="' + safe + '">' +
      '<span class="url-text">' + safe + '</span>' +
    '</td>' +
    '<td data-lbl="间隔">' + u.interval_sec + 's</td>' +
    '<td data-lbl="状态">' + status + '</td>' +
    '<td data-lbl="失败">' + u.fail_count + '</td>' +
    '<td data-lbl="最后访问">' + fmtTime(u.last_visit) + '</td>' +
    '<td data-lbl="最后成功">' + fmtTime(u.last_success) + '</td>' +
    '<td><div class="actions-cell">' +
      '<button class="btn-ghost btn-xs" data-act="check" data-id="' + u.id + '">检查</button>' +
      toggleBtn +
      '<button class="btn-danger btn-xs" data-act="del" data-id="' + u.id + '">删除</button>' +
    '</div></td>' +
  '</tr>';
}

/* ── 更新折叠按钮文案 ───────────── */
function updateToggleText(count, expanded) {
  var span = $('toggleDisabledText');
  if (!span) return;
  span.textContent = (expanded ? '隐藏已禁用的 URL' : '显示已禁用的 URL') + ' (' + count + ')';
  var btn = $('toggleDisabledBtn');
  if (btn) btn.classList.toggle('expanded', !!expanded);
}

/* ── 渲染列表 ───────────────────── */
function renderUrls(urls) {
  var tbEnabled  = $('tbody');
  var tbDisabled = $('tbodyDisabled');
  var toggleBar  = $('disabledToggle');
  var wrap       = $('disabledWrap');

  var enabled  = [];
  var disabled = [];
  for (var i = 0; i < urls.length; i++) {
    if (urls[i].disabled) disabled.push(urls[i]);
    else enabled.push(urls[i]);
  }

  var cnt = $('enabledCount');
  if (cnt) cnt.textContent = String(enabled.length);

  if (!enabled.length) {
    var emptyTxt = disabled.length ? '没有启用中的 URL' : '还没有监控 URL，先添加一个';
    tbEnabled.innerHTML = '<tr><td colspan="8" class="empty">' + emptyTxt + '</td></tr>';
  } else {
    var h = '';
    for (var j = 0; j < enabled.length; j++) h += buildRow(enabled[j]);
    tbEnabled.innerHTML = h;
  }

  if (!disabled.length) {
    toggleBar.style.display = 'none';
    wrap.style.display = 'none';
    tbDisabled.innerHTML = '';
  } else {
    toggleBar.style.display = '';
    var hd = '';
    for (var k = 0; k < disabled.length; k++) hd += buildRow(disabled[k]);
    tbDisabled.innerHTML = hd;

    var expanded = localStorage.getItem(DISABLED_EXPANDED_KEY) === '1';
    wrap.style.display = expanded ? '' : 'none';
    updateToggleText(disabled.length, expanded);
  }
}

/* ── 折叠按钮 ───────────────────── */
$('toggleDisabledBtn').addEventListener('click', function() {
  var wrap = $('disabledWrap');
  var isHidden = wrap.style.display === 'none';
  var nextExpanded = isHidden;
  wrap.style.display = nextExpanded ? '' : 'none';
  localStorage.setItem(DISABLED_EXPANDED_KEY, nextExpanded ? '1' : '0');
  var count = $('tbodyDisabled').querySelectorAll('tr').length;
  updateToggleText(count, nextExpanded);
});

/* ── URL 悬停气泡 ───────────────── */
(function initUrlTip() {
  var tip = $('urlTip');
  if (!tip) return;
  var isCoarse = window.matchMedia('(pointer: coarse)').matches;

  function place(cell) {
    var full = cell.getAttribute('data-full') || '';
    if (!full) return;
    tip.textContent = full;

    var r = cell.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var maxW = Math.min(560, vw * 0.8);
    tip.style.maxWidth = maxW + 'px';

    tip.classList.add('show');
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;

    var left = r.left;
    if (left + tw > vw - 12) left = vw - tw - 12;
    if (left < 12) left = 12;

    var top = r.bottom + 6;
    if (top + th > vh - 12) {
      top = r.top - th - 6;
      if (top < 12) top = r.bottom + 6;
    }
    tip.style.left = left + 'px';
    tip.style.top  = top  + 'px';
  }

  if (!isCoarse) {
    document.addEventListener('mouseover', function(e) {
      var cell = e.target.closest && e.target.closest('.url-cell');
      if (!cell) return;
      place(cell);
    });
    document.addEventListener('mouseout', function(e) {
      var cell = e.target.closest && e.target.closest('.url-cell');
      if (!cell) return;
      tip.classList.remove('show');
    });
    window.addEventListener('scroll', function() { tip.classList.remove('show'); }, true);
  }
})();

/* ── 渲染日志 ──────────────────── */
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

/* ── interval 自动跟随 URL 类型 ── */
var intervalTouched = false;

$('intervalInput').addEventListener('input', function() {
  intervalTouched = true;
});

$('urlInput').addEventListener('input', function() {
  if (intervalTouched) return;
  var url = $('urlInput').value.trim();
  var target = DEFAULT_INTERVAL_NORMAL;
  if (url && isStreamlit(url)) target = DEFAULT_INTERVAL_STREAMLIT;
  $('intervalInput').value = target;
});

/* ── 添加 ──────────────────────── */
$('addBtn').addEventListener('click', async function() {
  var url = $('urlInput').value.trim();
  var interval = parseInt($('intervalInput').value) || 0;
  if (!url) { alert('请输入 URL'); return; }
  $('addBtn').disabled = true;
  try {
    var payload = { url: url };
    if (interval > 0) payload.interval = interval;
    await api('/add', 'POST', payload);
    $('urlInput').value = '';
    intervalTouched = false;
    $('intervalInput').value = DEFAULT_INTERVAL_NORMAL;
    await refresh();
  } catch (e) {
    alert('添加失败: ' + e.message);
  } finally {
    $('addBtn').disabled = false;
  }
});

/* ── 列表操作：两处 tbody 共用同一委托 ── */
function handleActionClick(ev) {
  var btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  var id = parseInt(btn.dataset.id);
  var act = btn.dataset.act;

  (async function() {
    btn.disabled = true;
    try {
      if (act === 'del') {
        if (!confirm('确认删除？')) { btn.disabled = false; return; }
        await api('/delete', 'POST', { id: id });
      } else if (act === 'check') {
        await api('/check-one', 'POST', { id: id });
      } else if (act === 'toggle') {
        await api('/toggle', 'POST', { id: id });
      }
      await refresh();
    } catch (e) {
      alert('操作失败: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  })();
}
$('tbody').addEventListener('click', handleActionClick);
$('tbodyDisabled').addEventListener('click', handleActionClick);

$('runAllBtn').addEventListener('click', async function() {
  $('runAllBtn').disabled = true;
  var spanEl = $('runAllBtn').querySelector('span');
  var old = spanEl ? spanEl.textContent : '';
  if (spanEl) spanEl.textContent = '检查中…';
  try {
    await api('/check', 'POST', {});
    await refresh();
  } catch (e) {
    alert('检查失败: ' + e.message);
  } finally {
    $('runAllBtn').disabled = false;
    if (spanEl) spanEl.textContent = old || '全部检查';
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

/* ── 自动刷新 ─────────────────── */
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

/* ── 启动 ──────────────────────── */
(async function init() {
  var pwd = getToken();
  if (!pwd) { showLogin(); return; }
  try {
    var r = await fetch('/api/state', { headers: { 'X-Auth-Token': pwd } });
    if (r.status === 401) { clearToken(); showLogin(); return; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var data = await r.json();
    hideLogin();
    $('app').style.display = '';
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
