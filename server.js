// NaviGO Share trip: a small website that shows a trip someone is sharing from NaviGO.
// The phone posts its position, route and ETA; anyone with the link (/t/<id>) watches it live.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Mapbox public token for the map (set MAPBOX_TOKEN in Render → Environment). Without it the page uses OpenStreetMap.
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || '';
// TomTom key for the share map (the same TomTom map as the NaviGO app; location only, no traffic).
// Set TOMTOM_KEY in Render → Environment. Without it the page keeps the Mapbox map.
const TOMTOM_KEY = process.env.TOMTOM_KEY || '';
// Google Maps key for the Street View strip (Maps Embed API, free to use). Set GOOGLE_MAPS_KEY in Render → Environment.
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- storage (a JSON file; on Render's free plan it's wiped on restart and the phone recreates it) ----------
const STATE_FILE = path.join(DATA_DIR, 'shares.json');
let db = { shares: {} };
try { db = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* first run */ }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(STATE_FILE + '.tmp', STATE_FILE, () => {}); });
  }, 1000);
}

function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function readJSON(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); } });
  });
}

function cleanRoute(r) {
  if (!Array.isArray(r) || r.length < 2) return null;
  const pts = r.slice(0, 600).map(p => [+(+p[0]).toFixed(5), +(+p[1]).toFixed(5)])
    .filter(([a, b]) => isFinite(a) && isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180);
  return pts.length >= 2 ? pts : null;
}
// ---------- shared trips ----------
// NaviGO makes up the link id and a secret key once and reuses them, so your share link never changes.
// Anyone with the link can watch while you're sharing; only the phone can update it. Between trips the page
// says you're not sharing and shows no location. Kept in memory (and state.json); after a server restart the
// phone's next update recreates it.
db.shares ||= {};
let previewCache = null, ytCache = null, ytSearchCache = null;   // song -> Deezer preview (see /api/share/:id/preview)
const SHARE_ID_RE = /^[A-Za-z0-9]{8,16}$/;
const SHARE_KEY_RE = /^[a-f0-9]{24,48}$/;
const SHARE_KEEP_MS = 30 * 86400000;     // forget a link nobody has used for 30 days
const SHARE_STALE_MS = 12 * 3600000;     // a share with no update for 12 h counts as ended
function pruneShares() {
  const now = Date.now();
  for (const [id, t] of Object.entries(db.shares)) {
    if (now - Math.max(t.updatedAt || 0, t.eventAt || 0) > SHARE_KEEP_MS) delete db.shares[id];
    else if (!t.endedAt && now - (t.updatedAt || 0) > SHARE_STALE_MS) endShare(t, false);
  }
}
// Stop showing where you are: keep only your name, mood and where the last trip went.
function endShare(t, arrived) {
  t.endedAt = Date.now(); t.arrived = !!arrived;
  t.lastDest = t.dest ? t.dest.name : null;
  t.music = null; t.place = null; t.placeAt = null; t.radio = null; t.radioUrl = null; t.activity = null; t.stop = null;
  t.lat = t.lng = t.heading = t.speed = t.eta = t.remainingM = null; t.dest = null; t.route = null;
  t.routeV = (t.routeV || 0) + 1;
}
setInterval(pruneShares, 10 * 60000);
const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);
function publicShare(t) {
  return { name: t.name, mood: t.mood, emoji: t.emoji, hasPhoto: !!t.photo, photoV: t.photoV || 0, lat: t.lat, lng: t.lng, heading: t.heading,
    speed: t.speed, place: t.place || null, music: t.music || null, battery: t.battery || null,
    radio: t.radio ? Object.assign({ hasLogo: !!t.radioLogo, logoV: t.radioLogoV || 0, canListen: !!t.radioUrl }, t.radio) : null,
    mode: 'car', activity: t.activity || null, dest: t.dest, stop: t.stop || null, eta: t.eta, remainingM: t.remainingM, route: t.route, routeV: t.routeV || 0, lastDest: t.lastDest || null,
    startedAt: t.startedAt, updatedAt: t.updatedAt, endedAt: t.endedAt || null, arrived: !!t.arrived,
    events: (t.events || []).slice(-10), checkin: t.checkin || null, now: Date.now() };
}
async function handleShareApi(req, res, action) {
  const b = await readJSON(req);
  if (!b) return json(res, 400, { error: 'Bad JSON' });
  const id = String(b.id || ''), key = String(b.key || '');
  if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(res, 400, { error: 'Bad id or key' });
  let t = db.shares[id];
  if (t && t.key !== key) return json(res, 403, { error: 'Wrong key' });
  if (action === 'end') {
    // forget: you made a new link, so the old one stops working altogether
    if (t && b.forget) { delete db.shares[id]; save(); }
    else if (t && !t.endedAt) { endShare(t, b.arrived); save(); }
    return json(res, 200, { ok: true });
  }
  if (!t) { t = db.shares[id] = { key, startedAt: Date.now() }; console.log('Share link in use: /t/' + id); }
  if (t.endedAt) { t.startedAt = Date.now(); t.endedAt = null; t.arrived = false; t.photoV = (t.photoV || 0) + 1; }
  t.name = String(b.name || 'Someone').slice(0, 30);
  t.mood = String(b.mood || '').slice(0, 16);
  t.emoji = String(b.emoji || '').slice(0, 16);   // the profile emoji the app shows when there's no mood
  // What you're listening to (Spotify / YouTube Music), shown above your icon. null = nothing playing.
  if (b.music && b.music.title) {
    t.music = { title: String(b.music.title).slice(0, 80), artist: String(b.music.artist || '').slice(0, 60),
      player: String(b.music.player || '').slice(0, 12), playing: !!b.music.playing,
      // song progress in ms when this update arrived; the page counts on from here
      pos: num(b.music.pos), dur: num(b.music.dur), at: Date.now() };
  } else if (b.music !== undefined) t.music = null;
  // The radio station playing in NaviGO (its logo comes once per station, as a small PNG)
  if (b.radio && b.radio.name) {
    const name = String(b.radio.name).slice(0, 60);
    if (!t.radio || t.radio.name !== name) { t.radioLogo = null; t.radioLogoV = (t.radioLogoV || 0) + 1; }
    t.radio = { name, genre: String(b.radio.genre || '').slice(0, 40), playing: !!b.radio.playing };
    // the station's stream address, so the share page can 'Listen along' (kept here, the page plays it through /listen)
    t.radioUrl = typeof b.radio.url === 'string' && /^https?:\/\/[^\s]{4,500}$/.test(b.radio.url) ? b.radio.url : null;
    if (typeof b.radio.logo === 'string' && b.radio.logo.length < 80000 && /^[A-Za-z0-9+/=]+$/.test(b.radio.logo)) {
      t.radioLogo = b.radio.logo; t.radioLogoV = (t.radioLogoV || 0) + 1;
    }
  } else if (b.radio !== undefined) { t.radio = null; t.radioLogo = null; t.radioUrl = null; }
  // the phone's battery (shown as a battery icon on the share page)
  if (b.battery && isFinite(+b.battery.pct)) t.battery = { pct: Math.max(0, Math.min(100, Math.round(+b.battery.pct))), charging: !!b.battery.charging,
    slow: !!b.battery.slow, saver: !!b.battery.saver, at: Date.now() };
  // NaviGO is car only: driving or stopped
  if (b.activity !== undefined) t.activity = ['driving', 'stopped', 'walking'].includes(b.activity) ? b.activity : null;
  const lat = num(b.lat), lng = num(b.lng);
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    t.lat = lat; t.lng = lng; t.heading = num(b.heading); t.speed = num(b.speed); t.updatedAt = Date.now();
    updatePlace(t);
  } else t.updatedAt = Date.now();   // an update with no position (no GPS yet) still means NaviGO is sharing: keep the last place
  if (b.dest && isFinite(+b.dest.lat) && isFinite(+b.dest.lng)) {
    t.dest = { name: String(b.dest.name || 'Destination').slice(0, 80), lat: +b.dest.lat, lng: +b.dest.lng };
  } else if (b.dest === null) {
    // drive ended: clear the route, and bump its version so open pages drop the line
    if (t.dest || t.route) t.routeV = (t.routeV || 0) + 1;
    t.dest = null; t.route = null;
  }
  t.eta = num(b.eta); t.remainingM = num(b.remainingM);
  // a stop added on the way: shown as "Next stop" with its own arrival time and distance
  if (b.stop && isFinite(+b.stop.lat) && isFinite(+b.stop.lng)) {
    t.stop = { name: String(b.stop.name || 'Stop').slice(0, 80), lat: +b.stop.lat, lng: +b.stop.lng, eta: num(b.stop.eta), remainingM: num(b.stop.remainingM) };
  } else if (b.stop !== undefined) t.stop = null;
  if (b.route !== undefined) { t.route = b.route ? cleanRoute(b.route) : null; t.routeV = (t.routeV || 0) + 1; }
  // Profile photo shown as the car icon: a small JPEG as base64, sent once (and again when it changes).
  if (typeof b.photo === 'string' && b.photo.length < 60000 && /^[A-Za-z0-9+/=]+$/.test(b.photo)) { t.photo = b.photo; t.photoV = (t.photoV || 0) + 1; }
  if (b.photo === null) t.photo = null;
  // messages people sent from the share page that the app hasn't had yet (handed over once)
  const inbox = (t.inbox || []).filter(m => !m.delivered);
  inbox.forEach(m => { m.delivered = Date.now(); });
  save();
  return json(res, 200, { ok: true, url: '/t/' + id, needRoute: !!(t.dest && !t.route), needPhoto: !!b.wantPhoto && !t.photo,
    needRadioLogo: !!(t.radio && !t.radioLogo),
    inbox: inbox.map(m => ({ id: m.id, from: m.from, text: m.text, emote: m.emote, at: m.at })),
    // someone has the share page open and on screen right now (the app shows an eye above your mood)
    watching: !!(t.watchedAt && Date.now() - t.watchedAt < 15000) });
}

