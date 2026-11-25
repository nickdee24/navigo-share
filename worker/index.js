// NaviGO Share trip on Cloudflare (Workers + one Durable Object).
// Same website and the same /api as server.js (Render), but it never goes to sleep and keeps everything
// (links, photos, updates) through deploys. Also receives the council roadworks feed (DfT Street Manager).
//
// Files in /public are served straight from Cloudflare; everything else comes here. All the trip data lives in
// one Durable Object ("Hub"), which plays the part server.js's memory used to.
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { createVerify, X509Certificate } from 'node:crypto';

const SHARE_ID_RE = /^[A-Za-z0-9]{8,16}$/;
const SHARE_KEY_RE = /^[a-f0-9]{24,48}$/;
const SHARE_KEEP_MS = 30 * 86400000;     // forget a link nobody has used for 30 days
const SHARE_STALE_MS = 12 * 3600000;     // a share with no update for 12 h counts as ended

const json = (code, body, extra) => new Response(JSON.stringify(body), { status: code,
  headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, extra || {}) });
const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);
const rid = () => Math.random().toString(36).slice(2, 10);
const b64ToBytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function readJSON(req) { try { const t = await req.text(); if (t.length > 2e5) return null; return JSON.parse(t || '{}'); } catch { return null; } }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return json(200, { ok: true });
    if (url.pathname === '/config.js') {
      return new Response('window.MAPBOX_TOKEN = ' + JSON.stringify(env.MAPBOX_TOKEN || '') + ';window.GMAPS_KEY = ' + JSON.stringify(env.GOOGLE_MAPS_KEY || '') +
        ';window.TOMTOM_KEY = ' + JSON.stringify(env.TOMTOM_KEY || '') + ';', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' } });
    }
    if (url.pathname === '/plan' || url.pathname === '/plan/') return env.ASSETS.fetch(new Request(new URL('/plan.html', url), req));
    // Listen along: the radio stream is passed through here (outside the Durable Object)
    const listen = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/listen$/);
    if (listen) {
      const info = await hub(env).fetch(new Request(new URL('/internal/radio/' + listen[1], url)));
      if (!info.ok) return new Response(null, { status: 404 });
      const { url: radioUrl } = await info.json();
      return listenAlong(radioUrl);
    }
    // the share page itself, with a link preview (title, map picture)
    const trip = url.pathname.match(/^\/t\/([A-Za-z0-9]{8,16})\/?$/);
    if (trip) {
      const page = await env.ASSETS.fetch(new Request(new URL('/trip.html', url), req));
      let html = await page.text();
      const meta = await hub(env).fetch(new Request(new URL('/internal/preview/' + trip[1], url)));
      if (meta.ok) html = html.replace('</head>', await meta.text() + '</head>');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    // Council roadworks PAUSED (Nick, 25 Nov): messages are thrown away and none are given out. The subscription itself is left
    // alone, so switching this to false starts it again (signature checks are in the Hub).
    const ROADWORKS_PAUSED = true;
    if (ROADWORKS_PAUSED && url.pathname === '/api/streetmanager') return json(200, { paused: true });   // (never confirms anything)
    if (ROADWORKS_PAUSED && url.pathname === '/api/roadworks') return json(200, { works: [], paused: true });
    if (url.pathname.startsWith('/api/')) return hub(env).fetch(req);
    return env.ASSETS.fetch(req);
  },
};

const hub = env => env.HUB.get(env.HUB.idFromName('main'));

