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
