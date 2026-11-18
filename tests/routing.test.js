const test = require('node:test');
const assert = require('node:assert/strict');
const { hostOf, isLinkedSession, routeFor, queueFromSession } = require('../server/web/routing.js');

const living = { Id: 's1', DeviceName: 'Living Room TV', RemoteEndPoint: '192.168.1.50' };
const bedroom = { Id: 's2', DeviceName: 'Bedroom TV', RemoteEndPoint: '192.168.1.60' };
const sessions = [living, bedroom];
const link = { address: '192.168.1.50:8099', deviceName: 'Living Room TV' };

test('hostOf strips ports, schemes and IPv4-mapped prefixes', () => {
  assert.equal(hostOf('192.168.1.50:8099'), '192.168.1.50');
  assert.equal(hostOf('::ffff:192.168.1.50'), '192.168.1.50');
  assert.equal(hostOf('[fe80::1]:8099'), 'fe80::1');
  assert.equal(hostOf('http://TV.local:8099/'), 'tv.local');
  assert.equal(hostOf('fe80::1'), 'fe80::1');
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('the AURA_LINK TV is linked, any other TV is not', () => {
  assert.equal(isLinkedSession(living, sessions, link), true);
  assert.equal(isLinkedSession(bedroom, sessions, link), false);
});

test('an endpoint match alone identifies the linked TV', () => {
  assert.equal(isLinkedSession(living, sessions, { address: '192.168.1.50:8099', deviceName: '' }), true);
  assert.equal(isLinkedSession(bedroom, sessions, { address: '192.168.1.50:8099', deviceName: '' }), false);
});

test('a name match identifies the linked TV when Jellyfin sees another address', () => {
  // Emulator over adb forward, or Jellyfin behind NAT: endpoints never match.
  const emu = { DeviceName: 'sdk_gphone', RemoteEndPoint: '10.0.2.2' };
  assert.equal(isLinkedSession(emu, [emu], { address: '127.0.0.1:9099', deviceName: 'sdk_gphone' }), true);
});

test('two TVs sharing a name are told apart by endpoint only', () => {
  const a = { DeviceName: 'Android TV', RemoteEndPoint: '192.168.1.50' };
  const b = { DeviceName: 'Android TV', RemoteEndPoint: '192.168.1.60' };
  const shared = { address: '192.168.1.50:8099', deviceName: 'Android TV' };
  assert.equal(isLinkedSession(a, [a, b], shared), true);
  assert.equal(isLinkedSession(b, [a, b], shared), false);
  assert.equal(isLinkedSession(b, [a, b], { address: 'tv.local:8099', deviceName: 'Android TV' }), false);
});

test('duplicate sessions of the same TV still match by name', () => {
  const a = { DeviceName: 'Living Room TV', RemoteEndPoint: '192.168.1.50' };
  const stale = { DeviceName: 'Living Room TV', RemoteEndPoint: '192.168.1.50' };
  assert.equal(isLinkedSession(stale, [a, stale], { address: 'tv.local:8099', deviceName: 'Living Room TV' }), true);
});

test('an unidentified link matches nothing, so controls go through Jellyfin', () => {
  assert.equal(isLinkedSession(living, sessions, { address: '', deviceName: '' }), false);
  assert.equal(isLinkedSession(living, sessions, null), false);
});

test('routeFor picks link, jellyfin or cast', () => {
  assert.equal(routeFor({ kind: 'aura', raw: living }, sessions, link), 'link');
  assert.equal(routeFor({ kind: 'aura', raw: bedroom }, sessions, link), 'jellyfin');
  assert.equal(routeFor({ kind: 'cast', label: 'Kitchen' }, sessions, link), 'cast');
  assert.equal(routeFor(null, sessions, link), null);
});

test('queueFromSession reads Jellyfin\'s NowPlayingQueue', () => {
  const s = { NowPlayingItem: { Id: 'b' }, NowPlayingQueue: [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }] };
  assert.deepEqual(queueFromSession(s), { ids: ['a', 'b', 'c'], index: 1 });
  assert.deepEqual(queueFromSession({ NowPlayingQueue: [{ Id: 'a' }] }), { ids: ['a'], index: 0 });
  assert.deepEqual(queueFromSession(undefined), { ids: [], index: 0 });
});
