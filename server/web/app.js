/* Aura Remote — phone-first control for Aura on the TV.
 *
 * Three paths:
 *   aura — Jellyfin remote-control protocol (Aura already speaks it)
 *   cast — the homelab bridge loads a direct-play URL onto a Cast target
 *   tv   — ADB: launch Aura, D-pad input, screen mirroring
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
  aura: null,
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

function logout() {
  store.del('auth');
  clearInterval(state.timer);
  clearInterval(state.mirrorTimer);
  $('main').classList.add('hidden');
  $('login').classList.remove('hidden');
}

function enterApp() {
  $('login').classList.add('hidden');
  $('main').classList.remove('hidden');
  ensureBridgeSession();
  startPolling();
  loadLibrary();
  buildAtmosCatalog();
  startMirror();
}

/* ---------------- targets ---------------- */

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
}

function selectTarget(key) {
  const found = [...state.sessions, ...state.castTargets].find(t => t.key === key);
  if (!found) return;
  state.target = found;
  state.np = null;
  store.set('targetKey', key);
  renderTargetLabel();
  closeSheet('deviceSheet');
  toast(`Using ${found.label}`);
  tick();
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
    ? '<path d="M7 5h4v14H7zm6 0h4v14h-4z"/>'
    : '<path d="M8 5v14l11-7z"/>';

  const isAura = state.target?.kind === 'aura';
  $('btnRepeat').disabled = !isAura;
  $('btnShuffle').disabled = !isAura;
  $('btnRepeat').classList.toggle('on', state.repeat !== 'RepeatNone');
  $('btnShuffle').classList.toggle('on', !!state.shuffle);

  if (state.lyricsOn) {
    if (state.lyricsFor !== (np.item?.Id || null)) setLyricsVisible(true);
    else renderLyrics();
  }
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

async function controlAura(action, extra = {}) {
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
    <button class="btn primary" data-play-all="${tracks.map(t => t.Id).join(',')}">Play album</button>
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
    <button class="btn" id="rescan" style="margin-top:14px;width:100%">Rescan</button>`;
}

/* ---------------- remote: D-pad + mirror ---------------- */

async function sendKey(key) {
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

function renderQueue() {
  const list = $('queueList');
  if (!list) return;
  const q = state.queue || [];
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
  if (!state.mirrorOn || state.mirrorApplying) return;
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
  if (view === 'queue') renderQueue();
  if (view === 'now') navigateTV('home');
  if (view === 'library') navigateTV(state.lib);
}

/* ---------------- wiring ---------------- */

$('loginBtn').addEventListener('click', login);
$('pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

$('btnPlay').addEventListener('click', () => sendTransport(state.np?.playing ? 'pause' : 'play'));
$('btnNext').addEventListener('click', () => sendTransport('next'));
$('btnPrev').addEventListener('click', () => sendTransport('prev'));
$('btnRepeat').addEventListener('click', toggleRepeat);
$('btnLyrics').addEventListener('click', () => setLyricsVisible(!state.lyricsOn));
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

function selectLibTab(tab) {
  if (!['albums', 'artists', 'tracks'].includes(tab)) return;
  state.lib = tab;
  document.querySelectorAll('.seg').forEach(b => b.classList.toggle('active', b.dataset.lib === tab));
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
  btn.title = state.mirrorOn ? 'Mirroring the TV — tap to stop' : 'Mirror the TV';
}

$('mirrorBtn').addEventListener('click', () => {
  state.mirrorOn = !state.mirrorOn;
  store.set('mirrorOn', state.mirrorOn);
  renderMirrorBtn();
  if (state.mirrorOn) {
    toast('Mirroring the TV');
    pollMirror();
  } else {
    stopMirror();
    toast('Mirroring off');
  }
});
renderMirrorBtn();

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
  if (queued) { controlAura('skip', { index: Number(queued.dataset.queue) }); return; }

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