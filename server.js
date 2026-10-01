'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SITE_NAME = 'Canopy';
const HOME_HEADING = 'Recommended';
const HOME_TITLE = 'Recommended Videos - Canopy';

const DB_FILE = path.join(DATA_DIR, 'db.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
const COOKIE = 'canopy_admin';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

fs.mkdirSync(AVATAR_DIR, { recursive: true });

// ---------- storage ----------

let db = { videos: [], channels: [] };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const byScore = (a, b) => b.score - a.score || b.addedAt.localeCompare(a.addedAt);

// ---------- YouTube parsing ----------

const VIDEO_ID = /^[\w-]{11}$/;

function parseUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  if (/^@[\w.\-\u00C0-\uFFFF]+$/.test(s)) return { type: 'channel', path: '/' + s };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (host === 'youtu.be' && VIDEO_ID.test(parts[0] || '')) return { type: 'video', id: parts[0] };
  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

  if (parts[0] === 'watch' && VIDEO_ID.test(u.searchParams.get('v') || '')) {
    return { type: 'video', id: u.searchParams.get('v') };
  }
  if (['shorts', 'live', 'embed', 'v'].includes(parts[0]) && VIDEO_ID.test(parts[1] || '')) {
    return { type: 'video', id: parts[1] };
  }
  if (parts[0] && parts[0].startsWith('@')) return { type: 'channel', path: '/' + parts[0] };
  if (['channel', 'c', 'user'].includes(parts[0]) && parts[1]) {
    return { type: 'channel', path: `/${parts[0]}/${parts[1]}` };
  }
  return null;
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function metaContent(html, prop) {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]*>`, 'i'));
  const m = tag && tag[0].match(/content="([^"]*)"/i);
  return m ? decodeEntities(m[1]) : null;
}

async function fetchVideo(id) {
  const item = {
    id,
    title: 'YouTube video',
    channelName: '',
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const j = await r.json();
      item.title = j.title || item.title;
      item.channelName = j.author_name || '';
    } else if (r.status === 404 || r.status === 400) {
      throw new Error('video not found');
    }
  } catch (e) {
    if (e.message === 'video not found') throw e;
    // Network hiccup: keep the video with placeholder metadata.
  }
  return item;
}

async function fetchChannel(channelPath) {
  const r = await fetch('https://www.youtube.com' + channelPath, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`channel page returned ${r.status}`);
  const html = await r.text();

  const canon = html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)
    || html.match(/"externalId":"(UC[\w-]{22})"/);
  if (!canon) throw new Error('could not find channel id');
  const id = canon[1];
  const name = metaContent(html, 'og:title') || 'YouTube channel';
  const image = metaContent(html, 'og:image');
  const handle = channelPath.startsWith('/@') ? decodeURIComponent(channelPath.slice(1)) : null;

  let avatar = image || '';
  if (image) {
    try {
      const small = image.replace(/=s\d+/, '=s240');
      const ar = await fetch(small, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (ar.ok) {
        const type = (ar.headers.get('content-type') || 'image/jpeg').split(';')[0];
        fs.writeFileSync(path.join(AVATAR_DIR, id), Buffer.from(await ar.arrayBuffer()));
        fs.writeFileSync(path.join(AVATAR_DIR, id + '.type'), type);
        avatar = `/avatars/${id}`;
      }
    } catch {
      // Fall back to hotlinking the remote image.
    }
  }

  return { id, name, handle, avatar, url: handle ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${id}` };
}

const searchCache = new Map();

async function searchChannels(q) {
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.results;

  // sp=EgIQAg%3D%3D is YouTube's "type: channel" search filter.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAg%253D%253D`;
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'SOCS=CAI; CONSENT=YES+' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`search returned ${r.status}`);
  const html = await r.text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('could not parse search results');

  const found = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || found.length >= 8) return;
    if (o.channelRenderer) { found.push(o.channelRenderer); return; }
    for (const v of Object.values(o)) walk(v);
  })(JSON.parse(m[1]));

  const results = found.map((c) => {
    const thumbs = c.thumbnail?.thumbnails || [];
    let avatar = thumbs.length ? thumbs[thumbs.length - 1].url : '';
    if (avatar.startsWith('//')) avatar = 'https:' + avatar;
    const base = c.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
    // YouTube puts the @handle and subscriber count in inconsistent fields.
    const texts = [c.subscriberCountText?.simpleText, c.videoCountText?.simpleText].filter(Boolean);
    return {
      id: c.channelId,
      name: c.title?.simpleText || '',
      handle: base.startsWith('/@') ? decodeURIComponent(base.slice(1)) : null,
      path: base || `/channel/${c.channelId}`,
      avatar,
      subs: texts.find((t) => /subscriber/i.test(t)) || '',
    };
  }).filter((c) => c.id);

  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return results;
}

