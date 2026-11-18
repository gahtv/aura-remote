/* Aura Remote — phone-first control for Aura on the TV.
 *
 * Two paths:
 *   aura — Jellyfin remote-control protocol + Aura's mirror link (primary)
 *   cast — the homelab bridge loads a direct-play URL onto a Cast target (fallback)
 * The ADB-bridge endpoints the server still exposes (launch, D-pad, screen) are
 * not driven from this UI; launching Aura is the only ADB call still used.
 */

const CLIENT = 'Aura Remote';
const VERSION = '0.2.0';
const POLL_MS = 2000;
const ATMOS_TTL_MS = 24 * 60 * 60 * 1000;
const TV_HINT = /streamer|android tv|shield|\btv\b/i;

const $ = id => document.getElementById(id);

const store = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: k => localStorage.removeItem(k),
};

function newDeviceId() {
  // crypto.randomUUID is secure-context only; plain HTTP on the LAN has none,
  // and a throw here kills the whole script.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'aura-remote-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let deviceId = store.get('deviceId');
if (!deviceId) { deviceId = newDeviceId(); store.set('deviceId', deviceId); }

const state = {
  server: '', token: '', userId: '', userName: '', deviceId,
  bridge: store.get('bridge') || location.origin,
  bridgeReady: false,
  bridgeError: '',
  sessions: [], castTargets: [], target: null,
  np: null, seeking: false, repeat: 'RepeatNone', shuffle: false,
  launching: false, lastLaunch: 0, launchError: '',
  autoLaunch: store.get('autoLaunch') !== false,
  lib: 'albums',
  atmos: null,
  mirrorOn: store.get('mirrorOn') === true,
  mirrorTimer: null,
  mirrorApplying: false,
  mirrorSig: '',
  queueSig: '',
  aura: null,
  // The one TV the bridge's mirror link reaches: AURA_LINK and its /state name.
  link: { address: '', deviceName: '' },
  unpaired: false,
  pairing: false,
  pairError: '',
  queue: [],
  queueIndex: 0,
  lyricsOn: false,
  lyricsFor: null,
  lyricsLines: null,
  sheetAlbumId: null,
  sheetArtistId: null,
  timer: null,
};


/* ---------------- bridge session ----------------
 * The bridge trusts Jellyfin as the identity provider: a valid Jellyfin token
 * buys an HttpOnly cookie, and every API call then rides on that cookie. The
 * Jellyfin token stays in localStorage (the PWA needs it for API calls); the
 * Aura pairing token never leaves the bridge.
 */

async function ensureBridgeSession(force = false) {
  if (state.bridgeReady && !force) return true;
  try {
    const res = await fetch(`${state.bridge}/api/session/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: state.server, token: state.token }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 140));
    state.bridgeReady = true;
    state.bridgeError = '';
    return true;
  } catch (e) {
    state.bridgeReady = false;
    state.bridgeError = e.message || 'bridge refused the session';
    return false;
  }
}

async function bridgeFetch(path, opts = {}) {
  let res = await fetch(state.bridge + path, opts);
  if (res.status === 401) {
    if (await ensureBridgeSession(true)) {
      res = await fetch(state.bridge + path, opts);
    }
  }
  return res;
}

/* ---------------- helpers ---------------- */

function authHeader(token = state.token) {
  let h = `MediaBrowser Client="${CLIENT}", Device="Web", DeviceId="${state.deviceId}", Version="${VERSION}"`;
  if (token) h += `, Token="${token}"`;
  return h;
}

function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function fmt(sec) {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, { method = 'GET', body, server = state.server, token = state.token } = {}) {
  const res = await fetch(server + path, {
    method,
    headers: { Authorization: authHeader(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Error('unauthorized');
  return res;
}

function imageUrl(item, size = 400) {
  const tag = item?.ImageTags?.Primary;
  if (!item?.Id || !tag) return '';
  return `${state.server}/Items/${item.Id}/Images/Primary?tag=${tag}&maxHeight=${size}&api_key=${state.token}`;
}

/* ---------------- auth ---------------- */

async function login() {
  const server = $('server').value.trim().replace(/\/$/, '');
  const username = $('user').value.trim();
  const pw = $('pass').value;
  const err = $('loginError');
  err.textContent = '';
  if (!server || !username || !pw) { err.textContent = 'All three fields are required.'; return; }

  $('loginBtn').disabled = true;
  try {
    const res = await fetch(`${server}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: { Authorization: authHeader(''), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: username, Pw: pw }),
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong username or password.' : `Server said ${res.status}.`);
    const data = await res.json();

    state.server = server;
    state.token = data.AccessToken;
    state.userId = data.User.Id;
    state.userName = data.User.Name;
    store.set('lastServer', server);
    store.set('auth', { server, token: state.token, userId: state.userId, userName: state.userName });
    $('pass').value = '';
    enterApp();
  } catch (e) {
    err.textContent = (e.name === 'TypeError' || /fetch/i.test(e.message))
      ? `Can't reach ${server}. Check the address and that you're on the same network.`
      : e.message;
  } finally {
    $('loginBtn').disabled = false;
  }
}

async function logout() {
  clearInterval(state.timer);
  clearInterval(state.mirrorTimer);
  // Drop the server-side session too: the cookie is HttpOnly and lives 30 days,
  // so clearing local storage alone leaves a live bridge session behind.
  try {
    await fetch(`${state.bridge}/api/session/logout`, { method: 'POST' });
  } catch { /* bridge unreachable — the cookie expires on its own */ }
  state.bridgeReady = false;
  state.bridgeError = '';
  store.del('auth');
  $('main').classList.add('hidden');
  $('login').classList.remove('hidden');
}

function enterApp() {
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  ensureBridgeSession().then(loadLink);
  startPolling();
  loadLibrary();
  buildAtmosCatalog();
  startMirror();
}

/* ---------------- targets ---------------- */

// Retried from pollMirror until the bridge has answered once.
async function loadLink() {
  if (state.link.loading) return;
  state.link.loading = true;
  try {
    const res = await bridgeFetch(`/api/aura/paired`);
    if (res.ok) {
      state.link.address = (await res.json()).link || '';
      state.link.loaded = true;
    }
  } catch { /* bridge unreachable — retried on the next mirror poll */ }
  finally { state.link.loading = false; }
}

// Only the bridge's own TV can be reached over the mirror link; every other Aura
// in the picker goes through Jellyfin.
function targetRoute() {
  return AuraRouting.routeFor(state.target, state.sessions.map(s => s.raw), state.link);
}

function targetIsLinked() {
  return targetRoute() === 'link';
}

// The D-pad, TV navigation, mirror and its queue exist only on the mirror link.
// With nothing selected yet there is only the linked TV to talk to.
function linkReachesTarget() {
  return !state.target || targetIsLinked();
}

function looksLikeEmulator(session) {
  const name = `${session.DeviceName || ''} ${session.Client || ''}`;
  const endpoint = session.RemoteEndPoint || '';
  return /emulator|emulated|avd|sdk_gphone/i.test(name) || /^(127\.|10\.0\.2\.)/.test(endpoint);
}

function scoreAura(s) {
  let score = 100;
  if (looksLikeEmulator(s)) score -= 1000;        // never the default while a real TV exists
  if (TV_HINT.test(s.DeviceName || '')) score += 20;
  if (s.NowPlayingItem) score += 5;
  return score;
}

async function refreshTargets() {
  const [sessionsRes, castRes] = await Promise.all([
    api('/Sessions').catch(() => null),
    bridgeFetch(`/api/targets`).catch(() => null),
  ]);

  const sessions = sessionsRes && sessionsRes.ok ? await sessionsRes.json() : [];
  state.sessions = sessions
    .filter(s => s.Client === 'Aura' && s.SupportsRemoteControl)
    .sort((a, b) => scoreAura(b) - scoreAura(a))
    .map(s => ({
      kind: 'aura',
      key: 'aura:' + s.Id,
      label: s.DeviceName || 'Android TV',
      sub: `${s.RemoteEndPoint || ''}${looksLikeEmulator(s) ? ' · emulator' : ''}`,
      sessionId: s.Id,
      emulator: looksLikeEmulator(s),
      raw: s,
    }));

  const cast = castRes && castRes.ok ? (await castRes.json()).targets : [];
  state.castTargets = cast.map(t => ({
    kind: 'cast', key: 'cast:' + t.name, label: t.name, sub: t.model || t.host,
  }));

  const all = [...state.sessions, ...state.castTargets];
  const remembered = store.get('targetKey');
  const keep = state.target && all.find(t => t.key === state.target.key);
  state.target = keep
    || (remembered && all.find(t => t.key === remembered))
    || state.sessions[0]
    || state.castTargets.find(t => TV_HINT.test(t.label))
    || state.castTargets[0]
    || null;

  renderTargetLabel();
}

function renderTargetLabel() {
  const el = $('targetState');
  const t = state.target;
  if (!t) { el.textContent = 'no target'; el.classList.remove('live'); return; }
  el.textContent = `${t.kind === 'aura' ? 'Aura' : 'Cast'} · ${t.label}${t.emulator ? ' (emu)' : ''}`;
  el.classList.toggle('live', t.kind === 'aura');
  renderMirrorBtn();
}

function selectTarget(key) {
  const found = [...state.sessions, ...state.castTargets].find(t => t.key === key);
  if (!found) return;
  state.target = found;
  state.np = null;
  state.aura = null;
  state.queue = [];
  state.queueIndex = 0;
  state.queueSig = '';
  state.mirrorSig = '';
  $('dpadMsg').textContent = '';
  store.set('targetKey', key);
  renderTargetLabel();
  closeSheet('deviceSheet');
  toast(`Using ${found.label}`);
  renderQueue(true);
  tick();
  pollMirror();
}

/* ---------------- now playing ---------------- */

function npFromSession(session) {
  if (!session?.NowPlayingItem) return null;
  return {
    item: session.NowPlayingItem,
    playing: !session.PlayState?.IsPaused,
    position: (session.PlayState?.PositionTicks || 0) / 1e7,
    duration: (session.NowPlayingItem.RunTimeTicks || 0) / 1e7,
    repeat: session.PlayState?.RepeatMode || 'RepeatNone',
    shuffle: session.PlayState?.PlaybackOrder === 'Shuffle',
  };
}

async function refreshNowPlaying() {
  const t = state.target;
  if (!t) { state.np = null; return; }

  if (t.kind === 'aura') {
    const session = state.sessions.find(s => s.key === t.key);
    state.np = npFromSession(session?.raw);
    if (state.np) { state.repeat = state.np.repeat; state.shuffle = state.np.shuffle; }
    if (!targetIsLinked()) await refreshJellyfinQueue(session?.raw, t.key);
    return;
  }

  try {
    const res = await bridgeFetch(`/api/status?device=${encodeURIComponent(t.label)}`);
    if (!res.ok) { state.np = null; return; }
    const s = await res.json();
    state.np = (s.playing || s.paused)
      ? { item: null, title: s.title, artist: s.artist, album: s.album,
          playing: s.playing, position: s.position_s || 0, duration: s.duration_s || 0 }
      : null;
  } catch { state.np = null; }
}

// A TV other than the linked one: its queue comes from Jellyfin's session.
const queueTitles = new Map();

async function refreshJellyfinQueue(session, key) {
  const { ids, index } = AuraRouting.queueFromSession(session);
  const missing = ids.filter(id => !queueTitles.has(id));
  // Batches of 100 ids keep the URL well under Jellyfin's request-line limit.
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    try {
      const res = await api(`/Items?Ids=${batch.join(',')}&UserId=${state.userId}`);
      if (!res.ok) break;
      const items = (await res.json()).Items || [];
      items.forEach(it => queueTitles.set(it.Id, {
        title: it.Name, artist: it.AlbumArtist || (it.Artists || [])[0] || '',
      }));
      batch.forEach(id => { if (!queueTitles.has(id)) queueTitles.set(id, { title: 'Unknown track', artist: '' }); });
    } catch (e) {
      if (e.message === 'unauthorized') throw e;
      break;
    }
  }
  // The picker may have moved to another TV while the titles were loading.
  if (state.target?.key !== key) return;
  state.queue = ids.map(id => ({ id, ...(queueTitles.get(id) || { title: '…', artist: '' }) }));
  state.queueIndex = index;
  renderQueue();
}

