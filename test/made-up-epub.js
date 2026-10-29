// A made-up EPUB with what broke real ones: Project Gutenberg's one <div> for
// many chapters (every chapter used to get all of it), a self-closed <a/> that
// swallows the rest of the file when read as HTML, a file with no table of
// contents entry, the EPUB's maker listed before its author, footnotes (one
// at the end of its chapter, one in a Notes chapter at the back) and an
// EPUB 3 contents page. Chapters: Part One, Chapter 1, 2, 3, Notes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

function writeMadeUpEpub() {
  const zip = new AdmZip();
  const add = (name, text) => zip.addFile(name, Buffer.from(text, 'utf8'));
  const page = (body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
  const item = (id, href, extra = '') => `<item id="${id}" href="${href}" media-type="application/xhtml+xml"${extra}/>`;
  add('mimetype', 'application/epub+zip');
  add('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  add('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
    <metadata><dc:title>Split Test</dc:title><dc:creator opf:role="bkp">ePub created by Someone</dc:creator><dc:creator opf:role="aut">Real Author</dc:creator></metadata>
    <manifest>${item('cover', 'cover.xhtml')}${item('book', 'book.xhtml')}${item('tail', 'tail.xhtml')}${item('nav', 'nav.xhtml', ' properties="nav"')}${item('notes', 'notes.xhtml')}
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>
    <spine toc="ncx"><itemref idref="cover"/><itemref idref="book"/><itemref idref="tail"/><itemref idref="nav"/><itemref idref="notes"/></spine></package>`);
  const nav = (label, src) => `<navPoint><navLabel><text>${label}</text></navLabel><content src="${src}"/></navPoint>`;
  add('OEBPS/toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
    ${nav('Part One', 'book.xhtml#part')}${nav('Chapter 1', 'book.xhtml#c1')}${nav('Chapter 2', 'book.xhtml#c2')}${nav('Chapter 3', 'book.xhtml#c3')}${nav('Notes', 'notes.xhtml')}</navMap></ncx>`);
  add('OEBPS/cover.xhtml', page('<p>Cover page</p>'));
  add('OEBPS/book.xhtml', page(`<p>Front matter.</p><div class="chapter" id="part"><h2>Part One</h2>
    <h3 id="c1">Chapter 1</h3><p>One a.<sup><a id="r1" href="notes.xhtml#n1">1</a></sup></p><p>One b.</p><a id="x"/>
    <h3 id="c2">Chapter 2</h3><p>Two a.</p><h3 id="c3">Chapter 3</h3><p>Three a.<sup><a id="r2" href="tail.xhtml#n2">2</a></sup></p></div>`));
  add('OEBPS/tail.xhtml', page('<p>Three goes on in the next file.</p><p id="n2"><a href="book.xhtml#r2">2.</a> A note at the end of its chapter.</p>'));
  add('OEBPS/nav.xhtml', page('<nav><ol><li><a href="book.xhtml#c1">Chapter 1</a></li><li><a href="notes.xhtml">Notes</a></li></ol></nav>'));
  add('OEBPS/notes.xhtml', page('<h2>Notes</h2><p id="n1"><a href="book.xhtml#r1">1.</a> A note at the back of the book.</p>'));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-epub-')), 'split-test.epub');
  zip.writeZip(file);
  return file;
}

module.exports = { writeMadeUpEpub };
