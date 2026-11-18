// Loads the real PWA (routing.js + app.js) into a sandbox with a stub DOM and a
// recording fetch, then checks where each control is sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const web = path.join(__dirname, '..', 'server', 'web');

function element() {
  const classes = new Set();
  return {
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      toggle: (c, on) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)),
      contains: c => classes.has(c),
    },
    addEventListener() {}, setAttribute() {}, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [],
    children: [], dataset: {}, style: {}, textContent: '', innerHTML: '', value: '',
  };
}

function loadApp() {
  const calls = [];
  const elements = new Map();
  let controlFails = false;
  let pairedFails = false;
  const bodies = {};
  const respond = (url) => {
    const override = Object.keys(bodies).find(part => url.includes(part));
    if (override) return { ok: true, status: 200, json: async () => bodies[override], text: async () => '' };
    if (pairedFails && url.includes('/api/aura/paired')) throw new Error('bridge down');
    if (controlFails && url.includes('/api/aura/control')) return { ok: false, status: 502, text: async () => 'down' };
    const body = url.includes('/api/aura/state')
      ? { deviceName: 'Living Room TV', queue: [{ id: 'q1', title: 'Linked', artist: '' }], queueIndex: 0 }
      : url.includes('/Items?') ? { Items: [{ Id: 'x1', Name: 'One' }, { Id: 'x2', Name: 'Two' }] }
      : url.includes('/api/aura/paired') ? { paired: true, link: '192.168.1.50:8099' }
      : {};
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const sandbox = {
    console,
    fetch: async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body }); return respond(String(url)); },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'http://bridge' },
    navigator: { platform: 'test' },
    confirm: () => true,
    document: {
      hidden: false,
      getElementById: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelectorAll: () => [],
      addEventListener() {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['routing.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(web, file), 'utf8'), sandbox, { filename: file });
  }
  const run = code => vm.runInContext(code, sandbox);
  run(`
    state.server = 'http://jf'; state.token = 't'; state.userId = 'u';
    state.link = { address: '192.168.1.50:8099', deviceName: 'Living Room TV' };
    state.sessions = [
      { kind: 'aura', key: 'aura:s1', label: 'Living Room TV', sessionId: 's1',
        raw: { Id: 's1', DeviceName: 'Living Room TV', RemoteEndPoint: '192.168.1.50' } },
      { kind: 'aura', key: 'aura:s2', label: 'Bedroom TV', sessionId: 's2',
        raw: { Id: 's2', DeviceName: 'Bedroom TV', RemoteEndPoint: '192.168.1.60',
               NowPlayingItem: { Id: 'x2', RunTimeTicks: 2000000000 },
               NowPlayingQueue: [{ Id: 'x1' }, { Id: 'x2' }] } },
    ];
  `);
  calls.length = 0;
  return {
    calls, run,
    failControl: () => { controlFails = true; },
    failPaired: on => { pairedFails = on; },
    respondWith: (urlPart, body) => { bodies[urlPart] = body; },
    select: key => { run(`state.target = state.sessions.find(s => s.key === '${key}'); state.np = { duration: 200 };`); calls.length = 0; },
    bridgeCalls: () => calls.filter(c => c.url.startsWith('http://bridge/api/aura/')),
    jellyfinCalls: () => calls.filter(c => c.url.startsWith('http://jf/')),
  };
}

test('transport for the linked TV goes over the mirror link', async () => {
  const app = loadApp();
  app.select('aura:s1');
  await app.run(`sendTransport('pause')`);
  assert.deepEqual(app.bridgeCalls().map(c => [c.url, JSON.parse(c.body).action]),
    [['http://bridge/api/aura/control', 'pause']]);
  assert.equal(app.jellyfinCalls().length, 0);
});

test('transport, seek, shuffle and repeat for another TV go to its Jellyfin session', async () => {
  const app = loadApp();
  app.select('aura:s2');
  await app.run(`sendTransport('pause')`);
  await app.run(`sendTransport('next')`);
  await app.run(`doSeek(500)`);
  await app.run(`toggleShuffle()`);
  await app.run(`toggleRepeat()`);
  assert.equal(app.bridgeCalls().length, 0);
  assert.deepEqual(app.jellyfinCalls().map(c => c.url), [
    'http://jf/Sessions/s2/Playing/Pause',
    'http://jf/Sessions/s2/Playing/NextTrack',
    'http://jf/Sessions/s2/Playing/Seek?seekPositionTicks=1000000000',
    'http://jf/Sessions/s2/Command',
    'http://jf/Sessions/s2/Command',
  ]);
});

test('D-pad and TV navigation are not sent to the linked TV while another TV is selected', async () => {
  const app = loadApp();
  app.select('aura:s2');
  app.run(`state.mirrorOn = true`);
  await app.run(`sendKey('up')`);
  app.run(`navigateTV('albums')`);
  assert.equal(app.bridgeCalls().length, 0);
  assert.match(app.run(`$('dpadMsg').textContent`), /Living Room TV/);
});

test('another TV shows its own Jellyfin queue, not the linked TV\'s', async () => {
  const app = loadApp();
  app.select('aura:s2');
  await app.run(`pollMirror()`);
  await app.run(`refreshNowPlaying()`);
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(state.queue.map(q => q.title))`)), ['One', 'Two']);
  assert.equal(app.run(`state.queueIndex`), 1);

  app.calls.length = 0;
  await app.run(`skipTo(0)`);
  assert.equal(app.bridgeCalls().length, 0);
  assert.deepEqual(app.jellyfinCalls().map(c => c.url),
    ['http://jf/Sessions/s2/Playing?playCommand=PlayNow&itemIds=x1,x2&startIndex=0']);
});

test('the linked TV keeps the mirror-link queue and skip', async () => {
  const app = loadApp();
  app.select('aura:s1');
  await app.run(`pollMirror()`);
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(state.queue.map(q => q.title))`)), ['Linked']);
  app.calls.length = 0;
  await app.run(`skipTo(0)`);
  assert.deepEqual(app.bridgeCalls().map(c => JSON.parse(c.body)), [{ action: 'skip', index: 0 }]);
});

