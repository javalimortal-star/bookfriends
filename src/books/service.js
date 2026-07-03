const fs = require('fs');
const nodePath = require('path');
const { db, DATA_DIR } = require('../db');
const { parseEpub, MEDIA_BASE_PLACEHOLDER } = require('../epub/parse');

function slugify(title) {
  const base = String(title).toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'book';
  let slug = base;
  let n = 2;
  while (db.prepare('SELECT id FROM books WHERE slug = ?').get(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

function bookDir(bookId) {
  return nodePath.join(DATA_DIR, 'books', String(bookId));
}

function createBookFromEpub(epubPath, ownerId) {
  const parsed = parseEpub(epubPath);
  const slug = slugify(parsed.title);

  const insertBook = db.prepare(
    'INSERT INTO books (owner_id, title, author, slug, visibility, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertChapter = db.prepare(
    'INSERT INTO chapters (book_id, idx, title, content_html) VALUES (?, ?, ?, ?)'
  );

  const bookId = db.transaction(() => {
    const info = insertBook.run(ownerId, parsed.title, parsed.author, slug, 'private', Date.now());
    const id = info.lastInsertRowid;
    const mediaBase = `/media/book/${id}/img`;
    parsed.chapters.forEach((chapter, idx) => {
      const html = chapter.contentHtml.split(MEDIA_BASE_PLACEHOLDER).join(mediaBase);
      insertChapter.run(id, idx, chapter.title, html);
    });
    return id;
  })();

  const imagesDir = nodePath.join(bookDir(bookId), 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  // Keep the source EPUB so readers can download it (e.g. Send to Kindle).
  fs.copyFileSync(epubPath, nodePath.join(bookDir(bookId), 'book.epub'));
  for (const image of parsed.images) {
    const data = parsed.readZipEntry(image.zipPath);
    if (data) fs.writeFileSync(nodePath.join(imagesDir, nodePath.basename(image.name)), data);
  }
  if (parsed.cover) {
    const data = parsed.readZipEntry(parsed.cover.zipPath);
    if (data) {
      const coverFile = `cover${parsed.cover.ext}`;
      fs.writeFileSync(nodePath.join(bookDir(bookId), coverFile), data);
      db.prepare('UPDATE books SET cover_path = ? WHERE id = ?').run(coverFile, bookId);
    }
  }
  return db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
}

function deleteBook(bookId) {
  db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
  fs.rmSync(bookDir(bookId), { recursive: true, force: true });
}

function getShelf(user) {
  if (user && user.role === 'owner') {
    return db.prepare('SELECT * FROM books ORDER BY created_at DESC').all();
  }
  return db.prepare("SELECT * FROM books WHERE visibility = 'public' ORDER BY created_at DESC").all();
}

function getBookBySlug(slug) {
  return db.prepare('SELECT * FROM books WHERE slug = ?').get(slug);
}

function getBookById(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

function getChapter(bookId, idx) {
  return db.prepare('SELECT * FROM chapters WHERE book_id = ? AND idx = ?').get(bookId, idx);
}

function getChapterById(id) {
  return db.prepare('SELECT * FROM chapters WHERE id = ?').get(id);
}

function chapterCount(bookId) {
  return db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?').get(bookId).n;
}

function chapterList(bookId) {
  return db.prepare('SELECT idx, title FROM chapters WHERE book_id = ? ORDER BY idx').all(bookId);
}

module.exports = {
  createBookFromEpub, deleteBook, getShelf, getBookBySlug, getBookById,
  getChapter, getChapterById, chapterCount, chapterList, bookDir,
};