// ---------- where you are: street and town (OpenStreetMap's Nominatim, at most 1 lookup a second, cached) ----------
const placeCache = new Map();
let nominatimChain = Promise.resolve();
function nominatim(url) {
  const p = nominatimChain.then(() => fetch(url, { headers: { 'User-Agent': 'NaviGO-ShareTrip/1.0 (personal trip sharing)', 'Accept-Language': 'en-GB' } })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }));
  nominatimChain = p.catch(() => {}).then(() => new Promise(r => setTimeout(r, 1100)));
  return p;
}
async function placeName(lat, lng) {
  const key = lat.toFixed(3) + ',' + lng.toFixed(3);   // about 100 m squares
  if (placeCache.has(key)) return placeCache.get(key);
  let place = null;
  try {
    const j = await nominatim(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&addressdetails=1&lat=${lat}&lon=${lng}`);
    const a = j.address || {};
    const road = a.road || a.pedestrian || a.residential || null;
    const area = a.suburb || a.village || a.town || a.city_district || a.neighbourhood || a.hamlet || null;
    const town = a.town || a.city || a.village || a.county || null;
    place = { road, area: area && area !== town ? area : null, town };
  } catch { /* try again on a later update */ }
  if (place) { placeCache.set(key, place); if (placeCache.size > 3000) placeCache.delete(placeCache.keys().next().value); }
  return place;
}
function updatePlace(t) {
  if (t.lat == null || t.placeBusy) return;
  // look again after moving about 150 m
  if (t.placeAt && Math.hypot(t.lat - t.placeAt[0], (t.lng - t.placeAt[1]) * Math.cos(t.lat * Math.PI / 180)) < 0.00135) return;
  t.placeBusy = true;
  const at = [t.lat, t.lng];
  placeName(at[0], at[1]).then(p => { if (p) { t.place = p; t.placeAt = at; } }).finally(() => { t.placeBusy = false; });
}

// ---------- music search for NaviGO's player (Spotify Web API, app-only login: no user account needed) ----------
// Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Render → Environment (from developer.spotify.com/dashboard).
let spotifyToken = null, spotifyTokenUntil = 0;
async function spotifyAuth() {
  if (spotifyToken && Date.now() < spotifyTokenUntil) return spotifyToken;
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error('Spotify login failed (' + r.status + ')');
  const j = await r.json();
  spotifyToken = j.access_token; spotifyTokenUntil = Date.now() + (j.expires_in - 60) * 1000;
  return spotifyToken;
}
// Backup song list (no key needed): Apple's public catalogue. The phone then plays the song in Spotify by name.
async function itunesSearch(q) {
  const r = await fetch('https://itunes.apple.com/search?media=music&entity=song&limit=10&country=GB&term=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('Song search failed (' + r.status + ')');
  const j = await r.json();
  return { source: 'itunes', artists: [], tracks: (j.results || []).map(t => ({ name: t.trackName, uri: '', artists: t.artistName,
    album: t.collectionName, image: (t.artworkUrl100 || '').replace('100x100', '120x120') || null, durationMs: t.trackTimeMillis || 0 })) };
}
async function musicSearch(q) {
  try { return await spotifySearch(q); }
  catch (e) { console.log('Using backup song search:', e.message); return itunesSearch(q); }
}
async function spotifySearch(q) {
  const token = await spotifyAuth();
  if (!token) throw new Error('no Spotify key');
  const u = 'https://api.spotify.com/v1/search?type=track,artist&limit=10&market=GB&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) { spotifyToken = null; throw new Error('Spotify key expired'); }
  if (!r.ok) {
    let why = ''; try { const e = await r.json(); why = (e.error && (e.error.message || e.error)) || ''; } catch (_) {}
    console.log('Spotify search refused', r.status, why);
    throw new Error('Spotify search failed (' + r.status + (why ? ': ' + why : '') + ')');
  }
  const j = await r.json();
  const img = imgs => { const s = (imgs || []).slice().sort((a, b) => (a.width || 0) - (b.width || 0)); return (s.find(i => (i.width || 0) >= 64) || s[s.length - 1] || {}).url || null; };
  return { source: 'spotify',
    artists: ((j.artists && j.artists.items) || []).slice(0, 3).map(a => ({ name: a.name, uri: a.uri, image: img(a.images) })),
    tracks: ((j.tracks && j.tracks.items) || []).map(t => ({ name: t.name, uri: t.uri, artists: t.artists.map(a => a.name).join(', '),
      album: t.album && t.album.name, image: img(t.album && t.album.images), durationMs: t.duration_ms }))
  };
}


// ---------- Listen along: pass the radio station NaviGO is playing on to the share page ----------
// Many stations only stream over plain http (the page is https, so it can't play them itself) and some old
// servers answer 'ICY 200 OK', which Node's http can't read. So: a tiny raw request, follow redirects, pipe the audio.
const net = require('net'), tls = require('tls');
const listeners = {};   // share id -> how many people are listening right now
function openStream(u, cb, hops = 0) {
  let url; try { url = new URL(u); } catch (_) { return cb(new Error('bad url')); }
  const secure = url.protocol === 'https:', port = +url.port || (secure ? 443 : 80);
  const sock = secure ? tls.connect({ host: url.hostname, port, servername: url.hostname }) : net.connect({ host: url.hostname, port });
  let head = Buffer.alloc(0), done = false;
  const fail = e => { if (done) return; done = true; sock.destroy(); cb(e); };
  sock.setTimeout(10000, () => fail(new Error('timeout')));
  sock.once(secure ? 'secureConnect' : 'connect', () => {
    // HTTP/1.0 so the server never sends the audio in chunks
    sock.write('GET ' + (url.pathname || '/') + url.search + ' HTTP/1.0\r\nHost: ' + url.host +
      '\r\nUser-Agent: NaviGO-Share/1.0\r\nAccept: */*\r\nConnection: close\r\n\r\n');
  });
  sock.on('error', fail);
  sock.on('data', function onData(d) {
    head = Buffer.concat([head, d]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) { if (head.length > 16384) fail(new Error('bad reply')); return; }
    sock.removeListener('data', onData); sock.pause();
    const lines = head.slice(0, end).toString('latin1').split('\r\n');
    const status = +(lines[0].split(' ')[1] || 0), hdr = {};
    lines.slice(1).forEach(l => { const i = l.indexOf(':'); if (i > 0) hdr[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); });
    if (status >= 300 && status < 400 && hdr.location) {
      done = true; sock.destroy();
      return hops < 4 ? openStream(new URL(hdr.location, url).href, cb, hops + 1) : cb(new Error('too many redirects'));
    }
    if (status !== 200) return fail(new Error('status ' + status));
    done = true; sock.setTimeout(30000, () => sock.destroy());
    cb(null, sock, hdr, head.slice(end + 4));
  });
}
function listenAlong(req, res, id) {
  const t = db.shares[id];
  if (!t || t.endedAt || !t.radioUrl) { res.writeHead(404); return res.end(); }
  if ((listeners[id] || 0) >= 4) { res.writeHead(429); return res.end(); }
  listeners[id] = (listeners[id] || 0) + 1;
  let src = null, closed = false;
  const stop = () => { if (closed) return; closed = true; listeners[id]--; if (src) src.destroy(); };
  req.on('close', stop); res.on('close', stop);
  openStream(t.radioUrl, (err, sock, hdr, first) => {
    if (closed) { if (sock) sock.destroy(); return; }
    if (err) { stop(); res.writeHead(502); return res.end(); }
    src = sock;
    let type = (hdr['content-type'] || 'audio/mpeg').split(';')[0];
    if (!/^(audio|application\/ogg)/.test(type)) type = 'audio/mpeg';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (first.length) res.write(first);
    sock.pipe(res);
    sock.on('end', () => res.end()); sock.on('error', () => res.end());
    sock.resume();
  });
}

// ---------- link previews: title and a map picture ----------
const escAttr = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function withPreview(html, id, req) {
  const t = db.shares[id];
  const who = t && t.name ? t.name : 'Someone';
  const host = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'navigo-share.onrender.com');
  const live = t && !t.endedAt && t.lat != null;
  const tags = '<meta property="og:title" content="' + escAttr(who + (live ? "'s live trip" : ' on NaviGO')) + '">' +
    '<meta property="og:description" content="' + escAttr(live && t.dest ? 'On the way to ' + t.dest.name : 'See where they are on the map') + '">' +
    (live && TOMTOM_KEY ? '<meta property="og:image" content="' + host + '/api/share/' + id + '/map.png">' +
      '<meta property="og:image:width" content="600"><meta property="og:image:height" content="315"><meta name="twitter:card" content="summary_large_image">' : '');
  return html.replace('</head>', tags + '</head>');
}
const mapCache = {};   // id -> { at, png }
async function staticMap(res, id) {
  const t = db.shares[id];
  if (!TOMTOM_KEY || !t || t.endedAt || t.lat == null) { res.writeHead(404); return res.end(); }
  const c = mapCache[id];
  if (c && Date.now() - c.at < 60000) { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' }); return res.end(c.png); }
  try {
    const r = await fetch('https://api.tomtom.com/map/1/staticimage?key=' + encodeURIComponent(TOMTOM_KEY) +
      '&center=' + t.lng.toFixed(5) + ',' + t.lat.toFixed(5) + '&zoom=14&width=600&height=315&format=png&layer=basic&style=night&view=Unified');
    if (!r.ok) throw new Error('status ' + r.status);
    const png = Buffer.from(await r.arrayBuffer());
    mapCache[id] = { at: Date.now(), png };
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=60' }); res.end(png);
  } catch (e) { res.writeHead(502); res.end(); }
}

// ---------- http ----------
const SITE_VERSION = process.env.RENDER_GIT_COMMIT || String(Date.now());   // new on every deploy
const MIME = { '.apk': 'application/vnd.android.package-archive', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.ttf': 'font/ttf', '.pbf': 'application/x-protobuf' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return json(res, 200, { ok: true });
  // NaviGO Share moved to Cloudflare (24 Nov 2026): send everyone (share links, NaviGO Live) to the new address.
  // 308 keeps POSTs as POSTs for anything that follows it.
  res.writeHead(308, { Location: 'https://navigo-share.nickdoonan.workers.dev' + url.pathname + url.search, 'Cache-Control': 'no-store' });
  return res.end();
  // NaviGO Live asks this when it opens and every minute: 'site' changes on every deploy (so the app reloads the page),
  // 'app' is the newest NaviGO Live APK (public/app/navigo-live.json) so the app can offer the update itself.
  if (url.pathname === '/api/version') {
    let app = null;
    try { app = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'app', 'navigo-live.json'), 'utf8')); } catch (_) {}
    return json(res, 200, { site: SITE_VERSION, app });
  }
  // YouTube Music search for NaviGO's music player (YouTube Data API, key stays here: YOUTUBE_KEY). Songs come back
  // in the same shape as the Spotify search; uri 'ytm:<videoId>' tells the app to play it in YouTube Music.
  if (url.pathname === '/api/music/youtube') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(res, 400, { error: 'Type something to search for' });
    const ytKey = process.env.YOUTUBE_KEY;
    if (!ytKey) return json(res, 503, { error: 'not-set-up' });
    ytSearchCache ||= new Map();
    const hit = ytSearchCache.get(q.toLowerCase());
    if (hit && Date.now() - hit.at < 3600000) return json(res, 200, hit.body);
    try {
      const r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=12&regionCode=GB&q='
        + encodeURIComponent(q) + '&key=' + encodeURIComponent(ytKey), { headers: { Referer: 'https://navigo-share.onrender.com/' } });
      const j = await r.json();
      if (j.error) return json(res, 503, { error: j.error.message || 'YouTube search failed' });
      const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
      const items = (j.items || []).filter(x => x.id && x.id.videoId).map(x => {
        const ch = dec(x.snippet.channelTitle), topic = / - Topic$/.test(ch);
        return { name: dec(x.snippet.title), uri: 'ytm:' + x.id.videoId, artists: ch.replace(/ - Topic$/, ''), album: topic ? 'YouTube Music' : '',
          image: ((x.snippet.thumbnails || {}).default || {}).url || null, durationMs: 0, topic };
      });
      // the plain album songs ("Artist - Topic") first, like YouTube Music shows them
      items.sort((a, b) => (b.topic ? 1 : 0) - (a.topic ? 1 : 0));
      const body = { source: 'youtube', artists: [], tracks: items.slice(0, 10) };
      ytSearchCache.set(q.toLowerCase(), { at: Date.now(), body });
      if (ytSearchCache.size > 200) ytSearchCache.delete(ytSearchCache.keys().next().value);
      return json(res, 200, body);
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (url.pathname === '/api/music/search') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(res, 400, { error: 'Type something to search for' });
    try { const r = await musicSearch(q); return json(res, r.error ? 503 : 200, r); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
    return res.end('window.MAPBOX_TOKEN = ' + JSON.stringify(MAPBOX_TOKEN) + ';window.GMAPS_KEY = ' + JSON.stringify(GOOGLE_MAPS_KEY) + ';window.TOMTOM_KEY = ' + JSON.stringify(TOMTOM_KEY) + ';');
  }
  // "Send Nick a message" from the share page: a short message or an emote, picked up by the app on its next update
  const shareMsg = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/msg$/);
  if (shareMsg && req.method === 'POST') {
    const t = db.shares[shareMsg[1]], b = await readJSON(req);
    if (!t || t.endedAt) return json(res, 404, { error: 'Not sharing right now' });
    if (!b) return json(res, 400, { error: 'Bad JSON' });
    const viewer = String(b.viewer || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24), text = String(b.text || '').trim().slice(0, 140);
    if (!viewer || !text) return json(res, 400, { error: 'Type a message first' });
    t.inbox = t.inbox || [];
    const last = t.inbox.filter(m => m.viewer === viewer).pop();
    if (last && Date.now() - last.at < 3000) return json(res, 429, { error: 'Slow down a little' });
    const m = { id: Math.random().toString(36).slice(2, 10), viewer, from: String(b.from || '').trim().slice(0, 30) || 'Someone',
      text, emote: !!b.emote, at: Date.now() };
    t.inbox.push(m);
    if (t.inbox.length > 30) t.inbox.splice(0, t.inbox.length - 30);
    save();
    return json(res, 200, { ok: true, id: m.id });
  }
  // The app's reply to a message: "ack" (seen it) or "emote" (the same emote sent back)
  if (url.pathname === '/api/share/reply' && req.method === 'POST') {
    const b = await readJSON(req);
    if (!b) return json(res, 400, { error: 'Bad JSON' });
    const t = db.shares[String(b.id || '')];
    if (!t || t.key !== String(b.key || '')) return json(res, 403, { error: 'Wrong key' });
    const m = (t.inbox || []).find(x => x.id === String(b.msgId || ''));
    if (!m) return json(res, 404, { error: 'No such message' });
    const kind = b.kind === 'emote' ? 'emote' : b.kind === 'text' ? 'text' : 'ack';
    m.reply = { kind, at: Date.now(), text: kind === 'text' ? String(b.text || '').trim().slice(0, 200) : undefined };
    save();
    return json(res, 200, { ok: true });
  }
  // Place alerts from the app ("Left home", "Nearly home", "Arrived at Asda"), shown on the page and in NaviGO Live.
  // They come in whether or not a trip is being shared.
  if (url.pathname === '/api/share/event' && req.method === 'POST') {
    const b = await readJSON(req);
    if (!b) return json(res, 400, { error: 'Bad JSON' });
    const id = String(b.id || ''), key = String(b.key || '');
    if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(res, 400, { error: 'Bad id or key' });
    let t = db.shares[id];
    if (t && t.key !== key) return json(res, 403, { error: 'Wrong key' });
    if (!t) t = db.shares[id] = { key, startedAt: Date.now(), endedAt: Date.now(), name: String(b.name || 'Someone').slice(0, 30) };
    const text = String(b.text || '').trim().slice(0, 80);
    if (!text) return json(res, 400, { error: 'No text' });
    const ev = { id: Math.random().toString(36).slice(2, 10), text, kind: String(b.kind || '').slice(0, 20), at: Date.now() };
    t.events = (t.events || []).concat(ev).slice(-20);
    t.eventAt = ev.at;
    save();
    return json(res, 200, { ok: true, id: ev.id });
  }
  // The song they're playing, found on YouTube, so the page can play it in time with them (YouTube Data API v3:
  // YOUTUBE_KEY, or the Google Maps key once 'YouTube Data API v3' is switched on for it in Google Cloud)
  const shareYt = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/youtube$/);
  if (shareYt) {
    const t = db.shares[shareYt[1]];
    const m = t && !t.endedAt && t.music;
    if (!m || !m.title) return json(res, 404, { error: 'No song playing' });
    const ytKey = process.env.YOUTUBE_KEY || GOOGLE_MAPS_KEY;
    if (!ytKey) return json(res, 503, { error: 'No YouTube key' });
    const key = (m.artist || '') + '|' + m.title;
    ytCache ||= new Map();
    let hit = ytCache.get(key);
    if (hit && Date.now() - hit.at > 86400000) hit = null;
    if (!hit) {
      try {
        const q = encodeURIComponent(((m.artist || '') + ' ' + m.title + ' audio').trim());
        const r = await fetch('https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=8&videoCategoryId=10&q=' + q + '&key=' + encodeURIComponent(ytKey),
          { headers: { Referer: 'https://navigo-share.onrender.com/' } });
        const j = await r.json();
        if (j.error) { console.log('YouTube search:', j.error.message); return json(res, 503, { error: 'YouTube search not available' }); }
        const items = (j.items || []).filter(x => x.id && x.id.videoId);
        // the plain album audio ("Artist - Topic" channels) lines up with Spotify best: no video intros
        const best = items.find(x => /- Topic$/.test(x.snippet.channelTitle)) || items.find(x => /official audio/i.test(x.snippet.title)) || items[0];
        hit = best ? { videoId: best.id.videoId, title: best.snippet.title, at: Date.now() } : { none: true, at: Date.now() };
      } catch (e) { return json(res, 502, { error: 'YouTube search failed' }); }
      ytCache.set(key, hit);
      if (ytCache.size > 300) ytCache.delete(ytCache.keys().next().value);
    }
    if (hit.none) return json(res, 404, { error: 'Not found on YouTube' });
    return json(res, 200, { videoId: hit.videoId, title: hit.title });
  }
  // 30-second preview of the song they're playing on Spotify / YouTube Music (Deezer's free previews; no key)
  const sharePreview = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/preview$/);
  if (sharePreview) {
    const t = db.shares[sharePreview[1]];
    const m = t && !t.endedAt && t.music;
    if (!m || !m.title) return json(res, 404, { error: 'No song playing' });
    const key = (m.artist || '') + '|' + m.title;
    previewCache ||= new Map();
    let hit = previewCache.get(key);
    if (hit && Date.now() - hit.at > 600000) hit = null;   // Deezer's preview links stop working after ~15 min
    if (!hit) {
      try {
        const q = encodeURIComponent(((m.artist || '') + ' ' + m.title).trim());
        const r = await fetch('https://api.deezer.com/search?limit=8&q=' + q);
        const list = (await r.json()).data || [];
        const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|feat\..*$|[^a-z0-9 ]/g, '').trim();
        const want = norm(m.title), who = norm(m.artist);
        const best = list.find(x => x.preview && norm(x.title).startsWith(want) && (!who || norm(x.artist && x.artist.name).includes(who.split(' ')[0])))
          || list.find(x => x.preview && norm(x.title).startsWith(want)) || null;
        hit = best ? { url: best.preview, title: best.title, artist: best.artist ? best.artist.name : '', at: Date.now() } : { none: true, at: Date.now() };
      } catch (e) { return json(res, 502, { error: 'Preview search failed' }); }
      previewCache.set(key, hit);
      if (previewCache.size > 300) previewCache.delete(previewCache.keys().next().value);
    }
    if (hit.none) return json(res, 404, { error: 'No preview for this song' });
    return json(res, 200, { url: hit.url, title: hit.title, artist: hit.artist });
  }
  // "Clear updates" in NaviGO's settings: empties the Updates list (place alerts, check-ins) on the share page
  if (url.pathname === '/api/share/clear' && req.method === 'POST') {
    const b = await readJSON(req);
    if (!b) return json(res, 400, { error: 'Bad JSON' });
    const id = String(b.id || ''), key = String(b.key || '');
    if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(res, 400, { error: 'Bad id or key' });
    const t = db.shares[id];
    if (t && t.key !== key) return json(res, 403, { error: 'Wrong key' });
    if (t) { t.events = []; save(); }
    return json(res, 200, { ok: true });
  }
  // Checked in at home from NaviGO's map (tap the house, Check in): the page says "Nick is at home" with a house,
  // shared trip or not. home:false checks out (NaviGO also does that by itself when you leave home).
  if (url.pathname === '/api/share/checkin' && req.method === 'POST') {
    const b = await readJSON(req);
    if (!b) return json(res, 400, { error: 'Bad JSON' });
    const id = String(b.id || ''), key = String(b.key || '');
    if (!SHARE_ID_RE.test(id) || !SHARE_KEY_RE.test(key)) return json(res, 400, { error: 'Bad id or key' });
    let t = db.shares[id];
    if (t && t.key !== key) return json(res, 403, { error: 'Wrong key' });
    if (!t) t = db.shares[id] = { key, startedAt: Date.now(), endedAt: Date.now() };
    t.name = String(b.name || t.name || 'Someone').slice(0, 30);
    const lat = num(b.lat), lng = num(b.lng);
    const home = !!b.home, place = home ? 'home' : String(b.place || '').trim().slice(0, 60);
    const addEvent = (text, kind) => {
      const ev = { id: Math.random().toString(36).slice(2, 10), text, kind, at: Date.now() };
      t.events = (t.events || []).concat(ev).slice(-20); t.eventAt = ev.at;
    };
    if (!b.out && place && lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      const same = t.checkin && t.checkin.place === place;
      t.checkin = { place, lat, lng, at: same ? t.checkin.at : Date.now() };
      // "Arrived at Asda" for NaviGO Live's notifications (home has its own "Arrived home" / "Left home")
      if (!same) addEvent(home ? 'Checked in at home' : 'Arrived at ' + place, home ? 'home_checkin' : 'place_arrived');
    } else {
      // checked out: "Left Asda"
      if (t.checkin && t.checkin.place !== 'home') addEvent('Left ' + t.checkin.place, 'place_left');
      t.checkin = null;
    }
    t.eventAt = Math.max(t.eventAt || 0, Date.now());   // keeps the link remembered
    save();
    return json(res, 200, { ok: true });
  }
  // A small TomTom map of where they are (Static Image API), for link previews in WhatsApp, Messages etc.
  const shareMap = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/map\.png$/);
  if (shareMap) return staticMap(res, shareMap[1]);
  const shareApi = url.pathname.match(/^\/api\/share\/(update|end)$/);
  if (shareApi && req.method === 'POST') return handleShareApi(req, res, shareApi[1]);
  const shareGet = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})$/);
  if (shareGet) {
    const t = db.shares[shareGet[1]];
    if (t && url.searchParams.get('w') === '1') t.watchedAt = Date.now();   // a viewer has the page on screen (kept in memory only)
    if (!t) return json(res, 404, { error: 'Nothing shared on this link yet.' });
    // replies to this viewer's messages that they haven't seen yet
    const viewer = String(url.searchParams.get('viewer') || '');
    const replies = viewer ? (t.inbox || []).filter(m => m.viewer === viewer && m.reply && !m.replyShown) : [];
    if (replies.length) { replies.forEach(m => { m.replyShown = Date.now(); }); save(); }
    return json(res, 200, Object.assign(publicShare(t), {
      replies: replies.map(m => ({ msgId: m.id, kind: m.reply.kind, text: m.text, emote: m.emote, replyText: m.reply.text || null })) }));
  }
  const sharePhoto = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/photo$/);
  if (sharePhoto) {
    const t = db.shares[sharePhoto[1]];
    if (!t || !t.photo) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
    return res.end(Buffer.from(t.photo, 'base64'));
  }
  const listen = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/listen$/);
  if (listen) return listenAlong(req, res, listen[1]);
  const radioLogo = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/radiologo$/);
  if (radioLogo) {
    const t = db.shares[radioLogo[1]];
    if (!t || !t.radioLogo) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    return res.end(Buffer.from(t.radioLogo, 'base64'));
  }
  if (url.pathname === '/plan' || url.pathname === '/plan/') {   // trip planner
    return fs.readFile(path.join(PUBLIC_DIR, 'plan.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  if (url.pathname === '/' || /^\/t\/[A-Za-z0-9]{8,16}\/?$/.test(url.pathname)) {
    return fs.readFile(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : 'trip.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      if (url.pathname === '/') return res.end(data);
      res.end(withPreview(String(data), url.pathname.split('/')[2], req));
    });
  }
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const fresh = url.pathname.startsWith('/app/');   // app downloads are never cached
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': fresh ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`NaviGO Share trip running on http://localhost:${PORT}`));