function renderNowPlaying() {
  const np = state.np;
  const idle = $('npIdle');
  const launch = $('npLaunch');
  const active = $('npActive');

  if (!np) {
    const canLaunch = !state.sessions.length;
    launch.classList.toggle('hidden', !canLaunch);
    idle.classList.toggle('hidden', canLaunch);
    active.classList.add('hidden');

    if (canLaunch) {
      $('launchMsg').textContent = state.launching
        ? 'Starting Aura on the TV…'
        : state.launchError
          ? `Could not start Aura — ${state.launchError}`
          : "Aura isn't running on the TV.";
      $('btnLaunch').textContent = state.launching ? 'Starting…' : 'Start Aura';
      $('btnLaunch').disabled = state.launching;
    } else {
      idle.textContent = 'Aura is idle. Pick something in Library.';
    }
    return;
  }

  launch.classList.add('hidden');
  idle.classList.add('hidden');
  active.classList.remove('hidden');

  if (np.item) {
    $('npTitle').textContent = np.item.Name || '—';
    $('npArtist').textContent = np.item.Artists?.join(', ') || np.item.AlbumArtist || '';
    $('npAlbum').textContent = np.item.Album || '';
    const url = imageUrl(np.item);
    $('npArt').src = url;
    $('npArt').style.visibility = url ? 'visible' : 'hidden';
  } else {
    $('npTitle').textContent = np.title || '—';
    $('npArtist').textContent = np.artist || '';
    $('npAlbum').textContent = np.album || '';
    $('npArt').style.visibility = 'hidden';
  }

  $('npPos').textContent = fmt(np.position);
  $('npDur').textContent = fmt(np.duration);
  if (!state.seeking && np.duration > 0) {
    $('npSeek').value = String(Math.min(1000, Math.round((np.position / np.duration) * 1000)));
  }

  $('playIcon').innerHTML = np.playing
    ? `<path d="${MS_ICONS.pause}"/>`
    : `<path d="${MS_ICONS.play_arrow}"/>`;

  const isAura = state.target?.kind === 'aura';
  $('btnRepeat').disabled = !isAura;
  $('btnShuffle').disabled = !isAura;
  $('btnRepeat').classList.toggle('on', state.repeat !== 'RepeatNone');
  // Repeat-one gets its own Material glyph instead of only a colour change.
  const repeatSvg = $('btnRepeat').querySelector('svg');
  const repeatGlyph = state.repeat === 'RepeatOne' ? MS_ICONS.repeat_one : MS_ICONS.repeat;
  if (repeatSvg && repeatSvg.dataset.glyph !== repeatGlyph) {
    repeatSvg.dataset.glyph = repeatGlyph;
    repeatSvg.innerHTML = `<path d="${repeatGlyph}"/>`;
  }
  $('btnShuffle').classList.toggle('on', !!state.shuffle);

  if (state.lyricsOn) {
    if (state.lyricsFor !== (np.item?.Id || null)) setLyricsVisible(true);
    else renderLyrics();
  }
}

/* ---------------- icons ---------------- */

/* Material Symbols path data (24px grid, viewBox "0 -960 960 960").
   Generated from the official set by scripts/material_icons.py in the Aura
   repo. Inline <path> rather than <use href="#id">: the sprite technique
   silently rendered nothing in the WebKit/Chromium builds this remote had to
   support. */
