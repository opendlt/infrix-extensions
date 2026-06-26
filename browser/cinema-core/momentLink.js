/**
 * Infrix Cinema — shareable moment links (Wave L / L1).
 *
 * "Share" should produce a LINK, not a file. A moment encodes only VIEW STATE —
 * mode, replay position, camera, view, lens, search — into a URL fragment, so a
 * recipient opening it lands on the exact framed/scrubbed/lensed moment with a
 * live Trust Ladder. It carries NO scene data: the recipient still loads the
 * scene through their own disclosure-scoped source, so disclosure stays
 * fail-closed (a link can't leak data they aren't entitled to).
 *
 * encode/decode are pure + unit-tested (round-trip + tolerant of garbage).
 *
 * Classic script: attaches to window.InfrixCinema, exports for node.
 */
(function (root) {
  'use strict';
  const ns = (root.InfrixCinema = root.InfrixCinema || {});

  function b64urlEncode(str) {
    let b;
    if (typeof btoa !== 'undefined') b = btoa(unescape(encodeURIComponent(str)));
    else b = Buffer.from(str, 'utf8').toString('base64');
    return b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof atob !== 'undefined') return decodeURIComponent(escape(atob(s)));
    return Buffer.from(s, 'base64').toString('utf8');
  }

  function num(v, d) { const n = Number(v); return isFinite(n) ? n : (d || 0); }
  function clamp(v, lo, hi, d) { const n = num(v, d); return Math.max(lo, Math.min(hi, n)); }

  /** encodeMoment → a compact URL-safe string of view state only. */
  function encodeMoment(m) {
    m = m || {};
    const cam = m.camera || {};
    const compact = {
      m: m.mode || '', p: Math.round(num(m.position, 0)),
      cx: Math.round(num(cam.x, 0)), cy: Math.round(num(cam.y, 0)), cz: Math.round(num(cam.zoom, 1) * 1000) / 1000,
      v: m.view || '', l: m.lens || '', q: m.query || '',
    };
    return b64urlEncode(JSON.stringify(compact));
  }

  /** decodeMoment → the moment object, tolerant of missing/garbage input. */
  function decodeMoment(str) {
    if (!str) return null;
    try {
      const c = JSON.parse(b64urlDecode(str));
      if (!c || typeof c !== 'object') return null;
      return {
        mode: c.m || '', position: Math.round(num(c.p, 0)),
        camera: { x: num(c.cx, 0), y: num(c.cy, 0), zoom: clamp(c.cz, 0.05, 20, 1) },
        view: c.v || '', lens: c.l || '', query: c.q || '',
      };
    } catch (e) { return null; }
  }

  function momentToUrl(baseUrl, m) { return String(baseUrl || '') + '#cinema=' + encodeMoment(m); }

  function momentFromLocation(hash) {
    const h = String(hash || '');
    const i = h.indexOf('cinema=');
    if (i < 0) return null;
    let s = h.slice(i + 7);
    const amp = s.indexOf('&'); if (amp >= 0) s = s.slice(0, amp);
    return decodeMoment(s);
  }

  // embedSnippet — a drop-in iframe for the same moment in embed mode.
  function embedSnippet(baseUrl, m, opts) {
    opts = opts || {};
    const url = momentToUrl(baseUrl, Object.assign({}, m, { mode: 'cinema.embed' }));
    const w = opts.width || 800, h = opts.height || 500;
    return '<iframe src="' + url + '" width="' + w + '" height="' + h + '" style="border:0" title="Infrix Cinema" loading="lazy"></iframe>';
  }

  const api = { encodeMoment, decodeMoment, momentToUrl, momentFromLocation, embedSnippet };
  Object.assign(ns, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
