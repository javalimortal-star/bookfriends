const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseEpub, MEDIA_BASE_PLACEHOLDER } = require('../src/epub/parse');

const FIXTURE = path.join(__dirname, '..', 'pg345-images-3.epub');
const parsed = parseEpub(FIXTURE);

test('metadata comes from the OPF', () => {
  assert.strictEqual(parsed.title, 'Dracula');
  assert.strictEqual(parsed.author, 'Bram Stoker');
});

test('parses exactly 32 chapters (one per NCX navPoint)', () => {
  assert.strictEqual(parsed.chapters.length, 32);
});

test('chapter titles equal the NCX navLabels', () => {
  assert.strictEqual(parsed.chapters[0].title, 'D R A C U L A');
  assert.match(parsed.chapters[3].title, /^CHAPTER I\b/);
  assert.match(parsed.chapters[4].title, /^CHAPTER II\b/);
  assert.match(parsed.chapters[29].title, /^CHAPTER XXVII\b/);
  assert.match(parsed.chapters[31].title, /GUTENBERG/i);
});

test('shared spine file is split by fragment anchors (title page vs CHAPTER I)', () => {
  assert.notStrictEqual(parsed.chapters[2].contentHtml, parsed.chapters[3].contentHtml);
  assert.ok(parsed.chapters[3].contentHtml.length > 10000, 'CHAPTER I should hold the real chapter text');
});

test('every real chapter gets data-p paragraph anchors', () => {
  assert.ok(parsed.chapters[3].paraCount > 20, 'CHAPTER I has dozens of paragraphs');
  assert.match(parsed.chapters[3].contentHtml, /data-p="0"/);
  assert.match(parsed.chapters[3].contentHtml, /data-p="10"/);
});

test('colophon.png img src is rewritten to the media route placeholder', () => {
  const colophonChapter = parsed.chapters.find((c) => c.contentHtml.includes('colophon'));
  assert.ok(colophonChapter, 'a chapter contains the colophon image');
  assert.match(colophonChapter.contentHtml, new RegExp(`<img[^>]+src="${MEDIA_BASE_PLACEHOLDER}/[^"]*colophon\\.png"`));
});

test('images list contains the colophon with a resolvable zip path', () => {
  assert.strictEqual(parsed.images.length, 1);
  assert.match(parsed.images[0].name, /colophon\.png$/);
  assert.ok(parsed.readZipEntry(parsed.images[0].zipPath), 'zip entry resolves to data');
});

test('cover image is detected from the OPF cover-image property', () => {
  assert.ok(parsed.cover, 'cover found');
  assert.strictEqual(parsed.cover.ext, '.jpg');
  const data = parsed.readZipEntry(parsed.cover.zipPath);
  assert.ok(data && data.length > 1000, 'cover data extractable');
});

test('chapter HTML is sanitized (no scripts or event handlers)', () => {
  for (const chapter of parsed.chapters) {
    assert.doesNotMatch(chapter.contentHtml, /<script/i);
    assert.doesNotMatch(chapter.contentHtml, /\son[a-z]+=/i);
  }
});

const { writeMadeUpEpub } = require('./made-up-epub');

const madeUpEpub = () => parseEpub(writeMadeUpEpub());

test('chapters sharing one wrapper are cut at their own anchors, nothing lost or repeated', () => {
  const book = madeUpEpub();
  const text = book.chapters.map((c) => c.contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  assert.deepStrictEqual(book.chapters.map((c) => c.title), ['Part One', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Notes']);
  assert.strictEqual(text[0], 'Front matter. Part One');
  assert.strictEqual(text[1], 'Chapter 1 One a. 1 One b.');
  assert.strictEqual(text[2], 'Chapter 2 Two a.');
  // the EPUB 3 contents page between Chapter 3's files and the Notes is left out
  assert.strictEqual(text[3], 'Chapter 3 Three a. 2 Three goes on in the next file. 2. A note at the end of its chapter.');
  assert.strictEqual(text[4], 'Notes 1. A note at the back of the book.');
  assert.strictEqual(book.chapters.reduce((n, c) => n + c.paraCount, 0), 8);
});

test('footnote numbers link to their notes and back, in the same chapter or another', () => {
  const [, one, , three, notes] = madeUpEpub().chapters.map((c) => c.contentHtml);
  // book.xhtml is file 1 of the spine, tail.xhtml 2, notes.xhtml 4; Notes is chapter 4
  assert.match(one, /<sup><a id="bf-1-r1" href="4\?peek=1#bf-4-n1">1<\/a><\/sup>/);
  assert.match(notes, /<p id="bf-4-n1"[^>]*><a href="1\?peek=1#bf-1-r1">1\.<\/a> A note at the back/);
  assert.match(three, /<sup><a id="bf-1-r2" href="#bf-2-n2">2<\/a><\/sup>/);
  assert.match(three, /<p id="bf-2-n2"[^>]*><a href="#bf-1-r2">2\.<\/a>/);
  for (const html of [one, three, notes]) assert.doesNotMatch(html, /\sid="(?!bf-)/, 'only the parser\'s link-target ids');
});

test('the author is the creator marked as author, not who made the EPUB', () => {
  assert.strictEqual(madeUpEpub().author, 'Real Author');
});
