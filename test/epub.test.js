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

// A made-up book with what broke real ones: Project Gutenberg's one <div> for
// many chapters (every chapter used to get all of it), a self-closed <a/> that
// swallows the rest of the file when read as HTML, a file with no table of
// contents entry, and the EPUB's maker listed before its author.
function madeUpEpub() {
  const AdmZip = require('adm-zip');
  const fs = require('fs');
  const os = require('os');
  const zip = new AdmZip();
  const add = (name, text) => zip.addFile(name, Buffer.from(text, 'utf8'));
  const page = (body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
  add('mimetype', 'application/epub+zip');
  add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  add('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
    <metadata><dc:title>Split Test</dc:title><dc:creator opf:role="bkp">ePub created by Someone</dc:creator><dc:creator opf:role="aut">Real Author</dc:creator></metadata>
    <manifest><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="book" href="book.xhtml" media-type="application/xhtml+xml"/>
      <item id="tail" href="tail.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
    <spine toc="ncx"><itemref idref="cover"/><itemref idref="book"/><itemref idref="tail"/></spine></package>`);
  const nav = (label, src) => `<navPoint><navLabel><text>${label}</text></navLabel><content src="${src}"/></navPoint>`;
  add('OEBPS/toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
    ${nav('Part One', 'book.xhtml#part')}${nav('Chapter 1', 'book.xhtml#c1')}${nav('Chapter 2', 'book.xhtml#c2')}${nav('Chapter 3', 'book.xhtml#c3')}</navMap></ncx>`);
  add('OEBPS/cover.xhtml', page('<p>Cover page</p>'));
  add('OEBPS/book.xhtml', page(`<p>Front matter.</p><div class="chapter" id="part"><h2>Part One</h2>
    <h3 id="c1">Chapter 1</h3><p>One a.</p><p>One b.</p><a id="x"/>
    <h3 id="c2">Chapter 2</h3><p>Two a.</p><h3 id="c3">Chapter 3</h3><p>Three a.</p></div>`));
  add('OEBPS/tail.xhtml', page('<p>Three goes on in the next file.</p>'));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-epub-')), 'split.epub');
  zip.writeZip(file);
  return parseEpub(file);
}

test('chapters sharing one wrapper are cut at their own anchors, nothing lost or repeated', () => {
  const book = madeUpEpub();
  const text = book.chapters.map((c) => c.contentHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  assert.deepStrictEqual(book.chapters.map((c) => c.title), ['Part One', 'Chapter 1', 'Chapter 2', 'Chapter 3']);
  assert.strictEqual(text[0], 'Front matter. Part One');
  assert.strictEqual(text[1], 'Chapter 1 One a. One b.');
  assert.strictEqual(text[2], 'Chapter 2 Two a.');
  assert.strictEqual(text[3], 'Chapter 3 Three a. Three goes on in the next file.');
  assert.strictEqual(book.chapters.reduce((n, c) => n + c.paraCount, 0), 6);
});

test('the author is the creator marked as author, not who made the EPUB', () => {
  assert.strictEqual(madeUpEpub().author, 'Real Author');
});
