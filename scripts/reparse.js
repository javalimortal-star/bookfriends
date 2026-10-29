#!/usr/bin/env node
// Reads the books already on the site again with today's EPUB parser (footnote
// links, chapters cut where they start) and updates every chapter whose
// paragraphs read the same, or only gained paragraphs at the end: comments and
// bookmarks point at paragraph numbers, so they stay where they were. Any
// other chapter is left as it is. Safe to run while the site is up.
// Usage: node scripts/reparse.js [slug ...]   (no slug: every book)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { db } = require('../src/db');
const { parseEpub, MEDIA_BASE_PLACEHOLDER } = require('../src/epub/parse');
const { bookDir } = require('../src/books/service');
const search = require('../src/books/search');

const paragraphs = (html) => {
  const $ = cheerio.load(html, null, false);
  return $('[data-p]').toArray().map((el) => $(el).text().replace(/\s+/g, ' ').trim());
};

// -> { updated, kept } or { skipped: why }
function reparseBook(book) {
  const file = path.join(bookDir(book.id), 'book.epub');
  if (!fs.existsSync(file)) return { skipped: 'no EPUB stored' };
  const parsed = parseEpub(file);
  const stored = db.prepare('SELECT id, idx, content_html FROM chapters WHERE book_id = ? ORDER BY idx').all(book.id);
  if (parsed.chapters.length !== stored.length) return { skipped: `it now has ${parsed.chapters.length} chapters, not ${stored.length}` };

  // pictures the chapters now name that the book's folder doesn't have yet
  const imagesDir = path.join(bookDir(book.id), 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  for (const image of parsed.images) {
    const dest = path.join(imagesDir, path.basename(image.name));
    const data = fs.existsSync(dest) ? null : parsed.readZipEntry(image.zipPath);
    if (data) fs.writeFileSync(dest, data);
  }

  const update = db.prepare('UPDATE chapters SET content_html = ? WHERE id = ?');
  let updated = 0;
  let kept = 0;
  db.transaction(() => {
    stored.forEach((chapter, i) => {
      const html = parsed.chapters[i].contentHtml.split(MEDIA_BASE_PLACEHOLDER).join(`/media/book/${book.id}/img`);
      if (html === chapter.content_html) return;
      const before = paragraphs(chapter.content_html);
      const after = paragraphs(html);
      if (!before.every((text, k) => text === after[k])) {
        kept += 1;
        return;
      }
      update.run(html, chapter.id);
      search.indexAddedParagraphs(book.id, chapter.idx, html, before.length);
      updated += 1;
    });
  })();
  return { updated, kept };
}

if (require.main === module) {
  const slugs = process.argv.slice(2);
  const books = db.prepare('SELECT id, slug, title FROM books ORDER BY id').all()
    .filter((book) => !slugs.length || slugs.includes(book.slug));
  if (!books.length) console.log('No such book.');
  for (const book of books) {
    const result = reparseBook(book);
    console.log(result.skipped
      ? `${book.title}: left as it was (${result.skipped})`
      : `${book.title}: ${result.updated} chapters updated, ${result.kept} left as they were (their text changed)`);
  }
}

module.exports = { reparseBook };