const MS_ICONS = {
  play_arrow: "M320-273v-414q0-17 12-28.5t28-11.5q5 0 10.5 1.5T381-721l326 207q9 6 13.5 15t4.5 19q0 10-4.5 19T707-446L381-239q-5 3-10.5 4.5T360-233q-16 0-28-11.5T320-273Zm80-207Zm0 134 210-134-210-134v268Z",
  pause: "M600-200q-33 0-56.5-23.5T520-280v-400q0-33 23.5-56.5T600-760h80q33 0 56.5 23.5T760-680v400q0 33-23.5 56.5T680-200h-80Zm-320 0q-33 0-56.5-23.5T200-280v-400q0-33 23.5-56.5T280-760h80q33 0 56.5 23.5T440-680v400q0 33-23.5 56.5T360-200h-80Zm320-80h80v-400h-80v400Zm-320 0h80v-400h-80v400Zm0-400v400-400Zm320 0v400-400Z",
  skip_next: "M660-280v-400q0-17 11.5-28.5T700-720q17 0 28.5 11.5T740-680v400q0 17-11.5 28.5T700-240q-17 0-28.5-11.5T660-280Zm-440-35v-330q0-18 12-29t28-11q5 0 11 1t11 5l248 166q9 6 13.5 14.5T548-480q0 10-4.5 18.5T530-447L282-281q-5 4-11 5t-11 1q-16 0-28-11t-12-29Zm80-165Zm0 90 136-90-136-90v180Z",
  skip_previous: "M220-280v-400q0-17 11.5-28.5T260-720q17 0 28.5 11.5T300-680v400q0 17-11.5 28.5T260-240q-17 0-28.5-11.5T220-280Zm458-1L430-447q-9-6-13.5-14.5T412-480q0-10 4.5-18.5T430-513l248-166q5-4 11-5t11-1q16 0 28 11t12 29v330q0 18-12 29t-28 11q-5 0-11-1t-11-5Zm-18-199Zm0 90v-180l-136 90 136 90Z",
  shuffle: "M600-160q-17 0-28.5-11.5T560-200q0-17 11.5-28.5T600-240h64l-99-99q-12-12-11.5-28.5T566-396q12-12 28.5-12t28.5 12l97 98v-62q0-17 11.5-28.5T760-400q17 0 28.5 11.5T800-360v160q0 17-11.5 28.5T760-160H600Zm-428-12q-11-11-11-28t11-28l492-492h-64q-17 0-28.5-11.5T560-760q0-17 11.5-28.5T600-800h160q17 0 28.5 11.5T800-760v160q0 17-11.5 28.5T760-560q-17 0-28.5-11.5T720-600v-64L228-172q-11 11-28 11t-28-11Zm-1-560q-11-11-11-28t11-28q11-11 27.5-11t28.5 11l168 167q11 11 11.5 27.5T395-565q-11 11-28 11t-28-11L171-732Z",
  repeat: "m274-200 34 34q12 12 11.5 28T308-110q-12 12-28.5 12.5T251-109L148-212q-6-6-8.5-13t-2.5-15q0-8 2.5-15t8.5-13l103-103q12-12 28.5-11.5T308-370q11 12 11.5 28T308-314l-34 34h406v-120q0-17 11.5-28.5T720-440q17 0 28.5 11.5T760-400v120q0 33-23.5 56.5T680-200H274Zm412-480H280v120q0 17-11.5 28.5T240-520q-17 0-28.5-11.5T200-560v-120q0-33 23.5-56.5T280-760h406l-34-34q-12-12-11.5-28t11.5-28q12-12 28.5-12.5T709-851l103 103q6 6 8.5 13t2.5 15q0 8-2.5 15t-8.5 13L709-589q-12 12-28.5 11.5T652-590q-11-12-11.5-28t11.5-28l34-34Z",
  repeat_one: "M460-540h-30q-13 0-21.5-8.5T400-570q0-13 8.5-21.5T430-600h50q17 0 28.5 11.5T520-560v170q0 13-8.5 21.5T490-360q-13 0-21.5-8.5T460-390v-150ZM274-200l34 34q12 12 11.5 28T308-110q-12 12-28.5 12.5T251-109L148-212q-6-6-8.5-13t-2.5-15q0-8 2.5-15t8.5-13l103-103q12-12 28.5-11.5T308-370q11 12 11.5 28T308-314l-34 34h406v-120q0-17 11.5-28.5T720-440q17 0 28.5 11.5T760-400v120q0 33-23.5 56.5T680-200H274Zm412-480H280v120q0 17-11.5 28.5T240-520q-17 0-28.5-11.5T200-560v-120q0-33 23.5-56.5T280-760h406l-34-34q-12-12-11.5-28t11.5-28q12-12 28.5-12.5T709-851l103 103q6 6 8.5 13t2.5 15q0 8-2.5 15t-8.5 13L709-589q-12 12-28.5 11.5T652-590q-11-12-11.5-28t11.5-28l34-34Z",
  expand_more: "M480-362q-8 0-15-2.5t-13-8.5L268-557q-11-11-11-28t11-28q11-11 28-11t28 11l156 156 156-156q11-11 28-11t28 11q11 11 11 28t-11 28L508-373q-6 6-13 8.5t-15 2.5Z",
  close: "M480-424 284-228q-11 11-28 11t-28-11q-11-11-11-28t11-28l196-196-196-196q-11-11-11-28t11-28q11-11 28-11t28 11l196 196 196-196q11-11 28-11t28 11q11 11 11 28t-11 28L536-480l196 196q11 11 11 28t-11 28q-11 11-28 11t-28-11L480-424Z",
  keyboard_arrow_up: "M480-528 324-372q-11 11-28 11t-28-11q-11-11-11-28t11-28l184-184q12-12 28-12t28 12l184 184q11 11 11 28t-11 28q-11 11-28 11t-28-11L480-528Z",
  keyboard_arrow_down: "M480-361q-8 0-15-2.5t-13-8.5L268-556q-11-11-11-28t11-28q11-11 28-11t28 11l156 156 156-156q11-11 28-11t28 11q11 11 11 28t-11 28L508-372q-6 6-13 8.5t-15 2.5Z",
  keyboard_arrow_left: "m432-480 156 156q11 11 11 28t-11 28q-11 11-28 11t-28-11L348-452q-6-6-8.5-13t-2.5-15q0-8 2.5-15t8.5-13l184-184q11-11 28-11t28 11q11 11 11 28t-11 28L432-480Z",
  keyboard_arrow_right: "M504-480 348-636q-11-11-11-28t11-28q11-11 28-11t28 11l184 184q6 6 8.5 13t2.5 15q0 8-2.5 15t-8.5 13L404-268q-11 11-28 11t-28-11q-11-11-11-28t11-28l156-156Z",
  logout: "M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h240q17 0 28.5 11.5T480-800q0 17-11.5 28.5T440-760H200v560h240q17 0 28.5 11.5T480-160q0 17-11.5 28.5T440-120H200Zm487-320H400q-17 0-28.5-11.5T360-480q0-17 11.5-28.5T400-520h287l-75-75q-11-11-11-27t11-28q11-12 28-12.5t29 11.5l143 143q12 12 12 28t-12 28L669-309q-12 12-28.5 11.5T612-310q-11-12-10.5-28.5T613-366l74-74Z",
  screen_share: "M440-520h80v56q0 7 6 9.5t11-2.5l89-89q6-6 6-14t-6-14l-89-89q-5-5-11-2.5t-6 9.5v56h-80q-50 0-85 35t-35 85v40q0 17 11.5 28.5T360-400q17 0 28.5-11.5T400-440v-40q0-17 11.5-28.5T440-520ZM80-120q-17 0-28.5-11.5T40-160q0-17 11.5-28.5T80-200h800q17 0 28.5 11.5T920-160q0 17-11.5 28.5T880-120H80Zm80-120q-33 0-56.5-23.5T80-320v-440q0-33 23.5-56.5T160-840h640q33 0 56.5 23.5T880-760v440q0 33-23.5 56.5T800-240H160Zm0-80h640v-440H160v440Zm0 0v-440 440Z",
  lyrics: "M160-320v-480 480Zm440 80H240l-92 92q-19 19-43.5 8.5T80-177v-623q0-33 23.5-56.5T160-880h440q33 0 56.5 23.5T680-800v40q0 17-11.5 28.5T640-720q-17 0-28.5-11.5T600-760v-40H160v480h440v-120q0-17 11.5-28.5T640-480q17 0 28.5 11.5T680-440v120q0 33-23.5 56.5T600-240ZM280-400h80q17 0 28.5-11.5T400-440q0-17-11.5-28.5T360-480h-80q-17 0-28.5 11.5T240-440q0 17 11.5 28.5T280-400Zm480-80q-50 0-85-35t-35-85q0-50 35-85t85-35q11 0 21 2t19 5v-167q0-17 11.5-28.5T840-920h80q17 0 28.5 11.5T960-880q0 17-11.5 28.5T920-840h-40v240q0 50-35 85t-85 35Zm-480-40h200q17 0 28.5-11.5T520-560q0-17-11.5-28.5T480-600H280q-17 0-28.5 11.5T240-560q0 17 11.5 28.5T280-520Zm0-120h200q17 0 28.5-11.5T520-680q0-17-11.5-28.5T480-720H280q-17 0-28.5 11.5T240-680q0 17 11.5 28.5T280-640Z",
  graphic_eq: "M280-280v-400q0-17 11.5-28.5T320-720q17 0 28.5 11.5T360-680v400q0 17-11.5 28.5T320-240q-17 0-28.5-11.5T280-280Zm160 160v-720q0-17 11.5-28.5T480-880q17 0 28.5 11.5T520-840v720q0 17-11.5 28.5T480-80q-17 0-28.5-11.5T440-120ZM120-440v-80q0-17 11.5-28.5T160-560q17 0 28.5 11.5T200-520v80q0 17-11.5 28.5T160-400q-17 0-28.5-11.5T120-440Zm480 160v-400q0-17 11.5-28.5T640-720q17 0 28.5 11.5T680-680v400q0 17-11.5 28.5T640-240q-17 0-28.5-11.5T600-280Zm160-160v-80q0-17 11.5-28.5T800-560q17 0 28.5 11.5T840-520v80q0 17-11.5 28.5T800-400q-17 0-28.5-11.5T760-440Z",
  library_music: "M500-360q42 0 71-29t29-71v-220h80q17 0 28.5-11.5T720-720q0-17-11.5-28.5T680-760h-80q-17 0-28.5 11.5T560-720v180q-13-10-28-15t-32-5q-42 0-71 29t-29 71q0 42 29 71t71 29ZM320-240q-33 0-56.5-23.5T240-320v-480q0-33 23.5-56.5T320-880h480q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H320Zm0-80h480v-480H320v480ZM160-80q-33 0-56.5-23.5T80-160v-520q0-17 11.5-28.5T120-720q17 0 28.5 11.5T160-680v520h520q17 0 28.5 11.5T720-120q0 17-11.5 28.5T680-80H160Zm160-720v480-480Z",
  queue_music: "M640-160q-50 0-85-35t-35-85q0-50 35-85t85-35q11 0 21 1.5t19 6.5v-288q0-17 11.5-28.5T720-720h120q17 0 28.5 11.5T880-680q0 17-11.5 28.5T840-640h-80v360q0 50-35 85t-85 35ZM160-320q-17 0-28.5-11.5T120-360q0-17 11.5-28.5T160-400h240q17 0 28.5 11.5T440-360q0 17-11.5 28.5T400-320H160Zm0-160q-17 0-28.5-11.5T120-520q0-17 11.5-28.5T160-560h400q17 0 28.5 11.5T600-520q0 17-11.5 28.5T560-480H160Zm0-160q-17 0-28.5-11.5T120-680q0-17 11.5-28.5T160-720h400q17 0 28.5 11.5T600-680q0 17-11.5 28.5T560-640H160Z",
  search: "M380-320q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l224 224q11 11 11 28t-11 28q-11 11-28 11t-28-11L532-372q-30 24-69 38t-83 14Zm0-80q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z",
  music_note: "M400-120q-66 0-113-47t-47-113q0-66 47-113t113-47q23 0 42.5 5.5T480-418v-382q0-17 11.5-28.5T520-840h160q17 0 28.5 11.5T720-800v80q0 17-11.5 28.5T680-680H560v400q0 66-47 113t-113 47Z",
  settings_remote: "M360-40q-17 0-28.5-11.5T320-80v-480q0-17 11.5-28.5T360-600h240q17 0 28.5 11.5T640-560v480q0 17-11.5 28.5T600-40H360Zm120-350q21 0 35.5-14.5T530-440q0-21-14.5-35.5T480-490q-21 0-35.5 14.5T430-440q0 21 14.5 35.5T480-390Zm0-330q-30 0-58 8t-53 25q-14 9-31 8.5T310-690q-12-12-11.5-28t13.5-26q36-27 79-41.5t89-14.5q46 0 89 14.5t79 41.5q13 10 13.5 26T650-690q-11 11-27 12t-30-8q-25-17-54-25.5t-59-8.5Zm0-160q-62 0-119 19.5T257-803q-14 11-31 11.5T197-803q-12-12-12-29t14-28q60-48 131.5-74T480-960q78 0 150 25.5T760-859q13 11 13.5 28T762-802q-11 11-27.5 11.5T705-801q-48-39-105-59t-120-20Zm-80 760h160v-400H400v400Zm0 0h160-160Z",
  refresh: "M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-70q0-17 11.5-28.5T760-800q17 0 28.5 11.5T800-760v200q0 17-11.5 28.5T760-520H560q-17 0-28.5-11.5T520-560q0-17 11.5-28.5T560-600h128q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q68 0 124.5-34.5T692-367q8-14 22.5-19.5t29.5-.5q16 5 23 21t-1 30q-41 80-117 128t-169 48Z",
  check: "m382-354 339-339q12-12 28-12t28 12q12 12 12 28.5T777-636L410-268q-12 12-28 12t-28-12L182-440q-12-12-11.5-28.5T183-497q12-12 28.5-12t28.5 12l142 143Z",
  cast: "M480-480Zm400-240v480q0 33-23.5 56.5T800-160H638q-17 0-28.5-11.5T598-200q0-17 11.5-28.5T638-240h162v-480H160v6q0 17-11.5 28.5T120-674q-17 0-28.5-11.5T80-714v-6q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720ZM320-160q-16 0-28-9.5T277-195q-11-63-56.5-107T112-357q-15-2-23.5-14.5T80-400q0-17 11-28.5t26-9.5q94 12 160.5 79T357-198q2 16-9 27t-28 11Zm160 0q-17 0-28.5-11T438-199q-14-128-104.5-217T115-518q-16-2-25.5-14T80-560q0-17 10.5-29t25.5-10q161 13 274 125t128 273q2 17-9.5 29T480-160Zm-350 0q-21 0-35.5-14.5T80-210q0-21 14.5-35.5T130-260q21 0 35.5 14.5T180-210q0 21-14.5 35.5T130-160Z",
  playlist_play: "M160-320q-17 0-28.5-11.5T120-360q0-17 11.5-28.5T160-400h240q17 0 28.5 11.5T440-360q0 17-11.5 28.5T400-320H160Zm0-160q-17 0-28.5-11.5T120-520q0-17 11.5-28.5T160-560h400q17 0 28.5 11.5T600-520q0 17-11.5 28.5T560-480H160Zm0-160q-17 0-28.5-11.5T120-680q0-17 11.5-28.5T160-720h400q17 0 28.5 11.5T600-680q0 17-11.5 28.5T560-640H160Zm511 499q-5 3-10 3t-10-2q-5-2-8-6.5t-3-10.5v-246q0-6 3-10.5t8-6.5q5-2 10-2t10 3l184 122q5 3 7 7.5t2 9.5q0 5-2 9.5t-7 7.5L671-141Z"
};

