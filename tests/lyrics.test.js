const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../server/web/lyrics.js');

test('enhanced LRC keeps word timings and singer markers', () => {
  const lines = L.parseLrc('[ar:Someone]\n[00:01.00]v1: <00:01.00>Hello <00:01.50>world\n[00:03.00]v2: Second\n[00:05.00]v1,v2: Both\n[00:06.00]m: Him');
  assert.deepEqual(lines.map(l => [l.start, l.text, l.voice?.kind]), [
    [1, 'Hello world', 'primary'], [3, 'Second', 'secondary'], [5, 'Both', 'group'], [6, 'Him', 'secondary'],
  ]);
  assert.deepEqual(lines[0].words, [{ start: 1, text: 'Hello' }, { start: 1.5, text: 'world' }]);
});

test('a line repeated under several stamps shifts its words with each', () => {
  const lines = L.parseLrc('[00:10.00][00:40.00]<00:10.00>La <00:10.50>la');
  assert.deepEqual(lines.map(l => l.words.map(w => w.start)), [[10, 10.5], [40, 40.5]]);
});

test('LRC without stamps is unsynced', () => {
  const lines = L.parseLrc('One\nTwo\n');
  assert.deepEqual(lines.map(l => [l.text, l.synced]), [['One', false], ['Two', false]]);
  assert.equal(L.activeIndex(lines, 100), -1);
});

const ttml = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
 <head><metadata>
  <ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/><ttm:agent type="group" xml:id="v3"/>
 </metadata></head>
 <body><div>
  <p begin="00:00:12.000" ttm:agent="v2"><span begin="00:00:12.000">Me &amp; you</span></p>
  <p begin="10.5s" ttm:agent="v1"><span begin="0s">Hi</span> <span begin="500ms">there</span><span ttm:role="x-bg"><span begin="1s">(ooh)</span></span></p>
  <p begin="14s" ttm:agent="v3">All<br/>together</p>
 </div></body>
</tt>`;

test('TTML: relative word times, background vocals dropped, lines sorted, agents as voices', () => {
  const lines = L.parseText(ttml);
  assert.deepEqual(lines.map(l => [l.start, l.text, l.voice?.kind]), [
    [10.5, 'Hi there', 'secondary'], [12, 'Me & you', 'primary'], [14, 'All together', 'group'],
  ]);
  assert.deepEqual(lines[0].words, [{ start: 10.5, text: 'Hi' }, { start: 11, text: 'there' }]);
});

test('Jellyfin lines with word cues skip the singer marker', () => {
  const [line] = L.fromJellyfin({ Lyrics: [{ Text: 'v2: Hello world', Start: 10000000, Cues: [
    { Position: 0, EndPosition: 9, Start: 10000000 }, { Position: 10, EndPosition: 15, Start: 15000000 }] }] });
  assert.equal(line.text, 'Hello world');
  assert.equal(line.voice.kind, 'secondary');
  assert.deepEqual(line.words, [{ start: 1, text: 'Hello' }, { start: 1.5, text: 'world' }]);
});

test('Jellyfin raw lyric text is parsed as LRC or TTML', () => {
  assert.equal(L.fromJellyfin({ LyricText: '[00:02.00]Line' })[0].start, 2);
  assert.equal(L.fromJellyfin({ Lyrics: [{ Text: ttml }] }).length, 3);
  assert.deepEqual(L.fromJellyfin({}), []);
});

test('karaoke spans rebuild the line text with or without spaces in the tokens', () => {
  const spaced = { start: 1, text: 'Hello world', words: [{ start: 1, text: 'Hello' }, { start: 2, text: 'world' }] };
  assert.deepEqual(L.karaokeSpans(spaced, 1.5), [{ text: 'Hello', sung: true }, { text: ' world', sung: false }]);
  const tight = { start: 1, text: '你好', words: [{ start: 1, text: '你' }, { start: 2, text: '好' }] };
  assert.deepEqual(L.karaokeSpans(tight, 3), [{ text: '你好', sung: true }]);
  const mismatch = { start: 1, text: 'Hello, world!', words: [{ start: 1, text: 'Hullo' }] };
  assert.deepEqual(L.karaokeSpans(mismatch, 0), [{ text: 'Hello, world!', sung: false }]);
});

test('TTML relative word times shift even when a later word passes the line start', () => {
  const [line] = L.parseTtml('<tt><body><p begin="1s"><span begin="0s">A</span> <span begin="2s">B</span></p></body></tt>');
  assert.deepEqual(line.words.map(w => w.start), [1, 3]);
});