test('a failed mirror skip on the linked TV does not replay its capped queue via Jellyfin', async () => {
  const app = loadApp();
  app.select('aura:s1');
  await app.run(`pollMirror()`);
  app.failControl();
  app.calls.length = 0;
  await app.run(`skipTo(0)`);
  assert.equal(app.jellyfinCalls().length, 0);
});

test('a jump in a long queue sends at most 150 tracks from the pick', async () => {
  const app = loadApp();
  app.select('aura:s2');
  app.run(`state.queue = Array.from({ length: 400 }, (_, i) => ({ id: 'id' + i, title: '', artist: '' }))`);
  await app.run(`skipTo(10)`);
  const url = new URL(app.jellyfinCalls()[0].url);
  const ids = url.searchParams.get('itemIds').split(',');
  assert.equal(ids.length, 150);
  assert.equal(ids[0], 'id10');
  assert.equal(url.searchParams.get('startIndex'), '0');
});

test('a remembered TV that is not found yet is not shown the linked TV\'s mirror', async () => {
  const app = loadApp();
  app.run(`state.target = null; store.get = k => (k === 'targetKey' ? 'aura:s2' : null)`);
  await app.run(`pollMirror()`);
  assert.equal(app.run(`state.aura`), null);
  assert.equal(app.run(`state.link.deviceName`), 'Living Room TV');
});

test('the link is identified from the bridge', async () => {
  const app = loadApp();
  app.run(`state.link = { address: '', deviceName: '' }`);
  await app.run(`loadLink()`);
  assert.equal(app.run(`state.link.address`), '192.168.1.50:8099');
});

