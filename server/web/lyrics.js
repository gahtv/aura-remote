// Lyrics as Aura reads them: line-synced and word-timed LRC, Jellyfin word cues
// and TTML, with singer markers kept so duets render per voice. Times are in
// seconds on the playback clock. Pure functions, shared by the PWA and tests.
(function (root) {
  'use strict';

  const STAMP = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
  const WORD_TAG = /<(\d+):(\d+(?:\.\d+)?)>/g;
  const TTML = /<(?:\w+:)?tt(?:\s|>)/;
  const VOICE_TOKEN = '(?:v[1-9][0-9]*|[fmd]|bg)';
  const VOICE_PREFIX = new RegExp(`^(${VOICE_TOKEN}(?:\\s*[,+&/]\\s*${VOICE_TOKEN})*)[:：]\\s*`, 'i');

  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const stampSec = (min, sec) => Number(min) * 60 + Number(sec.replace(':', '.'));
  const hasWordTags = s => new RegExp(WORD_TAG.source).test(s);
  const stripWordTags = s => normalize(s.replace(WORD_TAG, ''));

  // "v1: text", "m: text", "v1,v2: text" → the singer and the text without the marker.
  function splitVoice(text) {
    const match = VOICE_PREFIX.exec(text);
    if (!match) return [text, null];
    const ids = match[1].toLowerCase().split(/\s*[,+&/]\s*/);
    const id = ids.length === 1 ? ids[0] : null;
    let kind = 'primary';
    if (id === null || ['d', 'bg', 'v1000'].includes(id)) kind = 'group';
    else if (id === 'm' || (id.startsWith('v') && Number(id.slice(-1)) % 2 === 0)) kind = 'secondary';
    return [text.slice(match[0].length), { id: ids.join(','), kind }];
  }

  // Enhanced LRC: "<00:12.30>word <00:12.80>word".
  function inlineWords(text) {
    const tags = [...text.matchAll(WORD_TAG)];
    return tags.map((tag, i) => {
      const end = i + 1 < tags.length ? tags[i + 1].index : text.length;
      const word = normalize(text.slice(tag.index + tag[0].length, end));
      return word ? { start: stampSec(tag[1], tag[2]), text: word } : null;
    }).filter(Boolean);
  }

  function parseLrc(raw) {
    const synced = [];
    const plain = [];
    for (const rawLine of String(raw).split(/\r?\n/)) {
      const stamps = [...rawLine.matchAll(STAMP)];
      const [content, voice] = splitVoice(rawLine.replace(STAMP, '').trim());
      const words = inlineWords(content);
      const text = hasWordTags(content) ? stripWordTags(content) : content;
      if (!stamps.length) {
        if (text) plain.push({ start: 0, text, synced: false, words: [], voice });
        continue;
      }
      const first = stampSec(stamps[0][1], stamps[0][2]);
      for (const m of stamps) {
        const start = stampSec(m[1], m[2]);
        synced.push({ start, text, synced: true, voice,
          words: words.map(w => ({ start: w.start + start - first, text: w.text })) });
      }
    }
    return synced.length ? synced.sort((a, b) => a.start - b.start) : plain;
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
  }

  // TTML clock values: "12.3s", "450ms", "01:02.5", "00:01:02.500".
  function ttmlTime(value) {
    const text = value?.trim();
    if (!text) return null;
    if (text.endsWith('ms')) { const n = Number(text.slice(0, -2)); return Number.isFinite(n) ? n / 1000 : null; }
    if (text.endsWith('s')) { const n = Number(text.slice(0, -1)); return Number.isFinite(n) ? n : null; }
    const parts = text.split(':');
    if (parts.length > 3) return null;
    let seconds = 0;
    for (const part of parts) {
      const n = Number(part);
      if (part === '' || !Number.isFinite(n)) return null;
      seconds = seconds * 60 + n;
    }
    return seconds;
  }

  const localName = name => name.slice(name.indexOf(':') + 1);
  function attributes(source) {
    const out = {};
    for (const m of source.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      out[localName(m[1])] = decodeEntities(m[2] ?? m[3]);
    }
    return out;
  }

  // Apple-style TTML: <p begin> lines, <span begin> words, ttm:agent singers;
  // background vocals and translations are left out of the line.
  function parseTtml(raw) {
    const lines = [];
    const agentTypes = {};
    const agentKinds = {};
    const voiceOf = value => {
      const ids = (value || '').trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return null;
      const kinds = ids.map(id => {
        if (!agentKinds[id]) {
          const singers = Object.values(agentKinds).filter(k => k !== 'group').length;
          agentKinds[id] = agentTypes[id] === 'group' ? 'group' : singers % 2 === 0 ? 'primary' : 'secondary';
        }
        return agentKinds[id];
      });
      return { id: ids.join(' '), kind: ids.length > 1 ? 'group' : kinds[0] };
    };

    let depth = 0;
    let lineDepth = -1, skipDepth = -1, wordDepth = -1;
    let lineStart = null, wordStart = null, lineAgent = null;
    let text = '', wordText = '', words = [];

    const close = () => {
      if (depth === wordDepth) {
        const word = normalize(wordText);
        if (word) words.push({ start: wordStart, text: word });
        wordDepth = -1;
      }
      if (depth === skipDepth) skipDepth = -1;
      if (depth === lineDepth) {
        const line = normalize(text);
        const start = lineStart ?? words[0]?.start ?? null;
        // Word times relative to their paragraph.
        if (lineStart !== null && words.length && words.every(w => w.start < lineStart)) {
          words = words.map(w => ({ start: w.start + lineStart, text: w.text }));
        }
        if (line) lines.push({ start: start ?? 0, text: line, synced: start !== null, words, voice: voiceOf(lineAgent) });
        lineDepth = -1;
      }
      depth--;
    };

    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>]*)>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    for (const m of String(raw).matchAll(token)) {
      const [, cdata, closing, tag, attrSource, selfClosing, chars] = m;
      if (cdata !== undefined || chars !== undefined) {
        if (lineDepth >= 0 && skipDepth < 0) {
          const t = cdata ?? decodeEntities(chars);
          text += t;
          if (wordDepth >= 0) wordText += t;
        }
        continue;
      }
      if (!tag) continue;
      if (closing) { close(); continue; }

      depth++;
      const name = localName(tag);
      const attrs = attributes(attrSource || '');
      if (name === 'agent' && attrs.id) agentTypes[attrs.id] = attrs.type || '';
      if (name === 'p') {
        lineDepth = depth;
        lineStart = ttmlTime(attrs.begin);
        lineAgent = attrs.agent?.trim() || null;
        text = '';
        words = [];
      }
      if (lineDepth >= 0 && skipDepth < 0) {
        if (attrs.role === 'x-bg' || attrs.role === 'x-translation') skipDepth = depth;
        else if (name === 'span') {
          if (!lineAgent) lineAgent = attrs.agent?.trim() || null;
          const begin = ttmlTime(attrs.begin);
          if (wordDepth < 0 && begin !== null) { wordDepth = depth; wordStart = begin; wordText = ''; }
        } else if (name === 'br') text += ' ';
      }
      if (selfClosing) close();
    }
    return lines.sort((a, b) => a.start - b.start);
  }

  function parseText(raw) {
    return TTML.test(raw) ? parseTtml(raw) : parseLrc(raw);
  }

  // GET /Audio/{id}/Lyrics: structured lines with ticks and optional word cues,
  // or a raw LRC / TTML blob.
  function fromJellyfin(data) {
    const dto = data?.Lyrics;
    if (Array.isArray(dto) && dto.length) {
      const joined = dto.map(l => l.Text || '').join('\n');
      if (TTML.test(joined)) return parseTtml(joined);
      const synced = (dto.length > 1 && dto.some(l => (l.Start || 0) > 0))
        || dto.some(l => (l.Cues || []).length || hasWordTags(l.Text || ''));
      return dto.map(l => {
        const raw = l.Text || '';
        const original = raw.trim();
        const [content, voice] = splitVoice(original);
        const prefixLength = raw.indexOf(original) + original.length - content.length;
        let words = (l.Cues || []).map(cue => {
          const position = cue.Position ?? 0;
          const start = Math.max(position, prefixLength);
          const end = cue.EndPosition ?? 0;
          if (position < 0 || end <= start || end > raw.length) return null;
          const word = normalize(raw.slice(start, end));
          return word ? { start: (cue.Start || 0) / 1e7, text: word } : null;
        }).filter(Boolean);
        if (!words.length) words = inlineWords(content);
        return {
          start: synced ? (l.Start || 0) / 1e7 : 0,
          text: hasWordTags(content) ? stripWordTags(content) : content,
          synced, words, voice,
        };
      });
    }
    return data?.LyricText?.trim() ? parseText(data.LyricText) : [];
  }

  // The line playing at `position`, or -1 (also for unsynced lyrics).
  function activeIndex(lines, position) {
    let active = -1;
    lines.forEach((l, i) => { if (l.synced && l.start <= position) active = i; });
    return active;
  }

  const sameText = (a, b) => a.replace(/\s/g, '').toLowerCase() === b.replace(/\s/g, '').toLowerCase();

  // Runs of `line` that share a sung/unsung state at `position`, always
  // spelling the line's own text.
  function karaokeSpans(line, position) {
    const words = (line.words || []).filter(w => w.text.trim());
    if (!words.length) return [{ text: line.text, sung: position >= line.start }];
    const tight = words.map(w => w.text).join('');
    const spaced = words.map(w => w.text).join(' ');
    let separator;
    if (spaced.trim() === line.text.trim()) separator = ' ';
    else if (tight.trim() === line.text.trim()) separator = '';
    else if (sameText(spaced, line.text)) separator = ' ';
    else if (sameText(tight, line.text)) separator = '';
    else return [{ text: line.text, sung: position >= words[0].start }];

    const spans = [];
    words.forEach((w, i) => {
      const sung = position >= w.start;
      const piece = i === 0 ? w.text : separator + w.text;
      const last = spans[spans.length - 1];
      if (last && last.sung === sung) last.text += piece;
      else spans.push({ text: piece, sung });
    });
    return spans;
  }

  const api = { splitVoice, parseLrc, parseTtml, parseText, fromJellyfin, activeIndex, karaokeSpans, decodeEntities };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AuraLyrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