/** Pass a radio stream through (many stations are plain http or answer "ICY 200 OK", which fetch can't read). */
async function listenAlong(radioUrl, hops = 0) {
  let u; try { u = new URL(radioUrl); } catch { return new Response(null, { status: 502 }); }
  const secure = u.protocol === 'https:';
  const sock = connect({ hostname: u.hostname, port: +u.port || (secure ? 443 : 80) }, { secureTransport: secure ? 'on' : 'off' });
  const w = sock.writable.getWriter();
  await w.write(new TextEncoder().encode('GET ' + (u.pathname || '/') + u.search + ' HTTP/1.0\r\nHost: ' + u.host +
    '\r\nUser-Agent: NaviGO-Share/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n'));
  w.releaseLock();
  const reader = sock.readable.getReader();
  let head = new Uint8Array(0), end = -1;
  while (end < 0) {
    const { value, done } = await reader.read();
    if (done) return new Response(null, { status: 502 });
    const n = new Uint8Array(head.length + value.length); n.set(head); n.set(value, head.length); head = n;
    for (let i = 0; i + 3 < head.length; i++) if (head[i] === 13 && head[i + 1] === 10 && head[i + 2] === 13 && head[i + 3] === 10) { end = i; break; }
    if (end < 0 && head.length > 16384) return new Response(null, { status: 502 });
  }
  const lines = new TextDecoder('latin1').decode(head.slice(0, end)).split('\r\n');
  const status = +(lines[0].split(' ')[1] || 0), hdr = {};
  lines.slice(1).forEach(l => { const i = l.indexOf(':'); if (i > 0) hdr[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
  if (status >= 300 && status < 400 && hdr.location && hops < 4) { sock.close(); return listenAlong(new URL(hdr.location, u).href, hops + 1); }
  if (status !== 200) { sock.close(); return new Response(null, { status: 502 }); }
  let type = (hdr['content-type'] || 'audio/mpeg').split(';')[0];
  if (!/^(audio|application\/ogg)/.test(type)) type = 'audio/mpeg';
  const first = head.slice(end + 4);
  const body = new ReadableStream({
    start(c) { if (first.length) c.enqueue(first); },
    async pull(c) { const { value, done } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
    cancel() { sock.close(); },
  });
  return new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

// ======================================================================================================
// The Hub: every shared trip, messages, place alerts, and the council roadworks near NaviGO's area.
// ======================================================================================================
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.db = { shares: {} };
    this.works = {};          // council roadworks: ref -> { lat, lng, street, ... }
    this.caches = { preview: new Map(), yt: new Map(), ytSearch: new Map(), place: new Map(), map: {} };
    this.spotify = { token: null, until: 0 };
    ctx.blockConcurrencyWhile(async () => {
      this.db = (await ctx.storage.get('db')) || { shares: {} };
      this.db.shares ||= {};
      // each roadwork is its own row (one big value would outgrow the 2 MB limit)
      for (const [k, v] of await ctx.storage.list({ prefix: 'w:' })) this.works[k.slice(2)] = v;
      this.sm = (await ctx.storage.get('sm')) || { account: null, topics: {} };
    });
  }

  save() {
    // write at most every couple of seconds (many updates a second while driving)
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => { this.saveTimer = null; await this.ctx.storage.put('db', this.db); }, 2000);
    this.ctx.storage.getAlarm().then(a => { if (!a) this.ctx.storage.setAlarm(Date.now() + 10 * 60000); });
  }
  dropWork(ref) { if (this.works[ref]) { delete this.works[ref]; this.ctx.storage.delete('w:' + ref); } }

  // every 10 minutes: tidy old links and finished roadworks
  async alarm() {
    const now = Date.now();
    for (const [id, t] of Object.entries(this.db.shares)) {
      if (now - Math.max(t.updatedAt || 0, t.eventAt || 0) > SHARE_KEEP_MS) delete this.db.shares[id];
      else if (!t.endedAt && now - (t.updatedAt || 0) > SHARE_STALE_MS) endShare(t, false);
    }
    for (const [ref, w] of Object.entries(this.works)) if (w.end && w.end < now - (w.activity ? 0 : 14 * 86400000)) this.dropWork(ref);
    await this.ctx.storage.put('db', this.db);
    await this.ctx.storage.setAlarm(now + 10 * 60000);
  }

  async fetch(req) {
    const url = new URL(req.url), p = url.pathname, db = this.db;
    // ---------- internal (from the Worker) ----------
    let m;
    if ((m = p.match(/^\/internal\/radio\/(.+)$/))) {
      const t = db.shares[m[1]];
      return t && !t.endedAt && t.radioUrl ? json(200, { url: t.radioUrl }) : json(404, {});
    }
    if ((m = p.match(/^\/internal\/preview\/(.+)$/))) return new Response(this.preview(m[1], url));

    if (p === '/api/version') {
      let app = null;
      try { app = await (await this.env.ASSETS.fetch(new Request(new URL('/app/navigo-live.json', url)))).json(); } catch {}
      return json(200, { site: this.env.CF_VERSION_METADATA ? this.env.CF_VERSION_METADATA.id : 'cf', app });
    }
    if (p === '/api/music/youtube') return this.youtubeSearch(url);
    if (p === '/api/music/search') {
      const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
      if (!q) return json(400, { error: 'Type something to search for' });
      try { return json(200, await this.musicSearch(q)); } catch (e) { return json(502, { error: e.message }); }
    }
    // ---------- council roadworks (DfT Street Manager) ----------
    if (p === '/api/streetmanager' && req.method === 'POST') return this.streetManager(req);
    if (p === '/api/roadworks') return this.roadworks(url);

    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/msg$/)) && req.method === 'POST') {
      const t = db.shares[m[1]], b = await readJSON(req);
      if (!t || t.endedAt) return json(404, { error: 'Not sharing right now' });
      if (!b) return json(400, { error: 'Bad JSON' });
      const viewer = String(b.viewer || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24), text = String(b.text || '').trim().slice(0, 140);
      if (!viewer || !text) return json(400, { error: 'Type a message first' });
      t.inbox = t.inbox || [];
      const last = t.inbox.filter(x => x.viewer === viewer).pop();
      if (last && Date.now() - last.at < 3000) return json(429, { error: 'Slow down a little' });
      const msg = { id: rid(), viewer, from: String(b.from || '').trim().slice(0, 30) || 'Someone', text, emote: !!b.emote, at: Date.now() };
      t.inbox.push(msg);
      if (t.inbox.length > 30) t.inbox.splice(0, t.inbox.length - 30);
      this.save();
      return json(200, { ok: true, id: msg.id });
    }
    if (p === '/api/share/reply' && req.method === 'POST') {
      const b = await readJSON(req);
      if (!b) return json(400, { error: 'Bad JSON' });
      const t = db.shares[String(b.id || '')];
      if (!t || t.key !== String(b.key || '')) return json(403, { error: 'Wrong key' });
      const msg = (t.inbox || []).find(x => x.id === String(b.msgId || ''));
      if (!msg) return json(404, { error: 'No such message' });
      const kind = b.kind === 'emote' ? 'emote' : b.kind === 'text' ? 'text' : 'ack';
      msg.reply = { kind, at: Date.now(), text: kind === 'text' ? String(b.text || '').trim().slice(0, 200) : undefined };
      this.save();
      return json(200, { ok: true });
    }
    if (p === '/api/share/event' && req.method === 'POST') {
      const b = await readJSON(req);
      const t = this.owned(b, true); if (t instanceof Response) return t;
      const text = String(b.text || '').trim().slice(0, 80);
      if (!text) return json(400, { error: 'No text' });
      const ev = { id: rid(), text, kind: String(b.kind || '').slice(0, 20), at: Date.now() };
      t.events = (t.events || []).concat(ev).slice(-20); t.eventAt = ev.at;
      this.save();
      return json(200, { ok: true, id: ev.id });
    }
    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/youtube$/))) return this.shareYoutube(m[1]);
    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/preview$/))) return this.sharePreview(m[1]);
    if (p === '/api/share/clear' && req.method === 'POST') {
      const b = await readJSON(req);
      if (!b) return json(400, { error: 'Bad JSON' });
      const id = String(b.id || ''), key = String(b.key || '');
      if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(400, { error: 'Bad id or key' });
      const t = db.shares[id];
      if (t && t.key !== key) return json(403, { error: 'Wrong key' });
      if (t) { t.events = []; this.save(); }
      return json(200, { ok: true });
    }
    if (p === '/api/share/checkin' && req.method === 'POST') {
      const b = await readJSON(req);
      const t = this.owned(b, true); if (t instanceof Response) return t;
      t.name = String(b.name || t.name || 'Someone').slice(0, 30);
      const lat = num(b.lat), lng = num(b.lng);
      const home = !!b.home, place = home ? 'home' : String(b.place || '').trim().slice(0, 60);
      const addEvent = (text, kind) => { const ev = { id: rid(), text, kind, at: Date.now() }; t.events = (t.events || []).concat(ev).slice(-20); t.eventAt = ev.at; };
      if (!b.out && place && lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        const same = t.checkin && t.checkin.place === place;
        t.checkin = { place, lat, lng, at: same ? t.checkin.at : Date.now() };
        if (!same) addEvent(home ? 'Checked in at home' : 'Arrived at ' + place, home ? 'home_checkin' : 'place_arrived');
      } else {
        if (t.checkin && t.checkin.place !== 'home') addEvent('Left ' + t.checkin.place, 'place_left');
        t.checkin = null;
      }
      t.eventAt = Math.max(t.eventAt || 0, Date.now());
      this.save();
      return json(200, { ok: true });
    }
    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/map\.png$/))) return this.staticMap(m[1]);
    if ((m = p.match(/^\/api\/share\/(update|end)$/)) && req.method === 'POST') return this.shareApi(req, m[1]);
    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/photo$/))) {
      const t = db.shares[m[1]];
      if (!t || !t.photo) return new Response(null, { status: 404 });
      return new Response(b64ToBytes(t.photo), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' } });
    }
    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/radiologo$/))) {
      const t = db.shares[m[1]];
      if (!t || !t.radioLogo) return new Response(null, { status: 404 });
      return new Response(b64ToBytes(t.radioLogo), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' } });
    }
    if ((m = p.match(/^\/api\/share\/([A-Za-z0-9]{8,16})$/))) {
      const t = db.shares[m[1]];
      if (t && url.searchParams.get('w') === '1') t.watchedAt = Date.now();
      if (!t) return json(404, { error: 'Nothing shared on this link yet.' });
      const viewer = String(url.searchParams.get('viewer') || '');
      const replies = viewer ? (t.inbox || []).filter(x => x.viewer === viewer && x.reply && !x.replyShown) : [];
      if (replies.length) { replies.forEach(x => { x.replyShown = Date.now(); }); this.save(); }
      return json(200, Object.assign(publicShare(t), {
        replies: replies.map(x => ({ msgId: x.id, kind: x.reply.kind, text: x.text, emote: x.emote, replyText: x.reply.text || null })) }));
    }
    return json(404, { error: 'Not found' });
  }

  /** The share for an id + key in the body (made if [create] and it doesn't exist yet), or an error response. */
  owned(b, create) {
    if (!b) return json(400, { error: 'Bad JSON' });
    const id = String(b.id || ''), key = String(b.key || '');
    if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(400, { error: 'Bad id or key' });
    let t = this.db.shares[id];
    if (t && t.key !== key) return json(403, { error: 'Wrong key' });
    if (!t && create) t = this.db.shares[id] = { key, startedAt: Date.now(), endedAt: Date.now(), name: String(b.name || 'Someone').slice(0, 30) };
    return t;
  }

  async shareApi(req, action) {
    const b = await readJSON(req);
    if (!b) return json(400, { error: 'Bad JSON' });
    const id = String(b.id || ''), key = String(b.key || '');
    if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(400, { error: 'Bad id or key' });
    const db = this.db;
    let t = db.shares[id];
    if (t && t.key !== key) return json(403, { error: 'Wrong key' });
    if (action === 'end') {
      if (t && b.forget) { delete db.shares[id]; this.save(); }
      else if (t && !t.endedAt) { endShare(t, b.arrived); this.save(); }
      return json(200, { ok: true });
    }
    if (!t) t = db.shares[id] = { key, startedAt: Date.now() };
    if (t.endedAt) { t.startedAt = Date.now(); t.endedAt = null; t.arrived = false; t.photoV = (t.photoV || 0) + 1; }
    t.name = String(b.name || 'Someone').slice(0, 30);
    t.mood = String(b.mood || '').slice(0, 16);
    t.emoji = String(b.emoji || '').slice(0, 16);
    if (b.music && b.music.title) {
      t.music = { title: String(b.music.title).slice(0, 80), artist: String(b.music.artist || '').slice(0, 60),
        player: String(b.music.player || '').slice(0, 12), playing: !!b.music.playing, pos: num(b.music.pos), dur: num(b.music.dur), at: Date.now() };
    } else if (b.music !== undefined) t.music = null;
    if (b.radio && b.radio.name) {
      const name = String(b.radio.name).slice(0, 60);
      if (!t.radio || t.radio.name !== name) { t.radioLogo = null; t.radioLogoV = (t.radioLogoV || 0) + 1; }
      t.radio = { name, genre: String(b.radio.genre || '').slice(0, 40), playing: !!b.radio.playing };
      t.radioUrl = typeof b.radio.url === 'string' && /^https?:\/\/[^\s]{4,500}$/.test(b.radio.url) ? b.radio.url : null;
      if (typeof b.radio.logo === 'string' && b.radio.logo.length < 80000 && /^[A-Za-z0-9+/=]+$/.test(b.radio.logo)) {
        t.radioLogo = b.radio.logo; t.radioLogoV = (t.radioLogoV || 0) + 1;
      }
    } else if (b.radio !== undefined) { t.radio = null; t.radioLogo = null; t.radioUrl = null; }
    if (b.battery && isFinite(+b.battery.pct)) t.battery = { pct: Math.max(0, Math.min(100, Math.round(+b.battery.pct))), charging: !!b.battery.charging,
      slow: !!b.battery.slow, saver: !!b.battery.saver, at: Date.now() };
    t.parked = !!b.parked;   // the page checks less often while they're parked
    if (b.activity !== undefined) t.activity = ['driving', 'stopped', 'walking'].includes(b.activity) ? b.activity : null;
    const lat = num(b.lat), lng = num(b.lng);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      t.lat = lat; t.lng = lng; t.heading = num(b.heading); t.speed = num(b.speed); t.updatedAt = Date.now();
      this.updatePlace(t);
    } else t.updatedAt = Date.now();
    if (b.dest && isFinite(+b.dest.lat) && isFinite(+b.dest.lng)) {
      t.dest = { name: String(b.dest.name || 'Destination').slice(0, 80), lat: +b.dest.lat, lng: +b.dest.lng };
    } else if (b.dest === null) {
      if (t.dest || t.route) t.routeV = (t.routeV || 0) + 1;
      t.dest = null; t.route = null;
    }
    t.eta = num(b.eta); t.remainingM = num(b.remainingM);
    if (b.stop && isFinite(+b.stop.lat) && isFinite(+b.stop.lng)) {
      t.stop = { name: String(b.stop.name || 'Stop').slice(0, 80), lat: +b.stop.lat, lng: +b.stop.lng, eta: num(b.stop.eta), remainingM: num(b.stop.remainingM) };
    } else if (b.stop !== undefined) t.stop = null;
    if (b.route !== undefined) { t.route = b.route ? cleanRoute(b.route) : null; t.routeV = (t.routeV || 0) + 1; }
    if (typeof b.photo === 'string' && b.photo.length < 60000 && /^[A-Za-z0-9+/=]+$/.test(b.photo)) { t.photo = b.photo; t.photoV = (t.photoV || 0) + 1; }
    if (b.photo === null) t.photo = null;
    const inbox = (t.inbox || []).filter(x => !x.delivered);
    inbox.forEach(x => { x.delivered = Date.now(); });
    this.save();
    return json(200, { ok: true, url: '/t/' + id, needRoute: !!(t.dest && !t.route), needPhoto: !!b.wantPhoto && !t.photo,
      needRadioLogo: !!(t.radio && !t.radioLogo),
      inbox: inbox.map(x => ({ id: x.id, from: x.from, text: x.text, emote: x.emote, at: x.at })),
      watching: !!(t.watchedAt && Date.now() - t.watchedAt < 35000) });
  }

  // ---------- street and town (OpenStreetMap's Nominatim, at most 1 a second, cached) ----------
  updatePlace(t) {
    if (t.lat == null || t.placeBusy) return;
    if (t.placeAt && Math.hypot(t.lat - t.placeAt[0], (t.lng - t.placeAt[1]) * Math.cos(t.lat * Math.PI / 180)) < 0.00135) return;
    if (this.lastNominatim && Date.now() - this.lastNominatim < 1100) return;
    t.placeBusy = true;
    const at = [t.lat, t.lng];
    const key = at[0].toFixed(3) + ',' + at[1].toFixed(3);
    const cached = this.caches.place.get(key);
    const done = place => { if (place) { t.place = place; t.placeAt = at; } t.placeBusy = false; };
    if (cached) return done(cached);
    this.lastNominatim = Date.now();
    this.ctx.waitUntil(fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${at[0]}&lon=${at[1]}`,
      { headers: { 'User-Agent': 'NaviGO-ShareTrip/1.0 (personal trip sharing)', 'Accept-Language': 'en-GB' } })
      .then(r => r.ok ? r.json() : null).then(j => {
        if (!j) return done(null);
        const a = j.address || {};
        const road = a.road || a.pedestrian || a.residential || null;
        const area = a.suburb || a.village || a.town || a.city_district || a.neighbourhood || a.hamlet || null;
        const town = a.town || a.city || a.village || a.county || null;
        const place = { road, area: area && area !== town ? area : null, town };
        this.caches.place.set(key, place);
        if (this.caches.place.size > 3000) this.caches.place.delete(this.caches.place.keys().next().value);
        done(place);
      }).catch(() => done(null)));
  }

  // ---------- link preview tags ----------
  preview(id, url) {
    const t = this.db.shares[id];
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const who = t && t.name ? t.name : 'Someone';
    const live = t && !t.endedAt && t.lat != null;
    return '<meta property="og:title" content="' + esc(who + (live ? "'s live trip" : ' on NaviGO')) + '">' +
      '<meta property="og:description" content="' + esc(live && t.dest ? 'On the way to ' + t.dest.name : 'See where they are on the map') + '">' +
      (live && this.env.TOMTOM_KEY ? '<meta property="og:image" content="' + url.origin + '/api/share/' + id + '/map.png">' +
        '<meta property="og:image:width" content="600"><meta property="og:image:height" content="315"><meta name="twitter:card" content="summary_large_image">' : '');
  }
  async staticMap(id) {
    const t = this.db.shares[id], key = this.env.TOMTOM_KEY;
    if (!key || !t || t.endedAt || t.lat == null) return new Response(null, { status: 404 });
    const c = this.caches.map[id];
    if (c && Date.now() - c.at < 60000) return new Response(c.png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' } });
    try {
      const r = await fetch('https://api.tomtom.com/map/1/staticimage?key=' + encodeURIComponent(key) +
        '&center=' + t.lng.toFixed(5) + ',' + t.lat.toFixed(5) + '&zoom=14&width=600&height=315&format=png&layer=basic&style=night&view=Unified');
      if (!r.ok) throw new Error('status ' + r.status);
      const png = await r.arrayBuffer();
      this.caches.map[id] = { at: Date.now(), png };
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' } });
    } catch { return new Response(null, { status: 502 }); }
  }

  // ---------- music ----------
  async youtubeSearch(url) {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(400, { error: 'Type something to search for' });
    const ytKey = this.env.YOUTUBE_KEY;
    if (!ytKey) return json(503, { error: 'not-set-up' });
    const hit = this.caches.ytSearch.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 3600000) return json(200, hit.body);
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=12&regionCode=GB&q='
        + encodeURIComponent(q) + '&key=' + encodeURIComponent(ytKey), { headers: { Referer: url.origin + '/' } });
      const j = await r.json();
      if (j.error) return json(503, { error: j.error.message || 'YouTube search failed' });
      const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const items = (j.items || []).filter(x => x.id && x.id.videoId).map(x => {
        const ch = dec(x.snippet.channelTitle), topic = / - Topic$/.test(ch);
        return { name: dec(x.snippet.title), uri: 'ytm:' + x.id.videoId, artists: ch.replace(/ - Topic$/, ''), album: topic ? 'YouTube Music' : '',
          image: ((x.snippet.thumbnails || {}).default || {}).url || null, durationMs: 0, topic };
      });
      items.sort((a, b) => (b.topic ? 1 : 0) - (a.topic ? 1 : 0));
      const body = { source: 'youtube', artists: [], tracks: items.slice(0, 10) };
      this.caches.ytSearch.set(q.toLowerCase(), { at: Date.now(), body });
      if (this.caches.ytSearch.size > 200) this.caches.ytSearch.delete(this.caches.ytSearch.keys().next().value);
      return json(200, body);
    } catch (e) { return json(502, { error: e.message }); }
  }
  async musicSearch(q) {
    try { return await this.spotifySearch(q); }
    catch (e) {
      const r = await fetch('https://itunes.apple.com/search?media=music&entity=song&limit=10&country=GB&term=' + encodeURIComponent(q));
      if (!r.ok) throw new Error('Song search failed (' + r.status + ')');
      const j = await r.json();
      return { source: 'itunes', artists: [], tracks: (j.results || []).map(t => ({ name: t.trackName, uri: '', artists: t.artistName,
        album: t.collectionName, image: (t.artworkUrl100 || '').replace('100x100', '120x120') || null, durationMs: t.trackTimeMillis || 0 })) };
    }
  }
  async spotifySearch(q) {
    const id = this.env.SPOTIFY_CLIENT_ID, secret = this.env.SPOTIFY_CLIENT_SECRET;
    if (!id || !secret) throw new Error('no Spotify key');
    if (!this.spotify.token || Date.now() > this.spotify.until) {
      const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(id + ':' + secret) }, body: 'grant_type=client_credentials' });
      if (!r.ok) throw new Error('Spotify login failed (' + r.status + ')');
      const j = await r.json();
      this.spotify = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
    }
    const r = await fetch('https://api.spotify.com/v1/search?type=track,artist&limit=10&market=GB&q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + this.spotify.token } });
    if (r.status === 401) { this.spotify.token = null; throw new Error('Spotify key expired'); }
    if (!r.ok) throw new Error('Spotify search failed (' + r.status + ')');
    const j = await r.json();
    const img = imgs => { const s = (imgs || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0)); return (s.find(i => (i.width || 0) >= 64) || s[s.length - 1] || {}).url || null; };
    return { source: 'spotify',
      artists: ((j.artists && j.artists.items) || []).slice(0, 3).map(a => ({ name: a.name, uri: a.uri, image: img(a.images) })),
      tracks: ((j.tracks && j.tracks.items) || []).map(t => ({ name: t.name, uri: t.uri, artists: t.artists.map(a => a.name).join(', '),
        album: t.album && t.album.name, image: img(t.album && t.album.images), durationMs: t.duration_ms })) };
  }
  async shareYoutube(id) {
    const t = this.db.shares[id], mu = t && !t.endedAt && t.music;
    if (!mu || !mu.title) return json(404, { error: 'No song playing' });
    const ytKey = this.env.YOUTUBE_KEY || this.env.GOOGLE_MAPS_KEY;
    if (!ytKey) return json(503, { error: 'No YouTube key' });
    const key = (mu.artist || '') + '|' + mu.title;
    let hit = this.caches.yt.get(key);
    if (hit && Date.now() - hit.at > 86400000) hit = null;
    if (!hit) {
      try {
        const q = encodeURIComponent(((mu.artist || '') + ' ' + mu.title + ' audio').trim());
        const r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&videoCategoryId=10&q=' + q + '&key=' + encodeURIComponent(ytKey));
        const j = await r.json();
        if (j.error) return json(503, { error: 'YouTube search not available' });
        const items = (j.items || []).filter(x => x.id && x.id.videoId);
        const best = items.find(x => /- Topic$/.test(x.snippet.channelTitle)) || items.find(x => /official audio/i.test(x.snippet.title)) || items[0];
        hit = best ? { videoId: best.id.videoId, title: best.snippet.title, at: Date.now() } : { none: true, at: Date.now() };
      } catch { return json(502, { error: 'YouTube search failed' }); }
      this.caches.yt.set(key, hit);
      if (this.caches.yt.size > 300) this.caches.yt.delete(this.caches.yt.keys().next().value);
    }
    if (hit.none) return json(404, { error: 'Not found on YouTube' });
    return json(200, { videoId: hit.videoId, title: hit.title });
  }
  async sharePreview(id) {
    const t = this.db.shares[id], mu = t && !t.endedAt && t.music;
    if (!mu || !mu.title) return json(404, { error: 'No song playing' });
    const key = (mu.artist || '') + '|' + mu.title;
    let hit = this.caches.preview.get(key);
    if (hit && Date.now() - hit.at > 600000) hit = null;
    if (!hit) {
      try {
        const r = await fetch('https://api.deezer.com/search?limit=8&q=' + encodeURIComponent(((mu.artist || '') + ' ' + mu.title).trim()));
        const list = (await r.json()).data || [];
        const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\..*$|[^a-z0-9 ]/g, '').trim();
        const want = norm(mu.title), who = norm(mu.artist);
        const best = list.find(x => x.preview && norm(x.title).startsWith(want) && (!who || norm(x.artist && x.artist.name).includes(who.split(' ')[0])))
          || list.find(x => x.preview && norm(x.title).startsWith(want)) || null;
        hit = best ? { url: best.preview, title: best.title, artist: best.artist ? best.artist.name : '', at: Date.now() } : { none: true, at: Date.now() };
      } catch { return json(502, { error: 'Preview search failed' }); }
      this.caches.preview.set(key, hit);
      if (this.caches.preview.size > 300) this.caches.preview.delete(this.caches.preview.keys().next().value);
    }
    if (hit.none) return json(404, { error: 'No preview for this song' });
    return json(200, { url: hit.url, title: hit.title, artist: hit.artist });
  }

  // ---------- council roadworks: DfT Street Manager open data, pushed here through Amazon SNS ----------
  // Only messages signed by Amazon are read, and only from the AWS account that Street Manager's first confirmation
  // came from (anyone can have a genuine Amazon signature, so the signature alone isn't enough).
  async streetManager(req) {
    let msg; try { const t = await req.text(); if (t.length > 300000) return json(413, {}); msg = JSON.parse(t); } catch { return json(400, {}); }
    const arn = /^arn:aws:sns:eu-west-2:(\d{12}):([\w-]+)$/.exec(msg && msg.TopicArn || '');
    if (!arn || !(await this.snsSigned(msg))) return json(403, { error: 'Not a signed Street Manager message' });
    if (this.sm.account && this.sm.account !== arn[1]) return json(403, { error: 'Unknown sender' });
    if (msg.Type === 'SubscriptionConfirmation') {
      let u; try { u = new URL(msg.SubscribeURL); } catch { return json(400, {}); }
      if (u.protocol !== 'https:' || u.hostname !== 'sns.eu-west-2.amazonaws.com') return json(400, {});
      const ok = await fetch(u);
      if (!ok.ok) return json(502, { error: 'Could not confirm' });   // Amazon tries again
      this.sm.account = arn[1]; this.sm.topics[arn[2]] = Date.now();
      await this.ctx.storage.put('sm', this.sm);
      return json(200, { ok: true });
    }
    if (msg.Type !== 'Notification' || !this.sm.account) return json(200, { ok: true });
    this.smCount();
    let n; try { n = JSON.parse(msg.Message); } catch { return json(200, { ok: true }); }
    const d = n.object_data || {}, activity = n.object_type === 'ACTIVITY';
    if (n.object_type !== 'PERMIT' && !activity) return json(200, { ok: true });
    const ref = String(n.object_reference || '').slice(0, 60);
    if (!ref) return json(200, { ok: true });
    const at = Date.parse(n.event_time) || Date.now();
    if (this.works[ref] && this.works[ref].at > at) return json(200, { ok: true });   // an older message arriving late
    const tm = String(d.current_traffic_management_type_ref || d.traffic_management_type_ref || d.traffic_management_type || '').toLowerCase().replace(/[ -]/g, '_');
    const when = x => { const t = Date.parse(x || ''); return isFinite(t) ? t : null; };
    const end = when(d.actual_end_date_time || d.end_time || d.end_date || d.proposed_end_time || d.proposed_end_date);
    // only works really happening on the road: not planned ones, and not ones that stay on the pavement
    const on = activity ? d.cancelled !== 'Yes' && n.event_type !== 'ACTIVITY_CANCELLED' && d.traffic_management_required === 'Yes' : d.work_status_ref === 'in_progress';
    const pt = on && tm !== 'no_carriageway_incursion' && wktPoint(d.works_location_coordinates || d.activity_coordinates);
    if (!pt) { this.dropWork(ref); return json(200, { ok: true }); }
    const [lat, lng] = bngToWgs84(pt[0], pt[1]);
    // only keep the area NaviGO is used in (North West England and around), so the store stays small
    const A = (this.env.ROADWORKS_AREA || '52.6,-3.8,54.9,-1.2').split(',').map(Number);
    if (!(lat >= A[0] && lat <= A[2] && lng >= A[1] && lng <= A[3])) return json(200, { ok: true });
    const w = this.works[ref] = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), street: String(d.street_name || '').slice(0, 80), town: String(d.town || d.area_name || '').slice(0, 60),
      desc: String(d.activity_name || d.activity_type || 'Roadworks').slice(0, 160), tm: tm.slice(0, 40), who: String(d.promoter_organisation || '').slice(0, 60),
      start: when(d.actual_start_date_time || d.start_time || d.start_date), end, activity, at };
    await this.ctx.storage.put('w:' + ref, w);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 10 * 60000);
    return json(200, { ok: true });
  }
  /** How many messages came in today (the free plan allows 100,000 requests a day for everything). */
  smCount() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.smDay !== day) { this.smDay = day; this.smToday = 0; }
    this.smToday++;
  }
  async snsSigned(m) {
    try {
      const u = new URL(m.SigningCertURL);
      if (u.protocol !== 'https:' || u.hostname !== 'sns.eu-west-2.amazonaws.com' || !/^\/SimpleNotificationService-\w+\.pem$/.test(u.pathname) || u.search) return false;
      const keys = m.Type === 'Notification' ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : m.Type === 'SubscriptionConfirmation' ? ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] : null;
      const alg = { 1: 'RSA-SHA1', 2: 'RSA-SHA256' }[m.SignatureVersion];
      if (!keys || !alg) return false;
      this.certs ||= {};
      let pub = this.certs[u.href];
      if (!pub) {
        const r = await fetch(u); if (!r.ok) return false;
        pub = this.certs[u.href] = new X509Certificate(await r.text()).publicKey;
      }
      const v = createVerify(alg);
      v.update(keys.filter(k => m[k] != null).map(k => k + '\n' + m[k] + '\n').join(''));
      return v.verify(pub, m.Signature, 'base64');
    } catch (e) { console.log('signature check failed', e.message); return false; }
  }
  /** Roadworks happening now near a place (lat, lng, r = km, default 25). */
  roadworks(url) {
    const lat = num(url.searchParams.get('lat')), lng = num(url.searchParams.get('lng'));
    const r = Math.min(80, num(url.searchParams.get('r')) || 25);
    if (lat == null || lng == null) return json(400, { error: 'lat and lng please' });
    const now = Date.now(), out = [];
    for (const [ref, w] of Object.entries(this.works)) {
      if ((w.start && w.start > now) || (w.activity && w.end && w.end < now)) continue;
      const dy = (w.lat - lat) * 111.2, dx = (w.lng - lng) * 111.2 * Math.cos(lat * Math.PI / 180);
      const km = Math.hypot(dx, dy);
      if (km <= r) out.push(Object.assign({ id: ref, km: +km.toFixed(2) }, w));
    }
    out.sort((x, y) => x.km - y.km);
    return json(200, { works: [], paused: true, confirmed: !!this.sm.account, topics: Object.keys(this.sm.topics), today: this.smToday || 0, unsub: this.sm.unsub || null });
  }
}

// ---------- helpers ----------
function endShare(t, arrived) {
  t.endedAt = Date.now(); t.arrived = !!arrived;
  t.lastDest = t.dest ? t.dest.name : null;
  t.music = null; t.place = null; t.placeAt = null; t.radio = null; t.radioUrl = null; t.activity = null; t.stop = null;
  t.lat = t.lng = t.heading = t.speed = t.eta = t.remainingM = null; t.dest = null; t.route = null;
  t.routeV = (t.routeV || 0) + 1;
}
function cleanRoute(r) {
  if (!Array.isArray(r) || r.length < 2) return null;
  const pts = r.slice(0, 600).map(p => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)])
    .filter(([a, b]) => isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180);
  return pts.length >= 2 ? pts : null;
}
function publicShare(t) {
  return { name: t.name, mood: t.mood, emoji: t.emoji, hasPhoto: !!t.photo, photoV: t.photoV || 0, lat: t.lat, lng: t.lng, heading: t.heading,
    speed: t.speed, place: t.place || null, music: t.music || null, battery: t.battery || null, parked: !!t.parked,
    radio: t.radio ? Object.assign({ hasLogo: !!t.radioLogo, logoV: t.radioLogoV || 0, canListen: !!t.radioUrl }, t.radio) : null,
    mode: 'car', activity: t.activity || null, dest: t.dest, stop: t.stop || null, eta: t.eta, remainingM: t.remainingM, route: t.route, routeV: t.routeV || 0, lastDest: t.lastDest || null,
    startedAt: t.startedAt, updatedAt: t.updatedAt, endedAt: t.endedAt || null, arrived: !!t.arrived,
    events: (t.events || []).slice(-10), checkin: t.checkin || null, now: Date.now() };
}
/** A point on a WKT shape: the point itself, the middle of a line, or the centre of an area: [easting, northing]. */
function wktPoint(w) {
  w = String(w || '');
  const nums = (w.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  if (!pts.length) return null;
  if (/LINESTRING/.test(w) && pts.length > 1) {
    const len = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    let half = len.reduce((x, y) => x + y, 0) / 2;
    for (let i = 0; i < len.length; i++) {
      if (half <= len[i]) { const k = len[i] ? half / len[i] : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k]; }
      half -= len[i];
    }
  }
  return [pts.reduce((x, p) => x + p[0], 0) / pts.length, pts.reduce((x, p) => x + p[1], 0) / pts.length];
}
/** British National Grid (OSGB36 easting/northing) to WGS84 lat/lng, good to a few metres. */
function bngToWgs84(E, N) {
  const a = 6377563.396, b = 6356256.909, F0 = 0.9996012717, lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180, N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a), n = (a - b) / (a + b);
  let lat = lat0, M = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + (5 / 4) * n * n + (5 / 4) * n ** 3) * (lat - lat0);
    const Mb = (3 * n + 3 * n * n + (21 / 8) * n ** 3) * Math.sin(lat - lat0) * Math.cos(lat + lat0);
    const Mc = ((15 / 8) * n * n + (15 / 8) * n ** 3) * Math.sin(2 * (lat - lat0)) * Math.cos(2 * (lat + lat0));
    const Md = (35 / 24) * n ** 3 * Math.sin(3 * (lat - lat0)) * Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001);
  const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1, tanLat = Math.tan(lat), tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2, secLat = 1 / cosLat;
  const VII = tanLat / (2 * rho * nu), VIII = tanLat / (24 * rho * nu ** 3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = tanLat / (720 * rho * nu ** 5) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu, XI = secLat / (6 * nu ** 3) * (nu / rho + 2 * tan2), XII = secLat / (120 * nu ** 5) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = secLat / (5040 * nu ** 7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);
  const dE = E - E0;
  const phi = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lam = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  // OSGB36 -> WGS84 (Helmert)
  const H = 0, sp = Math.sin(phi), cp = Math.cos(phi);
  const nu2 = a / Math.sqrt(1 - e2 * sp * sp);
  let x = (nu2 + H) * cp * Math.cos(lam), y = (nu2 + H) * cp * Math.sin(lam), z = ((1 - e2) * nu2 + H) * sp;
  const tx = 446.448, ty = -125.157, tz = 542.060, s = -20.4894e-6;
  const rx = (0.1502 / 3600) * Math.PI / 180, ry = (0.2470 / 3600) * Math.PI / 180, rz = (0.8421 / 3600) * Math.PI / 180;
  const x2 = tx + (1 + s) * x - rz * y + ry * z, y2 = ty + rz * x + (1 + s) * y - rx * z, z2 = tz - ry * x + rx * y + (1 + s) * z;
  const a2 = 6378137, b2 = 6356752.3142, e22 = 1 - (b2 * b2) / (a2 * a2);
  const pp = Math.sqrt(x2 * x2 + y2 * y2);
  let la = Math.atan2(z2, pp * (1 - e22)), prev = 2 * Math.PI;
  while (Math.abs(la - prev) > 1e-12) { prev = la; const nn = a2 / Math.sqrt(1 - e22 * Math.sin(la) ** 2); la = Math.atan2(z2 + e22 * nn * Math.sin(la), pp); }
  return [la * 180 / Math.PI, Math.atan2(y2, x2) * 180 / Math.PI];
}