function msIcon(name, cls = 'ic') {
  return `<svg class="${cls}" viewBox="0 -960 960 960" aria-hidden="true"><path d="${MS_ICONS[name]}"/></svg>`;
}

/* ---------------- polling ---------------- */

async function tick() {
  if (document.hidden) return;
  try {
    await refreshTargets();
    await refreshNowPlaying();
    if (!state.sessions.length && !state.np && !state.launching) launchAura(false);
    renderNowPlaying();
  } catch (e) {
    if (e.message === 'unauthorized') logout();
  }
}

function startPolling() {
  tick();
  clearInterval(state.timer);
  state.timer = setInterval(tick, POLL_MS);
}

/* ---------------- launching ---------------- */

async function launchAura(manual = false) {
  if (state.launching) return;
  if (!manual && !state.autoLaunch) return;
  if (!manual && Date.now() - state.lastLaunch < 45000) return;

  state.launching = true;
  state.lastLaunch = Date.now();
  state.launchError = '';
  renderNowPlaying();

  try {
    const res = await bridgeFetch(`/api/launch`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.text()).slice(0, 140));
    toast('Aura starting…', 2500);
    setTimeout(tick, 3000);
  } catch (e) {
    state.launchError = e.message || 'launch failed';
  } finally {
    state.launching = false;
    renderNowPlaying();
  }
}

