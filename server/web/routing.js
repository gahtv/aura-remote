/* Which TV a control goes to.
 *
 * The bridge is linked to exactly one Aura: the AURA_LINK TV. The device picker
 * lists every Aura session Jellyfin knows about, so the mirror link may only be
 * used when the selected session *is* that TV. Any other Aura is driven through
 * Jellyfin's remote-control API, which Aura also implements.
 *
 * Plain script in the browser (window.AuraRouting), CommonJS module under Node
 * for the tests in tests/.
 */
(function (root) {
  // "192.168.1.50:8099", "::ffff:192.168.1.50", "[fe80::1]:8099", "http://tv.local:8099/".
  // IPv6 comes back in one spelling (fe80:0:0:0:0:0:0:1) so equal addresses compare equal.
  function hostOf(address) {
    if (!address) return '';
    let s = String(address).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0];
    if (s.startsWith('[')) s = s.slice(1, s.indexOf(']'));
    else if ((s.match(/:/g) || []).length === 1) s = s.split(':')[0];
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return mapped[1];
    return (s.includes(':') && canonicalIpv6(s.split('%')[0])) || s;
  }

  function canonicalIpv6(s) {
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves[1] ? halves[1].split(':') : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
    if (fill < 0 || groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.map(g => parseInt(g, 16).toString(16)).join(':');
  }

  function isIp(host) {
    return /^\d+\.\d+\.\d+\.\d+$/.test(host) || canonicalIpv6(host) === host;
  }

  function isLoopback(host) {
    return host.startsWith('127.') || host === '0:0:0:0:0:0:0:1';
  }

  // session: a Jellyfin /Sessions entry. sessions: every Aura session in the
  // picker. link: { address: AURA_LINK, deviceName: the link's /state deviceName }.
  function isLinkedSession(session, sessions, link) {
    if (!session || !link) return false;
    const linkHost = hostOf(link.address);
    const endpoint = hostOf(session.RemoteEndPoint);
    if (linkHost && endpoint && linkHost === endpoint) return true;

    // Two different real addresses are two different TVs, whatever their names.
    // A loopback link (adb forward) says nothing about the TV's own address.
    if (isIp(linkHost) && isIp(endpoint) && !isLoopback(linkHost)) return false;

    const name = link.deviceName;
    if (!name || session.DeviceName !== name) return false;
    // A name alone is enough unless two TVs at different addresses share it.
    const sameName = (sessions || []).filter(s => s.DeviceName === name);
    return new Set(sameName.map(s => hostOf(s.RemoteEndPoint))).size <= 1;
  }

  // 'link' (bridge mirror link), 'jellyfin' (remote-control API), 'cast', or null.
  function routeFor(target, sessions, link) {
    if (!target) return null;
    if (target.kind === 'cast') return 'cast';
    return isLinkedSession(target.raw, sessions, link) ? 'link' : 'jellyfin';
  }

  // Jellyfin's view of an Aura session's queue: item ids and the current index.
  function queueFromSession(session) {
    const ids = (session?.NowPlayingQueue || []).map(q => q.Id).filter(Boolean);
    const current = session?.NowPlayingItem?.Id;
    return { ids, index: Math.max(0, current ? ids.indexOf(current) : 0) };
  }

  const api = { hostOf, isLinkedSession, routeFor, queueFromSession };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuraRouting = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