test('a Cast target gets neither the linked TV\'s queue, skip nor navigation', async () => {
  const app = loadApp();
  app.run(`state.castTargets = [{ kind: 'cast', key: 'cast:k', label: 'Kitchen' }]; state.mirrorOn = true`);
  app.run(`state.target = state.castTargets[0]`);
  app.calls.length = 0;
  await app.run(`pollMirror()`);
  assert.equal(app.run(`state.queue.length`), 0);
  assert.equal(app.run(`state.aura`), null);
  app.run(`state.queue = [{ id: 'q1' }, { id: 'q2' }]`);
  await app.run(`skipTo(1)`);
  app.run(`navigateTV('albums')`);
  assert.deepEqual(app.bridgeCalls().map(c => c.url).filter(u => !u.endsWith('/paired')), ['http://bridge/api/aura/state']);
  assert.equal(app.jellyfinCalls().length, 0);
});

test('a queue still loading for the previous TV does not replace the new TV\'s', async () => {
  const app = loadApp();
  app.select('aura:s2');
  const pending = app.run(`refreshNowPlaying()`);
  app.run(`state.target = state.sessions[0]; state.queue = [{ id: 'q1', title: 'Linked' }]`);
  await pending;
  assert.deepEqual(JSON.parse(app.run(`JSON.stringify(state.queue.map(q => q.title))`)), ['Linked']);
});

test('the link is looked up again after the bridge was unreachable at startup', async () => {
  const app = loadApp();
  app.run(`state.link = { address: '', deviceName: '' }`);
  app.failPaired(true);
  await app.run(`loadLink()`);
  assert.equal(app.run(`state.link.address`), '');
  app.failPaired(false);
  app.select('aura:s1');
  await app.run(`pollMirror()`);
  await new Promise(r => setImmediate(r));
  assert.equal(app.run(`state.link.address`), '192.168.1.50:8099');
  app.calls.length = 0;
  await app.run(`pollMirror()`);
  assert.equal(app.bridgeCalls().filter(c => c.url.includes('/paired')).length, 0);
});

test('switching to the linked TV clears the D-pad warning and re-enables the Mirror chip', async () => {
  const app = loadApp();
  app.select('aura:s2');
  await app.run(`sendKey('up')`);
  app.run(`renderMirrorBtn()`);
  assert.equal(app.run(`$('mirrorBtn').classList.contains('unavailable')`), true);
  assert.match(app.run(`$('mirrorBtn').title`), /Living Room TV/);
  app.run(`selectTarget('aura:s1')`);
  assert.equal(app.run(`$('dpadMsg').textContent`), '');
  assert.equal(app.run(`$('mirrorBtn').classList.contains('unavailable')`), false);
});

test('a jump that drops earlier tracks of a long queue says how many remain', async () => {
  const app = loadApp();
  app.select('aura:s2');
  app.run(`state.queue = Array.from({ length: 200 }, (_, i) => ({ id: 'id' + i, title: '', artist: '' }))`);
  await app.run(`skipTo(100)`);
  assert.equal(new URL(app.jellyfinCalls()[0].url).searchParams.get('itemIds').split(',').length, 100);
  assert.equal(app.run(`$('toast').textContent`), 'Queue trimmed to the next 100 tracks');
});

test('falling back to a Cast target on its own clears the previous TV\'s queue', async () => {
  const app = loadApp();
  app.select('aura:s2');
  await app.run(`refreshNowPlaying()`);
  assert.equal(app.run(`state.queue.length`), 2);
  app.respondWith('/Sessions', []);
  app.respondWith('/api/targets', { targets: [{ name: 'Kitchen' }] });
  await app.run(`refreshTargets()`);
  assert.equal(app.run(`state.target.key`), 'cast:Kitchen');
  assert.equal(app.run(`state.queue.length`), 0);
  assert.equal(app.run(`state.np`), null);
});