/* ---------------- connect-style control ---------------- */

// false when the selected TV is not the linked one, so callers fall back to Jellyfin.
async function controlAura(action, extra = {}) {
  if (!linkReachesTarget()) return false;
  try {
    const res = await bridgeFetch(`/api/aura/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    });
    if (!res.ok) throw new Error(await res.text());
    setTimeout(pollMirror, 400);
    return true;
  } catch {
    return false;
  }
}

const MAX_PLAY_IDS = 150;

async function skipTo(index) {
  if (await controlAura('skip', { index })) return;
  const t = state.target;
  // The linked TV's queue is the mirror's, capped at 300: replaying it would drop the rest.
  if (t?.kind !== 'aura' || targetIsLinked()) return;
  // Jellyfin has no "jump within the queue": replay the same queue from there.
  // Long queues become the next MAX_PLAY_IDS tracks to keep the URL under server limits.
  let ids = state.queue.map(q => q.id);
  let start = index;
  if (ids.length > MAX_PLAY_IDS) {
    ids = ids.slice(index, index + MAX_PLAY_IDS);
    start = 0;
    toast(`Queue trimmed to the next ${ids.length} tracks`, 2500);
  }
  if (!ids.length) return;
  await api(`/Sessions/${t.sessionId}/Playing?playCommand=PlayNow&itemIds=${ids.join(',')}&startIndex=${start}`, { method: 'POST' });
  setTimeout(tick, 600);
}

/* ---------------- transport ---------------- */

async function sendTransport(action) {
  const t = state.target;
  if (!t) return;
  if (t.kind === 'aura') {
    const direct = { play: 'play', pause: 'pause', playpause: 'playpause', next: 'next', prev: 'prev' }[action];
    if (direct && await controlAura(direct)) return;
    const map = { play: 'Unpause', pause: 'Pause', playpause: 'PlayPause', stop: 'Stop', next: 'NextTrack', prev: 'PreviousTrack' };
    await api(`/Sessions/${t.sessionId}/Playing/${map[action]}`, { method: 'POST' });
  } else {
    await bridgeFetch(`/api/transport`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: t.label, action }),
    });
  }
  setTimeout(tick, 350);
}

async function toggleRepeat() {
  const t = state.target;
  if (t?.kind !== 'aura') return;
  const order = ['RepeatNone', 'RepeatAll', 'RepeatOne'];
  const next = order[(order.indexOf(state.repeat) + 1) % order.length];
  const mode = { RepeatNone: 0, RepeatOne: 1, RepeatAll: 2 }[next];
  if (!(await controlAura('repeat', { mode }))) {
    await api(`/Sessions/${t.sessionId}/Command`, {
      method: 'POST', body: { Name: 'SetRepeatMode', Arguments: { RepeatMode: next } },
    });
  }
  state.repeat = next;
  toast(next === 'RepeatNone' ? 'Repeat off' : next === 'RepeatAll' ? 'Repeat all' : 'Repeat one');
  setTimeout(tick, 300);
}

async function toggleShuffle() {
  const t = state.target;
  if (t?.kind !== 'aura') return;
  state.shuffle = !state.shuffle;
  if (!(await controlAura('shuffle', { on: state.shuffle }))) {
    await api(`/Sessions/${t.sessionId}/Command`, {
      method: 'POST', body: { Name: 'SetShuffleQueue', Arguments: { Shuffle: String(state.shuffle) } },
    });
  }
  toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
  setTimeout(tick, 300);
}

async function doSeek(pct) {
  const dur = state.np?.duration || 0;
  const t = state.target;
  if (!dur || !t) return;
  const seconds = (pct / 1000) * dur;
  if (t.kind === 'aura') {
    if (await controlAura('seek', { position: Math.round(seconds * 1000) })) return;
    await api(`/Sessions/${t.sessionId}/Playing/Seek?seekPositionTicks=${Math.round(seconds * 1e7)}`, { method: 'POST' });
  } else {
    await bridgeFetch(`/api/seek`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: t.label, position_s: seconds }),
    });
  }
  setTimeout(tick, 400);
}

/* ---------------- playback ---------------- */

async function playItems(ids) {
  const t = state.target;
  if (!t || !ids.length) { toast('No target available'); return; }

  if (t.kind === 'aura') {
    await api(`/Sessions/${t.sessionId}/Playing?playCommand=PlayNow&itemIds=${ids.join(',')}`, { method: 'POST' });
    toast(ids.length > 1 ? `Queued ${ids.length} tracks` : 'Sent to Aura');
  } else {
    const params = new URLSearchParams({
      UserId: state.userId, DeviceId: state.deviceId, Container: 'mp4', AudioCodec: 'copy',
      TranscodingContainer: 'mp4', TranscodingProtocol: 'http', api_key: state.token,
    });
    const res = await bridgeFetch(`/api/load`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: t.label,
        url: `${state.server}/Audio/${ids[0]}/universal?${params}`,
        content_type: 'audio/mp4',
      }),
    });
    if (!res.ok) { toast(`Cast failed: ${(await res.text()).slice(0, 90)}`, 5000); return; }
    toast(ids.length > 1 ? `Casting first of ${ids.length} (Cast has no queue)` : `Casting to ${t.label}`);
  }
  setTimeout(tick, 800);
}

/* ---------------- Atmos catalogue ---------------- */

function isAtmosTrack(item) {
  return (item.MediaSources || []).some(src =>
    (src.MediaStreams || []).some(s =>
      String(s.Codec || '').toLowerCase() === 'eac3' &&
      (/joc/i.test(s.Profile || '') || /dolby atmos/i.test(s.Profile || ''))));
}

async function buildAtmosCatalog(force = false) {
  const cacheKey = `atmos:${state.server}:${state.userId}`;
  if (!force) {
    const cached = store.get(cacheKey);
    if (cached && Date.now() - cached.at < ATMOS_TTL_MS) {
      state.atmos = new Set(cached.ids);
      refreshBadges();
      return;
    }
  }

  const ids = new Set();
  let start = 0;
  const pageSize = 500;
  try {
    for (let page = 0; page < 20; page++) {
      const res = await api(`/Users/${state.userId}/Items?IncludeItemTypes=Audio&Recursive=true&Fields=MediaSources&Limit=${pageSize}&StartIndex=${start}`);
      if (!res.ok) break;
      const data = await res.json();
      const items = data.Items || [];
      items.forEach(t => { if (isAtmosTrack(t) && t.AlbumId) ids.add(t.AlbumId); });
      if (!items.length || start + pageSize >= (data.TotalRecordCount || 0)) break;
      start += pageSize;
    }
    state.atmos = ids;
    store.set(cacheKey, { at: Date.now(), ids: [...ids] });
  } catch {
    state.atmos = ids;
  }
  refreshBadges();
}

function refreshBadges() {
  document.querySelectorAll('[data-album-badge]').forEach(el => {
    el.innerHTML = state.atmos?.has(el.dataset.albumBadge) ? '<span class="atmos">ATMOS</span>' : '';
  });
}

/* ---------------- library ---------------- */

async function loadLibrary() {
  const body = $('libraryBody');
  const term = $('search').value.trim();
  body.innerHTML = '<div class="muted small" style="padding:8px 4px">Loading…</div>';

  const base = `/Users/${state.userId}/Items?Recursive=true&Limit=200&ImageTypeLimit=1&EnableImageTypes=Primary&SortBy=SortName`;
  let url;
  if (term) {
    url = `/Users/${state.userId}/Items?Recursive=true&Limit=60&ImageTypeLimit=1&EnableImageTypes=Primary&searchTerm=${encodeURIComponent(term)}&IncludeItemTypes=MusicAlbum,MusicArtist,Audio`;
  } else if (state.lib === 'albums') {
    url = `${base}&IncludeItemTypes=MusicAlbum&Fields=ProductionYear,AlbumArtist`;
  } else if (state.lib === 'artists') {
    url = `${base}&IncludeItemTypes=MusicArtist`;
  } else {
    url = `${base}&IncludeItemTypes=Audio&Fields=Album,Artists,AlbumId`;
  }

  try {
    const res = await api(url);
    if (!res.ok) { body.innerHTML = '<div class="muted small">Library unavailable.</div>'; return; }
    const items = (await res.json()).Items || [];
    if (term) return renderSearch(items);
    if (state.lib === 'artists') return renderArtistList(items);
    if (state.lib === 'tracks') return renderTrackList(items);
    return renderAlbumGrid(items);
  } catch {
    body.innerHTML = '<div class="muted small">Library unavailable.</div>';
  }
}

function renderAlbumGrid(items) {
  if (!items.length) { $('libraryBody').innerHTML = '<div class="muted small">Nothing here.</div>'; return; }
  $('libraryBody').innerHTML = `<div class="albums">${items.map(a => `
    <div class="album" data-album="${a.Id}">
      <img loading="lazy" src="${imageUrl(a, 320)}" alt="">
      <div class="t">${escapeHtml(a.Name)}</div>
      <div class="s">${escapeHtml(a.AlbumArtist || a.Artists?.join(', ') || '')}</div>
      <div data-album-badge="${a.Id}"></div>
    </div>`).join('')}</div>`;
  refreshBadges();
}

function renderArtistList(items) {
  $('libraryBody').innerHTML = items.map(a => `
    <div class="row" data-artist="${a.Id}">
      <img class="rowart" loading="lazy" src="${imageUrl(a, 160)}" alt="">
      <div class="n"><div>${escapeHtml(a.Name)}</div><div class="muted small">Artist</div></div>
    </div>`).join('') || '<div class="muted small">No artists.</div>';
}

function renderTrackList(items) {
  $('libraryBody').innerHTML = items.map((t, i) => `
    <div class="row" data-track="${t.Id}">
      <div class="idx">${i + 1}</div>
      <div class="n">
        <div>${escapeHtml(t.Name)}</div>
        <div class="muted small">${escapeHtml(t.Artists?.join(', ') || '')}${t.Album ? ' · ' + escapeHtml(t.Album) : ''}</div>
      </div>
      <div data-album-badge="${t.AlbumId || ''}"></div>
    </div>`).join('') || '<div class="muted small">No tracks.</div>';
  refreshBadges();
}

function renderSearch(items) {
  const albums = items.filter(i => i.Type === 'MusicAlbum');
  const artists = items.filter(i => i.Type === 'MusicArtist');
  const tracks = items.filter(i => i.Type === 'Audio');
  const parts = [];
  if (artists.length) {
    parts.push(`<h2>Artists</h2>${artists.map(a => `
      <div class="row" data-artist="${a.Id}"><div class="n"><div>${escapeHtml(a.Name)}</div></div></div>`).join('')}`);
  }
  if (albums.length) {
    parts.push(`<h2>Albums</h2><div class="albums">${albums.map(a => `
      <div class="album" data-album="${a.Id}">
        <img loading="lazy" src="${imageUrl(a, 200)}" alt="">
        <div class="t">${escapeHtml(a.Name)}</div>
        <div data-album-badge="${a.Id}"></div>
      </div>`).join('')}</div>`);
  }
  if (tracks.length) {
    parts.push(`<h2>Tracks</h2>${tracks.map(t => `
      <div class="row" data-track="${t.Id}">
        <div class="n"><div>${escapeHtml(t.Name)}</div><div class="muted small">${escapeHtml(t.Artists?.join(', ') || '')}</div></div>
      </div>`).join('')}`);
  }
  $('libraryBody').innerHTML = parts.join('') || '<div class="muted small">No matches.</div>';
  refreshBadges();
}

/* ---------------- detail sheets ---------------- */

function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheet(id) { $(id).classList.add('hidden'); }

async function openAlbum(albumId, fromMirror = false) {
  state.sheetAlbumId = albumId;
  if (!fromMirror) navigateTV('collection', albumId);
  const [metaRes, trackRes] = await Promise.all([
    api(`/Users/${state.userId}/Items/${albumId}`),
    api(`/Users/${state.userId}/Items?ParentId=${albumId}&IncludeItemTypes=Audio&Recursive=true&SortBy=ParentIndexNumber,IndexNumber&Limit=200&Fields=MediaSources`),
  ]);
  const album = metaRes.ok ? await metaRes.json() : {};
  const tracks = trackRes.ok ? (await trackRes.json()).Items || [] : [];

  $('sheetTitle').textContent = album.Name || '';
  $('sheetSub').textContent = [album.AlbumArtist || album.Artists?.join(', '), album.ProductionYear].filter(Boolean).join(' · ');
  const src = imageUrl(album, 200);
  $('sheetArt').src = src;
  $('sheetArt').style.visibility = src ? 'visible' : 'hidden';

  const atmos = tracks.some(isAtmosTrack);
  $('sheetActions').innerHTML = `
    <button class="btn primary" data-play-all="${tracks.map(t => t.Id).join(',')}">
      ${msIcon('play_arrow')}Play album</button>
    ${atmos ? '<span class="atmos">ATMOS</span>' : ''}`;

  $('sheetList').innerHTML = tracks.map((t, i) => `
    <div class="row" data-track="${t.Id}">
      <div class="idx">${t.IndexNumber ?? i + 1}</div>
      <div class="n">
        <div>${escapeHtml(t.Name)}</div>
        <div class="muted small">${escapeHtml(t.Artists?.join(', ') || '')}</div>
      </div>
      ${isAtmosTrack(t) ? '<span class="atmos">ATMOS</span>' : ''}
    </div>`).join('');

  openSheet('detailSheet');
}

async function openArtist(artistId, fromMirror = false) {
  state.sheetArtistId = artistId;
  if (!fromMirror) navigateTV('artist', artistId);
  const [metaRes, albumRes, trackRes] = await Promise.all([
    api(`/Users/${state.userId}/Items/${artistId}`),
    api(`/Users/${state.userId}/Items?AlbumArtistIds=${artistId}&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=ProductionYear,SortName&Limit=100&ImageTypeLimit=1&EnableImageTypes=Primary`),
    api(`/Users/${state.userId}/Items?ArtistIds=${artistId}&IncludeItemTypes=Audio&Recursive=true&SortBy=PlayCount,SortName&Limit=40&ImageTypeLimit=1&EnableImageTypes=Primary`),
  ]);
  const artist = metaRes.ok ? await metaRes.json() : {};
  const albums = albumRes.ok ? (await albumRes.json()).Items || [] : [];
  const tracks = trackRes.ok ? (await trackRes.json()).Items || [] : [];

  $('sheetTitle').textContent = artist.Name || '';
  $('sheetSub').textContent = `${albums.length} albums · ${tracks.length} top tracks`;
  const src = imageUrl(artist, 200);
  $('sheetArt').src = src;
  $('sheetArt').style.visibility = src ? 'visible' : 'hidden';
  $('sheetActions').innerHTML = '';

  $('sheetList').innerHTML = `
    <h2>Albums</h2>
    <div class="albums">${albums.map(a => `
      <div class="album" data-album="${a.Id}">
        <img loading="lazy" src="${imageUrl(a, 200)}" alt="">
        <div class="t">${escapeHtml(a.Name)}</div>
      </div>`).join('')}</div>
    <h2>Top tracks</h2>
    ${tracks.map(t => `
      <div class="row" data-track="${t.Id}">
        <div class="n"><div>${escapeHtml(t.Name)}</div><div class="muted small">${escapeHtml(t.Album || '')}</div></div>
      </div>`).join('')}`;

  openSheet('detailSheet');
}

/* ---------------- device sheet ---------------- */

function renderDeviceList() {
  const row = (t, current) => `
    <div class="row device ${current ? 'current' : ''}" data-device="${t.key}">
      ${msIcon(t.kind === 'aura' ? 'settings_remote' : 'cast', 'ic lead')}
      <div class="n">
        <div>${escapeHtml(t.label)}${t.emulator ? ' <span class="tag">emulator</span>' : ''}</div>
        <div class="muted small">${t.kind === 'aura' ? 'Aura' : 'Cast'} · ${escapeHtml(t.sub || '')}</div>
      </div>
      ${current ? '<span class="tag ok">selected</span>' : ''}
    </div>`;

  const aura = state.sessions.map(t => row(t, state.target?.key === t.key)).join('');
  const cast = state.castTargets.map(t => row(t, state.target?.key === t.key)).join('');

  $('deviceList').innerHTML = `
    <h2>Aura (remote control)</h2>
    ${aura || '<div class="muted small" style="padding:4px 6px">Aura is not running.</div>'}
    <h2>Cast targets</h2>
    ${cast || '<div class="muted small" style="padding:4px 6px">Bridge found no targets.</div>'}
    <button class="btn" id="rescan" style="margin-top:14px;width:100%">
      ${msIcon('refresh')}Rescan</button>`;
}

/* ---------------- remote: D-pad + mirror ---------------- */

async function sendKey(key) {
  if (!linkReachesTarget()) {
    $('dpadMsg').textContent = state.link.deviceName
      ? `The D-pad only reaches ${state.link.deviceName}, the TV this bridge is paired with.`
      : 'The D-pad only reaches the TV this bridge is paired with.';
    return;
  }
  const res = await bridgeFetch(`/api/aura/input`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  if (!res.ok) {
    $('dpadMsg').textContent = (await res.text()).slice(0, 140) || 'input failed';
    return;
  }
  $('dpadMsg').textContent = '';
  if (state.mirrorOn) setTimeout(pollMirror, 700);
}

async function pollMirror() {
  if (document.hidden) return;
  try {
    const res = await bridgeFetch(`/api/aura/state`);
    if (res.status === 401) { state.unpaired = true; renderPair(); return; }
    if (!res.ok) throw new Error('Aura mirror link unreachable');
    const snapshot = await res.json();
    if (state.unpaired) { state.unpaired = false; renderPair(); }
    state.deviceName = snapshot.deviceName || state.deviceName;
    state.link.deviceName = snapshot.deviceName || state.link.deviceName;
    if (!state.link.loaded) loadLink();
    // The link always answers for its own TV; another selected TV keeps the
    // queue Jellyfin reports for it and is never mirrored from this snapshot.
    if (!linkReachesTarget()) return;
    // Until the picker has found the remembered TV, the snapshot may be another TV's.
    if (!state.target && store.get('targetKey')) return;
    state.aura = snapshot;
    state.queue = snapshot.queue || [];
    state.queueIndex = snapshot.queueIndex || 0;
    renderQueue();
    if (state.mirrorOn) applyMirror(snapshot);
  } catch {
    /* TV asleep or Aura closed — keep the local view as it is */
  }
}

function renderPair() {
  const box = $('pairBox');
  if (!box) return;
  const show = state.unpaired || state.pairing || !!state.pairError;
  box.classList.toggle('hidden', !show);
  if (!show) return;

  $('pairMsg').textContent = state.pairing
    ? 'Waiting for you to allow this device on the TV…'
    : state.pairError
      ? `Pairing failed — ${state.pairError}`
      : "This remote isn't paired with the TV yet.";
  $('btnPair').textContent = state.pairing ? 'Waiting…' : 'Pair with TV';
  $('btnPair').disabled = state.pairing;
}

async function pairWithTv() {
  if (state.pairing) return;
  state.pairing = true;
  state.pairError = '';
  renderPair();
  try {
    const label = `Aura Remote (${navigator.platform || 'web'})`;
    const res = await bridgeFetch(`/api/aura/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: label }),
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 120));
    const data = await res.json();
    state.unpaired = false;
    toast(`Paired with ${data.device || 'the TV'}`);
    pollMirror();
  } catch (e) {
    state.pairError = e.message || 'no answer from the TV';
  } finally {
    state.pairing = false;
    renderPair();
  }
}

