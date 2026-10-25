// The pure (no database) half of search inside a book: paragraph text
// extraction, safe FTS5 queries and snippet splitting. src/books/search.js
// has the index itself.

const MIN_QUERY = 2;
const MAX_QUERY = 100;
const MAX_TERMS = 12;
// rowids pack chapter and paragraph below 2^20 each (src/books/search.js)
const MAX_PARA = 2 ** 20;

// snippet() wraps matches in these; indexed text never contains control
// characters (stripped below), so in a snippet they can only be markers.
const HIT_START = '\u0001';
const HIT_END = '\u0002';
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Plain text of each data-p paragraph, as [{ para, text }]. No HTML parser:
// content_html is our own cheerio output, and a DOM per chapter churned
// ~170 MB on a 1852-chapter book; test/search.test.js checks it matches cheerio.
const ATTRS = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*'; // a tag's insides, quotes may hold ">"
const OPEN_PARA = new RegExp(`<(p|blockquote)\\b${ATTRS}?\\sdata-p="(\\d+)"${ATTRS}>`, 'gi');
const SAME_TAG = { p: new RegExp(`<(/?)p\\b${ATTRS}>`, 'gi'), blockquote: new RegExp(`<(/?)blockquote\\b${ATTRS}>`, 'gi') };
const BR = new RegExp(`<br\\b${ATTRS}>`, 'gi');
const ANY_TAG = new RegExp(`<${ATTRS}>`, 'g');
const ENTITY = /&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function decodeEntities(text) {
  return text.replace(ENTITY, (whole, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function paragraphTexts(html) {
  const out = [];
  OPEN_PARA.lastIndex = 0;
  let open;
  while ((open = OPEN_PARA.exec(html))) {
    // the matching close tag: count nested elements of the same name
    const tag = SAME_TAG[open[1].toLowerCase()];
    const start = OPEN_PARA.lastIndex;
    tag.lastIndex = start;
    let depth = 1;
    let end = html.length;
    let t;
    while ((t = tag.exec(html))) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    const inner = html.slice(start, end).replace(BR, ' ').replace(ANY_TAG, ''); // "line<br>line": two words
    const text = decodeEntities(inner).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    const para = Number(open[2]);
    if (text && para < MAX_PARA) out.push({ para, text });
  }
  return out;
}

// 'ok', 'short' or 'long' for the raw query string (counted in characters,
// not UTF-16 units, so "ão" is 2).
function checkQuery(raw) {
  const length = [...String(raw || '').trim()].length;
  if (length < MIN_QUERY) return 'short';
  if (length > MAX_QUERY) return 'long';
  return 'ok';
}

// The words as an FTS5 query that can't be a syntax error (each word quoted);
// the last one is a prefix if it has MIN_PREFIX+ letters ("a*" is costly). null if nothing is left.
const MIN_PREFIX = 3;
function buildMatchQuery(raw) {
  const items = [];
  const re = /"([^"]*)("?)|([^\s"]+)/g;
  let m;
  while ((m = re.exec(String(raw || ''))) && items.length < MAX_TERMS) {
    const quoted = m[1] !== undefined;
    const text = (quoted ? m[1] : m[3]).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    items.push({ text, closedPhrase: quoted && m[2] === '"' });
  }
  if (items.length === 0) return null;
  const last = items[items.length - 1];
  const lastWord = last.text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).pop();
  const prefix = !last.closedPhrase && [...lastWord].length >= MIN_PREFIX;
  return items.map((item, i) => {
    const str = `"${item.text.replace(/"/g, '""')}"`;
    return i === items.length - 1 && prefix ? `${str} *` : str;
  }).join(' ');
}

// snippet() output -> [{ text, hit }], so the template escapes every piece
// itself: the book's text is never trusted as HTML.
function snippetParts(snippet) {
  const parts = [];
  for (const piece of String(snippet || '').split(HIT_END)) {
    const start = piece.indexOf(HIT_START);
    const before = start === -1 ? piece : piece.slice(0, start);
    if (before) parts.push({ text: before, hit: false });
    if (start !== -1) {
      const hit = piece.slice(start + 1).split(HIT_START).join('');
      if (hit) parts.push({ text: hit, hit: true });
    }
  }
  return parts;
}

module.exports = { MAX_PARA, HIT_START, HIT_END, paragraphTexts, checkQuery, buildMatchQuery, snippetParts };