const MAX_NOTE = 2000;
const cleanNote = (n) => String(n ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_NOTE);

async function addLink(raw, score, note) {
  const parsed = parseUrl(raw);
  if (!parsed) return { input: raw, ok: false, error: 'not a YouTube video or channel link' };
  try {
    if (parsed.type === 'video') {
      // A blank note never wipes an existing one when re-adding.
      const update = (v) => {
        v.score = score;
        if (note) v.note = note;
        save();
        return { input: raw, ok: true, type: 'video', title: v.title, updated: true };
      };
      const existing = db.videos.find((v) => v.id === parsed.id);
      if (existing) return update(existing);
      const v = await fetchVideo(parsed.id);
      const again = db.videos.find((x) => x.id === v.id);
      if (again) return update(again);
      db.videos.push({ ...v, score, note, addedAt: new Date().toISOString() });
      save();
      return { input: raw, ok: true, type: 'video', title: v.title };
    }
    const c = await fetchChannel(parsed.path);
    const existing = db.channels.find((x) => x.id === c.id);
    if (existing) {
      // Keep the @handle URL from an earlier paste if this one was a /channel/UC… link.
      const { handle, url } = c.handle ? c : existing;
      Object.assign(existing, c, { handle, url, score });
      save();
      return { input: raw, ok: true, type: 'channel', title: c.name, updated: true };
    }
    db.channels.push({ ...c, score, addedAt: new Date().toISOString() });
    save();
    return { input: raw, ok: true, type: 'channel', title: c.name };
  } catch (e) {
    return { input: raw, ok: false, error: e.message };
  }
}

// ---------- auth ----------

const token = ADMIN_PASSWORD
  ? crypto.createHmac('sha256', ADMIN_PASSWORD).update('canopy-admin-v1').digest('hex')
  : null;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isAdmin = (req) => !!token && safeEqual(cookies(req)[COOKIE] || '', token);
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

// ---------- HTML ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const BASE_CSS = fs.readFileSync(path.join(__dirname, 'public', 'base.css'), 'utf8');