function renderQueue(force = false) {
  const list = $('queueList');
  if (!list) return;
  const q = state.queue || [];

  // Rebuilding the list on every poll resets its scroll position; only redraw
  // when the queue or the current index actually changed.
  const signature = q.map(t => t.id).join(',') + '#' + state.queueIndex;
  if (!force && signature === state.queueSig) return;
  state.queueSig = signature;
  $('queueCount').textContent = q.length ? `${state.queueIndex + 1} of ${q.length}` : 'empty';
  if (!q.length) {
    list.innerHTML = '<div class="muted small" style="padding:6px 4px">Aura has nothing queued.</div>';
    return;
  }
  list.innerHTML = q.map((t, i) => `
    <div class="row queue-row${i === state.queueIndex ? ' current' : ''}" data-queue="${i}">
      <div class="idx">${i + 1}</div>
      <div class="n">
        <div>${escapeHtml(t.title)}</div>
        <div class="muted small">${escapeHtml(t.artist || '')}</div>
      </div>
    </div>`).join('');
}

// Semantic mirror: Aura says which screen it is on, the remote draws its own
// native version of that screen.
function applyMirror(m) {
  if (!m || state.mirrorApplying) return;
  // Never yank the view out from under someone using the D-pad or reading the
  // queue: those tabs are theirs until they leave them.
  if (state.view === 'remote' || state.view === 'queue') return;

  // Applying the same screen over and over re-renders the list and throws away
  // the scroll position. Only act when the TV actually moved.
  const signature = `${m.screen}:${m.itemId || ''}`;
  if (signature === state.mirrorSig) return;
  state.mirrorSig = signature;
  state.mirrorApplying = true;
  try {
    if (m.screen === 'nowplaying') {
      setView('now');
      setLyricsVisible(!!m.lyrics);
    } else if (m.screen === 'collection' && m.itemId) {
      if (m.itemId !== state.sheetAlbumId) openAlbum(m.itemId, true);
    } else if (m.screen === 'artist' && m.itemId) {
      if (m.itemId !== state.sheetArtistId) openArtist(m.itemId, true);
    } else if (['albums', 'artists', 'tracks'].includes(m.screen)) {
      setView('library');
      selectLibTab(m.screen);
    } else if (m.screen === 'home') {
      setView('now');
    }
  } finally {
    state.mirrorApplying = false;
  }
}

