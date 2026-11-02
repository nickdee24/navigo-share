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
const SHARE_ID_RE = /^[A-Za-z0-9]{8,16}$/;
const SHARE_KEY_RE = /^[a-f0-9]{24,48}$/;
const SHARE_KEEP_MS = 30 * 86400000;     // forget a link nobody has used for 30 days
const SHARE_STALE_MS = 12 * 3600000;     // a share with no update for 12 h counts as ended
function pruneShares() {
  const now = Date.now();
  for (const [id, t] of Object.entries(db.shares)) {
    if (now - (t.updatedAt || 0) > SHARE_KEEP_MS) delete db.shares[id];
    else if (!t.endedAt && now - (t.updatedAt || 0) > SHARE_STALE_MS) endShare(t, false);
  }
}
// Stop showing where you are: keep only your name, mood and where the last trip went.
function endShare(t, arrived) {
  t.endedAt = Date.now(); t.arrived = !!arrived;
  t.lastDest = t.dest ? t.dest.name : null;
  t.music = null; t.place = null; t.placeAt = null; t.radio = null; t.bus = null; t.activity = null;
  t.lat = t.lng = t.heading = t.speed = t.eta = t.remainingM = null; t.dest = null; t.route = null;
  t.routeV = (t.routeV || 0) + 1;
}
setInterval(pruneShares, 10 * 60000);
const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);
function publicShare(t) {
  return { name: t.name, mood: t.mood, hasPhoto: !!t.photo, photoV: t.photoV || 0, lat: t.lat, lng: t.lng, heading: t.heading,
    speed: t.speed, place: t.place || null, music: t.music || null,
    radio: t.radio ? Object.assign({ hasLogo: !!t.radioLogo, logoV: t.radioLogoV || 0 }, t.radio) : null,
    mode: t.mode || 'car', activity: t.activity || null, bus: t.bus || null, dest: t.dest, eta: t.eta, remainingM: t.remainingM, route: t.route, routeV: t.routeV || 0, lastDest: t.lastDest || null,
    startedAt: t.startedAt, updatedAt: t.updatedAt, endedAt: t.endedAt || null, arrived: !!t.arrived, now: Date.now() };
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
    if (typeof b.radio.logo === 'string' && b.radio.logo.length < 80000 && /^[A-Za-z0-9+/=]+$/.test(b.radio.logo)) {
      t.radioLogo = b.radio.logo; t.radioLogoV = (t.radioLogoV || 0) + 1;
    }
  } else if (b.radio !== undefined) { t.radio = null; t.radioLogo = null; }
  // Car / bus / walking: the mode picked in the app, and what you're doing now (driving, stopped, bus, walking)
  if (b.mode !== undefined) t.mode = ['car', 'bus', 'walk'].includes(b.mode) ? b.mode : 'car';
  if (b.activity !== undefined) t.activity = ['driving', 'stopped', 'bus', 'walking'].includes(b.activity) ? b.activity : null;
  if (b.bus && b.bus.service) {
    t.bus = { service: String(b.bus.service).slice(0, 8), heading: String(b.bus.heading || '').slice(0, 60) };
    // the bus's journey (when known): where it's going, arrival time, minutes late, stops left and the stops to come
    if (b.bus.destination !== undefined) {
      Object.assign(t.bus, { destination: String(b.bus.destination || '').slice(0, 80), street: String(b.bus.street || '').slice(0, 80),
        eta: num(b.bus.eta), delayMin: num(b.bus.delayMin) || 0, stopsLeft: num(b.bus.stopsLeft), stopNo: num(b.bus.stopNo), stopOf: num(b.bus.stopOf), getOff: String(b.bus.getOff || '').slice(0, 80),
        stops: Array.isArray(b.bus.stops) ? b.bus.stops.slice(0, 60).map(x => ({ name: String((x && x.name) || '').slice(0, 80), t: num(x && x.t) })) : [] });
    }
  }
  else if (b.bus !== undefined) t.bus = null;
  const lat = num(b.lat), lng = num(b.lng);
  if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    t.lat = lat; t.lng = lng; t.heading = num(b.heading); t.speed = num(b.speed); t.updatedAt = Date.now();
    updatePlace(t);
  } else t.updatedAt ||= Date.now();
  if (b.dest && isFinite(+b.dest.lat) && isFinite(+b.dest.lng)) {
    t.dest = { name: String(b.dest.name || 'Destination').slice(0, 80), lat: +b.dest.lat, lng: +b.dest.lng };
  } else if (b.dest === null) { t.dest = null; t.route = null; }
  t.eta = num(b.eta); t.remainingM = num(b.remainingM);
  if (b.route !== undefined) { t.route = b.route ? cleanRoute(b.route) : null; t.routeV = (t.routeV || 0) + 1; }
  // Profile photo shown as the car icon: a small JPEG as base64, sent once (and again when it changes).
  if (typeof b.photo === 'string' && b.photo.length < 60000 && /^[A-Za-z0-9+/=]+$/.test(b.photo)) { t.photo = b.photo; t.photoV = (t.photoV || 0) + 1; }
  if (b.photo === null) t.photo = null;
  save();
  return json(res, 200, { ok: true, url: '/t/' + id, needRoute: !!(t.dest && !t.route), needPhoto: !!b.wantPhoto && !t.photo,
    needRadioLogo: !!(t.radio && !t.radioLogo) });
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
// ---------- live buses for the map: the government's Bus Open Data Service live feed (SIRI-VM), cached briefly ----------
// Needs Nick's free BODS key in Render's Environment as BODS_KEY (never in the code).
const BODS_KEY = process.env.BODS_KEY || '';
const busCache = new Map();
let bodsLonFirst = true;   // which way round the feed wants its box; flipped if one way returns nothing
function sirivm(xml) {
  const now = Date.now(), out = [];
  const tag = (blk, t) => { const m = blk.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')); return m ? m[1].trim() : ''; };
  for (const m of xml.matchAll(/<VehicleActivity>([\s\S]*?)<\/VehicleActivity>/g)) {
    const blk = m[1];
    const loc = (blk.match(/<VehicleLocation>([\s\S]*?)<\/VehicleLocation>/) || [])[1] || '';
    const lat = +tag(loc, 'Latitude'), lng = +tag(loc, 'Longitude');
    if (!isFinite(lat) || !isFinite(lng) || (!lat && !lng)) continue;
    const at = Date.parse(tag(blk, 'RecordedAtTime'));
    if (isFinite(at) && now - at > 600000) continue;          // not heard from for 10 minutes: parked up
    const b = tag(blk, 'Bearing');
    out.push({ id: tag(blk, 'VehicleRef') || (tag(blk, 'OperatorRef') + lat + lng),
      line: tag(blk, 'PublishedLineName') || tag(blk, 'LineRef'), dest: tag(blk, 'DestinationName').replace(/_/g, ' '),
      lat, lng, heading: b === '' ? null : +b, at: isFinite(at) ? at : null });
  }
  return out;
}
async function bodsBox(s, w, n, e, lonFirst) {
  const box = lonFirst ? `${w},${s},${e},${n}` : `${s},${n},${w},${e}`;
  const r = await fetch(`https://data.bus-data.dft.gov.uk/api/v1/datafeed/?boundingBox=${box}&api_key=${encodeURIComponent(BODS_KEY)}`,
    { headers: { 'User-Agent': 'NaviGO-ShareTrip/1.0 (personal trip sharing)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return sirivm(await r.text()).filter(v => v.lat >= s && v.lat <= n && v.lng >= w && v.lng <= e);
}
async function liveBuses(s, w, n, e) {
  if (!BODS_KEY) throw new Error('No BODS_KEY set');
  const k = [s, w, n, e].map(v => v.toFixed(2)).join(',');
  const hit = busCache.get(k);
  if (hit && Date.now() - hit.at < 4000) return hit.list;
  let list = await bodsBox(s, w, n, e, bodsLonFirst);
  if (!list.length) { const other = await bodsBox(s, w, n, e, !bodsLonFirst).catch(() => []); if (other.length) { bodsLonFirst = !bodsLonFirst; list = other; } }
  list = list.slice(0, 600);
  busCache.set(k, { at: Date.now(), list });
  if (busCache.size > 500) busCache.delete(busCache.keys().next().value);
  return list;
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

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.ttf': 'font/ttf' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return json(res, 200, { ok: true });
  if (url.pathname === '/api/music/search') {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 100);
    if (!q) return json(res, 400, { error: 'Type something to search for' });
    try { const r = await musicSearch(q); return json(res, r.error ? 503 : 200, r); }
    catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
    return res.end('window.MAPBOX_TOKEN = ' + JSON.stringify(MAPBOX_TOKEN) + ';');
  }
  if (url.pathname === '/api/buses') {
    const p = k => +url.searchParams.get(k);
    const sb = p('s'), wb = p('w'), nb = p('n'), eb = p('e');
    if (![sb, wb, nb, eb].every(isFinite) || nb <= sb || eb <= wb || nb - sb > 0.8 || eb - wb > 1.4) return json(res, 400, { error: 'Bad area' });
    try { return json(res, 200, await liveBuses(sb, wb, nb, eb)); }
    catch (err) { return json(res, 503, { error: 'Live buses not available right now' }); }
  }
  const shareApi = url.pathname.match(/^\/api\/share\/(update|end)$/);
  if (shareApi && req.method === 'POST') return handleShareApi(req, res, shareApi[1]);
  const shareGet = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})$/);
  if (shareGet) {
    const t = db.shares[shareGet[1]];
    return t ? json(res, 200, publicShare(t)) : json(res, 404, { error: 'Nothing shared on this link yet.' });
  }
  const sharePhoto = url.pathname.match(/^\/api\/share\/([A-Za-z0-9]{8,16})\/photo$/);
  if (sharePhoto) {
    const t = db.shares[sharePhoto[1]];
    if (!t || !t.photo) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
    return res.end(Buffer.from(t.photo, 'base64'));
  }
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
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' }); res.end(data);
    });
  }
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`NaviGO Share trip running on http://localhost:${PORT}`));