function page(title, body, extraHead = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0b0b0c">
<title>${esc(title)}</title>
<style>${BASE_CSS}</style>
${extraHead}
</head>
<body>
${body}
</body>
</html>`;
}

function renderHome() {
  const channels = [...db.channels].sort(byScore);
  const videos = [...db.videos].sort(byScore);

  const channelHtml = channels.length
    ? `<section class="channels" aria-label="Channels">
  <div class="hscroll">
    ${channels.map((c) => `<a class="channel" href="${esc(c.url)}" target="_blank" rel="noopener">
      <img src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span>${esc(c.name)}</span>
    </a>`).join('\n    ')}
  </div>
</section>`
    : '';

  const videoHtml = videos.length
    ? `<section class="grid" aria-label="Videos">
  ${videos.map((v) => `<article class="video">
    <a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">
      <div class="thumb"><img src="${esc(v.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>
      <div class="vtitle">${esc(v.title)}</div>
      ${v.channelName ? `<div class="vchan">${esc(v.channelName)}</div>` : ''}
    </a>
    ${v.note ? `<p class="vnote">${esc(v.note)}</p>` : ''}
  </article>`).join('\n  ')}
</section>`
    : '';

  const empty = !channels.length && !videos.length ? '<p class="empty">Nothing here yet.</p>' : '';

  return page(HOME_TITLE, `<header class="top"><h1>${esc(HOME_HEADING)}</h1></header>
<main>
${channelHtml}
${videoHtml}
${empty}
</main>`);
}

function renderLogin(error) {
  return page(`Sign in · ${SITE_NAME}`, `<main class="login">
  <form method="post" action="/edit/login">
    <h1>${esc(SITE_NAME)}</h1>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
    <button type="submit">Sign in</button>
  </form>
</main>`);
}

const EDIT_HTML = fs.readFileSync(path.join(__dirname, 'public', 'edit.html'), 'utf8');

// ---------- HTTP ----------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function clampScore(n) {
  const s = Math.round(Number(n));
  return Number.isFinite(s) ? Math.min(100, Math.max(0, s)) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && p === '/') return send(res, 200, renderHome(), { 'Cache-Control': 'no-cache' });

  if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

  if (req.method === 'GET' && p.startsWith('/avatars/')) {
    const id = p.slice('/avatars/'.length);
    if (!/^UC[\w-]{22}$/.test(id)) return send(res, 404, 'not found');
    try {
      const buf = fs.readFileSync(path.join(AVATAR_DIR, id));
      let type = 'image/jpeg';
      try { type = fs.readFileSync(path.join(AVATAR_DIR, id + '.type'), 'utf8'); } catch {}
      return send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    } catch {
      return send(res, 404, 'not found');
    }
  }

  // --- admin ---
  if (p === '/edit' || p.startsWith('/edit/') || p.startsWith('/api/')) {
    if (!token) return send(res, 503, page('Disabled', '<main class="login"><p>Set ADMIN_PASSWORD to enable editing.</p></main>'));

    if (req.method === 'POST' && p === '/edit/login') {
      const form = new URLSearchParams(await readBody(req));
      if (!safeEqual(form.get('password') || '', ADMIN_PASSWORD)) {
        await sleep(1000);
        return send(res, 401, renderLogin('Wrong password.'));
      }
      const cookie = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`;
      return send(res, 303, '', { Location: '/edit', 'Set-Cookie': cookie });
    }

    if (req.method === 'POST' && p === '/edit/logout') {
      return send(res, 303, '', { Location: '/', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    }

    if (!isAdmin(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      return send(res, 200, renderLogin(), { 'Cache-Control': 'no-store' });
    }

    if (req.method === 'GET' && p === '/edit') {
      return send(res, 200, page(`Edit · ${SITE_NAME}`, EDIT_HTML), { 'Cache-Control': 'no-store' });
    }

    if (p.startsWith('/api/')) {
      // JSON-only API: cross-site forms can't send application/json without a CORS preflight.
      if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { error: 'expected application/json' });
      }

      if (req.method === 'GET' && p === '/api/items') {
        return json(res, 200, { channels: [...db.channels].sort(byScore), videos: [...db.videos].sort(byScore) });
      }

      if (req.method === 'GET' && p === '/api/search-channels') {
        const q = (url.searchParams.get('q') || '').trim().replace(/^@/, '').slice(0, 100);
        if (!q) return json(res, 200, { results: [] });
        try {
          const results = (await searchChannels(q)).map((c) => {
            const saved = db.channels.find((x) => x.id === c.id);
            return { ...c, score: saved ? saved.score : null };
          });
          return json(res, 200, { results });
        } catch (e) {
          return json(res, 502, { error: e.message });
        }
      }

      if (req.method === 'POST' && p === '/api/items') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const score = clampScore(body.score ?? 80);
        if (score === null) return json(res, 400, { error: 'bad score' });
        const links = String(body.text || '').match(/\S+/g) || [];
        if (!links.length) return json(res, 400, { error: 'no links' });
        const results = [];
        const note = cleanNote(body.note);
        for (const link of links.slice(0, 50)) results.push(await addLink(link, score, note));
        return json(res, 200, { results });
      }

      const m = p.match(/^\/api\/(videos|channels)\/([\w-]+)$/);
      if (m) {
        const list = db[m[1]];
        const idx = list.findIndex((x) => x.id === m[2]);
        if (idx < 0) return json(res, 404, { error: 'not found' });
        if (req.method === 'PATCH') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if ('score' in body) {
            const score = clampScore(body.score);
            if (score === null) return json(res, 400, { error: 'bad score' });
            list[idx].score = score;
          }
          if ('note' in body && m[1] === 'videos') list[idx].note = cleanNote(body.note);
          save();
          return json(res, 200, list[idx]);
        }
        if (req.method === 'DELETE') {
          const [removed] = list.splice(idx, 1);
          save();
          if (m[1] === 'channels') {
            for (const f of [removed.id, removed.id + '.type']) fs.rmSync(path.join(AVATAR_DIR, f), { force: true });
          }
          return json(res, 200, { ok: true });
        }
      }
      return json(res, 404, { error: 'not found' });
    }
  }

  return send(res, 404, page('Not found', '<main class="login"><p>Not found. <a href="/">Home</a></p></main>'));
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    else res.end();
  });
}).listen(PORT, () => {
  console.log(`listening on :${PORT}, data in ${DATA_DIR}${token ? '' : ' (ADMIN_PASSWORD not set; /edit disabled)'}`);
});