/* ---------------- lyrics ---------------- */

async function setLyricsVisible(on) {
  state.lyricsOn = on;
  $('lyricsBox').classList.toggle('hidden', !on);
  $('btnLyrics').classList.toggle('on', on);
  if (!on) return;

  const itemId = state.np?.item?.Id;
  if (!itemId) { $('lyricsLines').innerHTML = '<div class="muted small">Nothing playing.</div>'; return; }
  if (state.lyricsFor === itemId && state.lyricsLines) { renderLyrics(); return; }

  try {
    const res = await api(`/Audio/${itemId}/Lyrics`);
    const data = res.ok ? await res.json() : {};
    const lines = (data.Lyrics || []).map(l => ({ text: (l.Text || '').trim(), start: (l.Start || 0) / 1e7 }));
    state.lyricsFor = itemId;
    state.lyricsLines = lines.length ? lines : null;
  } catch {
    state.lyricsFor = itemId;
    state.lyricsLines = null;
  }
  renderLyrics();
}

function renderLyrics() {
  const lines = state.lyricsLines || [];
  const pos = state.np?.position || 0;
  let active = -1;
  lines.forEach((l, i) => { if (l.start <= pos) active = i; });
  $('lyricsLines').innerHTML = lines.length
    ? lines.map((l, i) => `<div class="lyric${i === active ? ' active' : ''}">${escapeHtml(l.text)}</div>`).join('')
    : '<div class="muted small">No lyrics for this track.</div>';
}

