const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const { parseEpub } = require('../src/epub/parse');
const { buildMatchQuery, checkQuery, snippetParts, paragraphTexts, HIT_START, HIT_END } = require('../src/books/search-text');

// An in-memory table set up like para_search in src/db/schema.sql.
function memoryIndex(texts) {
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
  const insert = db.prepare('INSERT INTO t (text) VALUES (?)');
  for (const text of texts) insert.run(text);
  const find = db.prepare('SELECT text FROM t WHERE t MATCH ? ORDER BY rowid');
  return (raw) => {
    const match = buildMatchQuery(raw);
    return match === null ? [] : find.all(match).map((row) => row.text);
  };
}

const search = memoryIndex([
  'Os Irmãos Karamázov, de Fiódor Dostoiévski.',
  'João disse: "não!" (e saiu) — fim.',
  'The Count of Monte Cristo arrived at the château.',
  'Jonathan Harker kept a journal in Transylvania.',
  'An * asterisk, a ^caret^, a -dash- and key:value.',
]);

test('accents and case do not matter (remove_diacritics)', () => {
  assert.deepStrictEqual(search('joao'), ['João disse: "não!" (e saiu) — fim.']);
  assert.deepStrictEqual(search('KARAMAZOV'), ['Os Irmãos Karamázov, de Fiódor Dostoiévski.']);
  assert.deepStrictEqual(search('irmaos'), ['Os Irmãos Karamázov, de Fiódor Dostoiévski.']);
  assert.deepStrictEqual(search('chateau'), ['The Count of Monte Cristo arrived at the château.']);
});

test('the last word is a prefix; earlier words are whole words', () => {
  assert.deepStrictEqual(search('transylv'), ['Jonathan Harker kept a journal in Transylvania.']);
  assert.deepStrictEqual(search('monte cris'), ['The Count of Monte Cristo arrived at the château.']);
  assert.deepStrictEqual(search('mont cristo'), []);
  // too short to expand: "a*" would match every a-word in every book
  assert.strictEqual(buildMatchQuery('of a'), '"of" "a"');
  assert.strictEqual(buildMatchQuery('drac'), '"drac" *');
});

test('quoted phrases match in order', () => {
  assert.deepStrictEqual(search('"count of monte"'), ['The Count of Monte Cristo arrived at the château.']);
  assert.deepStrictEqual(search('"monte of count"'), []);
  assert.strictEqual(buildMatchQuery('"the count"'), '"the count"');
  assert.strictEqual(buildMatchQuery('"the cou'), '"the cou" *');
});

test('FTS5 syntax characters never cause an error', () => {
  const nasty = ['"', '""', '"""', '*', '**', '-', '(', ')', '()', ':', '^', 'NEAR(a b)', 'a OR b', 'NOT x',
    'key:value', '-dash', 'caret^', '"unclosed', 'a"b"c', '\u0000x', 'x\u0001y', '\\', "'", '%', '_', '{}', '[]',
    'col:joao', '* - ( ) : ^', 'AND', 'OR', 'NOT', '+', '😀 emoji', 'ab'.repeat(50)];
  for (const raw of nasty) assert.doesNotThrow(() => search(raw), `query ${JSON.stringify(raw)}`);
  assert.strictEqual(buildMatchQuery('* - ( ) : ^'), null);
  assert.strictEqual(buildMatchQuery('""'), null);
  assert.deepStrictEqual(search('key:value'), ['An * asterisk, a ^caret^, a -dash- and key:value.']);
  // operators are ordinary words once quoted
  assert.strictEqual(buildMatchQuery('a OR b'), '"a" "OR" "b"');
});

test('query length is checked in characters', () => {
  assert.strictEqual(checkQuery(''), 'short');
  assert.strictEqual(checkQuery(' a '), 'short');
  assert.strictEqual(checkQuery('ão'), 'ok');
  assert.strictEqual(checkQuery('x'.repeat(100)), 'ok');
  assert.strictEqual(checkQuery('x'.repeat(101)), 'long');
});

test('snippet markers become parts the template escapes', () => {
  const snippet = `…the ${HIT_START}Count${HIT_END} of <b>Monte</b> ${HIT_START}Cristo${HIT_END}`;
  assert.deepStrictEqual(snippetParts(snippet), [
    { text: '…the ', hit: false },
    { text: 'Count', hit: true },
    { text: ' of <b>Monte</b> ', hit: false },
    { text: 'Cristo', hit: true },
  ]);
  assert.deepStrictEqual(snippetParts('plain'), [{ text: 'plain', hit: false }]);
});

test('paragraph text matches cheerio for every paragraph of the fixture EPUB', () => {
  const parsed = parseEpub(path.join(__dirname, '..', 'pg345-images-3.epub'));
  let paragraphs = 0;
  for (const chapter of parsed.chapters) {
    const $ = cheerio.load(chapter.contentHtml, null, false);
    const expected = [];
    $('[data-p]').each((_, el) => {
      $(el).find('br').replaceWith(' ');
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text) expected.push({ para: Number($(el).attr('data-p')), text });
    });
    assert.deepStrictEqual(paragraphTexts(chapter.contentHtml), expected);
    paragraphs += expected.length;
  }
  assert.ok(paragraphs > 1500, `only ${paragraphs} paragraphs`);
});

test('paragraph text: entities, <br>, nested tags, quoted ">" in attributes', () => {
  const html = '<p data-p="0">Tom &amp; Jerry&nbsp;said &lt;hi&gt; &#233;t&#xe9;</p>'
    + '<p class="x" data-p="1">line<br>two <i>it<b>al</b>ic</i> <img alt="a > b" src="x.png">end</p>'
    + '<blockquote data-p="2">quoted</blockquote><p data-p="3"> </p><p>no index</p>';
  assert.deepStrictEqual(paragraphTexts(html), [
    { para: 0, text: 'Tom & Jerry said <hi> été' },
    { para: 1, text: 'line two italic end' },
    { para: 2, text: 'quoted' },
  ]);
});