// The state loop always runs — the queue and transport come from it even when
// mirroring is off. mirrorOn only decides whether the local view follows.
function startMirror() {
  pollMirror();
  clearInterval(state.mirrorTimer);
  state.mirrorTimer = setInterval(pollMirror, 2000);
}

function stopMirror() {
  setLyricsVisible(false);
}

// Remote -> TV: only when mirroring, and never when the mirror is the one
// moving the local view (that would bounce the two ends back and forth).
function navigateTV(screen, itemId) {
  if (!state.mirrorOn || state.mirrorApplying || !linkReachesTarget()) return;
  bridgeFetch(`/api/aura/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ screen, itemId: itemId || null }),
  }).catch(() => {});
}

/* ---------------- views ---------------- */

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(`view-${view}`).classList.remove('hidden');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if (view === 'library' && !$('libraryBody').children.length) loadLibrary();
  if (view === 'queue') renderQueue(true);
  // "Now" in the remote is Now Playing, not Aura's Home screen. Sending 'home'
  // here kicked the TV off Now Playing, so the mirror then chased it to Home.
  if (view === 'now') navigateTV('nowplaying');
  if (view === 'library') navigateTV(state.lib);
}

/* ---------------- wiring ---------------- */

$('loginBtn').addEventListener('click', login);
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

$('btnPlay').addEventListener('click', () => sendTransport(state.np?.playing ? 'pause' : 'play'));
$('btnNext').addEventListener('click', () => sendTransport('next'));
$('btnPrev').addEventListener('click', () => sendTransport('prev'));
$('btnRepeat').addEventListener('click', toggleRepeat);
$('btnLyrics').addEventListener('click', () => {
  setLyricsVisible(!state.lyricsOn);
  toast(state.lyricsOn ? 'Lyrics on' : 'Lyrics off', 1200);
});
$('btnPair').addEventListener('click', pairWithTv);
$('btnShuffle').addEventListener('click', toggleShuffle);
$('btnLaunch').addEventListener('click', () => launchAura(true));

$('autoChk').checked = state.autoLaunch;
$('autoChk').addEventListener('change', e => {
  state.autoLaunch = e.target.checked;
  store.set('autoLaunch', state.autoLaunch);
  if (state.autoLaunch) launchAura(false);
});

$('npSeek').addEventListener('input', () => { state.seeking = true; });
$('npSeek').addEventListener('change', e => doSeek(Number(e.target.value)).finally(() => { state.seeking = false; }));

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadLibrary, 280);
});

function selectLibTab(tab, { force = false } = {}) {
  if (!['albums', 'artists', 'tracks'].includes(tab)) return;
  const alreadyShowing = tab === state.lib
    && !$('search').value
    && $('libraryBody').children.length > 0;
  state.lib = tab;
  document.querySelectorAll('.seg').forEach(b => b.classList.toggle('active', b.dataset.lib === tab));
  if (alreadyShowing && !force) return;   // same tab: keep the scroll position
  $('search').value = '';
  loadLibrary();
}

document.querySelectorAll('.seg').forEach(btn => btn.addEventListener('click', () => {
  selectLibTab(btn.dataset.lib);
  navigateTV(btn.dataset.lib);
}));

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setView(t.dataset.view)));
document.querySelectorAll('[data-key]').forEach(btn => btn.addEventListener('click', () => sendKey(btn.dataset.key)));

$('targetBtn').addEventListener('click', async () => {
  await refreshTargets();
  renderDeviceList();
  openSheet('deviceSheet');
});

function renderMirrorBtn() {
  const btn = $('mirrorBtn');
  btn.classList.toggle('on', state.mirrorOn);
  btn.setAttribute('aria-pressed', String(state.mirrorOn));
  const reachable = linkReachesTarget();
  btn.classList.toggle('unavailable', !reachable);
  btn.title = !reachable ? mirrorUnavailableMsg()
    : state.mirrorOn ? 'Mirroring the TV — tap to stop' : 'Mirror the TV';
}

function mirrorUnavailableMsg() {
  return `Mirroring only follows ${state.link.deviceName || 'the TV this bridge is paired with'}`;
}

$('mirrorBtn').addEventListener('click', () => {
  state.mirrorOn = !state.mirrorOn;
  store.set('mirrorOn', state.mirrorOn);
  renderMirrorBtn();
  if (state.mirrorOn && !linkReachesTarget()) {
    toast(mirrorUnavailableMsg(), 2500);
  } else if (state.mirrorOn) {
    toast('Mirroring the TV');
    pollMirror();
  } else {
    stopMirror();
    toast('Mirroring off');
  }
});
renderMirrorBtn();

$('signOutBtn').addEventListener('click', () => {
  if (!confirm('Sign out of this remote?')) return;
  state.mirrorOn = false;
  store.set('mirrorOn', false);
  renderMirrorBtn();
  logout();
});

document.addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) { closeSheet(close.dataset.close); return; }

  const device = e.target.closest('[data-device]');
  if (device) { selectTarget(device.dataset.device); return; }

  if (e.target.closest('#rescan')) { refreshTargets().then(renderDeviceList); return; }

  const playAll = e.target.closest('[data-play-all]');
  if (playAll) {
    const ids = (playAll.dataset.playAll || '').split(',').filter(Boolean);
    if (ids.length) { playItems(ids); closeSheet('detailSheet'); }
    return;
  }

  const album = e.target.closest('[data-album]');
  if (album) { openAlbum(album.dataset.album); return; }

  const artist = e.target.closest('[data-artist]');
  if (artist) { openArtist(artist.dataset.artist); return; }

  const track = e.target.closest('[data-track]');
  if (track) { playItems([track.dataset.track]); return; }

  const queued = e.target.closest('[data-queue]');
  if (queued) { skipTo(Number(queued.dataset.queue)); return; }

  if (e.target.classList.contains('sheet')) closeSheet(e.target.id);
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

/* ---------------- boot ---------------- */

(function boot() {
  const saved = store.get('auth');
  if (saved) {
    state.server = saved.server;
    state.token = saved.token;
    state.userId = saved.userId;
    state.userName = saved.userName;
    enterApp();
  }
  // The bridge tells us which Jellyfin server it is configured for; the field
  // stays editable for anyone running this against a different install.
  $('server').value = store.get('lastServer') || '';
  fetch(`${state.bridge}/api/config`)
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => {
      if (cfg?.defaultServer && !$('server').value) $('server').value = cfg.defaultServer;
    })
    .catch(() => {});
})();