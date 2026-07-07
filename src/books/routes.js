const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const express = require('express');
const multer = require('multer');
const { requireAuth, requireOwner, canViewBook } = require('../auth/middleware');
const books = require('./service');
const bookmarks = require('./bookmarks');
const commentsService = require('../comments/service');

const router = express.Router();

const MAX_EPUB_MB = Number(process.env.MAX_EPUB_MB) || 200;
const upload = multer({
  dest: nodePath.join(os.tmpdir(), 'bookfriends-uploads'),
  limits: { fileSize: MAX_EPUB_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.toLowerCase().endsWith('.epub'));
  },
});

router.get('/', (req, res) => {
  const shelf = books.getShelf(req.user);
  if (req.user) {
    for (const book of shelf) {
      const mark = bookmarks.getBookmark(req.user.id, book.id);
      if (mark) {
        book.bookmarkIdx = mark.chapter_idx;
        book.chapterTotal = books.chapterCount(book.id);
      }
    }
  }
  res.render('shelf', { title: 'BookFriends', books: shelf });
});

router.get('/upload', requireOwner, (req, res) => {
  res.render('upload', { title: 'Upload a book', error: null });
});

router.post('/upload', requireOwner, (req, res) => {
  // Run multer manually so its errors (e.g. file too large) render a helpful
  // message on the upload page instead of falling through to the 500 handler.
  upload.single('epub')(req, res, (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `That file is too large — the limit is ${MAX_EPUB_MB} MB (MAX_EPUB_MB in .env changes it).`
        : `Upload failed: ${uploadErr.message}`;
      return res.status(400).render('upload', { title: 'Upload a book', error: message });
    }
    if (!req.file) {
      return res.status(400).render('upload', { title: 'Upload a book', error: 'Choose a .epub file.' });
    }
    try {
      const book = books.createBookFromEpub(req.file.path, req.user.id);
      res.redirect(`/book/${book.slug}/0`);
    } catch (err) {
      res.status(400).render('upload', { title: 'Upload a book', error: `Could not parse that EPUB: ${err.message}` });
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  });
});

router.post('/book/:slug/visibility', requireOwner, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!book) return res.status(404).render('error', { title: 'Not found', message: 'No such book.' });
  const next = book.visibility === 'public' ? 'private' : 'public';
  require('../db').db.prepare('UPDATE books SET visibility = ? WHERE id = ?').run(next, book.id);
  res.redirect('/');
});

router.post('/book/:slug/delete', requireOwner, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!book) return res.status(404).render('error', { title: 'Not found', message: 'No such book.' });
  books.deleteBook(book.id);
  res.redirect('/');
});

router.get('/book/:slug/download', (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    return res.status(404).render('error', { title: 'Not found', message: 'No such book.' });
  }
  const file = nodePath.join(books.bookDir(book.id), 'book.epub');
  if (!fs.existsSync(file)) {
    return res.status(404).render('error', { title: 'Not found', message: 'No EPUB stored for this book.' });
  }
  res.download(file, `${book.slug}.epub`);
});

router.get('/book/:slug/:idx', (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    return res.status(404).render('error', { title: 'Not found', message: 'No such book.' });
  }
  const idx = Number.parseInt(req.params.idx, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(404).render('error', { title: 'Not found', message: 'No such chapter.' });
  }
  const chapter = books.getChapter(book.id, idx);
  if (!chapter) return res.status(404).render('error', { title: 'Not found', message: 'No such chapter.' });
  const total = books.chapterCount(book.id);

  // Auto-bookmark like Wuxiaworld: opening a chapter ahead of the bookmark
  // moves it forward (Undo offered client-side); an older chapter never moves
  // it automatically — the reader gets a manual "Bookmark" prompt instead.
  // ?peek=1 (notification links) never advances: checking a reply far ahead
  // of where you are reading must not drag your bookmark there.
  const peek = req.query.peek === '1';
  let bookmark = null;
  if (req.user) {
    const existing = bookmarks.getBookmark(req.user.id, book.id);
    if (!existing || idx > existing.chapter_idx) {
      if (peek) {
        bookmark = { action: 'peek', bmIdx: existing ? existing.chapter_idx : -1 };
      } else {
        bookmarks.setBookmark(req.user.id, book.id, idx);
        bookmark = { action: 'advanced', prevIdx: existing ? existing.chapter_idx : null, bmIdx: idx };
      }
    } else if (idx < existing.chapter_idx) {
      bookmark = { action: 'older', bmIdx: existing.chapter_idx };
    } else {
      bookmark = { action: 'same', bmIdx: idx, para: existing.para_index };
    }
  }

  res.render('reader', {
    title: `${chapter.title} — ${book.title}`,
    book,
    chapter,
    prevIdx: idx > 0 ? idx - 1 : null,
    nextIdx: idx + 1 < total ? idx + 1 : null,
    badgeCounts: commentsService.badgeCounts(chapter.id),
    chapterCommentCount: commentsService.chapterCommentCount(chapter.id),
    toc: books.chapterList(book.id),
    bookmark,
  });
});

function loadViewableBookById(req, res) {
  const book = books.getBookById(Number(req.params.bookId));
  if (!canViewBook(book, req.user)) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return book;
}

// Used by the reader's Undo / "Bookmark this chapter" buttons.
router.put('/api/book/:bookId/bookmark', requireAuth, (req, res) => {
  const book = loadViewableBookById(req, res);
  if (!book) return;
  const idx = Number.parseInt(req.body.idx, 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= books.chapterCount(book.id)) {
    return res.status(400).json({ error: 'bad chapter index' });
  }
  bookmarks.setBookmark(req.user.id, book.id, idx);
  res.json({ ok: true, idx });
});

// Reading position inside the bookmarked chapter, pushed by the reader while
// scrolling. updatePosition no-ops unless the bookmark still points at idx.
router.put('/api/book/:bookId/position', requireAuth, (req, res) => {
  const book = loadViewableBookById(req, res);
  if (!book) return;
  const idx = Number.parseInt(req.body.idx, 10);
  const para = Number.parseInt(req.body.para, 10);
  if (!Number.isInteger(idx) || idx < 0 || !Number.isInteger(para) || para < 0 || para > 1000000) {
    return res.status(400).json({ error: 'bad position' });
  }
  res.json({ ok: true, applied: bookmarks.updatePosition(req.user.id, book.id, idx, para) });
});

router.delete('/api/book/:bookId/bookmark', requireAuth, (req, res) => {
  const book = loadViewableBookById(req, res);
  if (!book) return;
  bookmarks.removeBookmark(req.user.id, book.id);
  res.json({ ok: true });
});

// Plain-form variant for the shelf's ✕ button (no JS on that page).
router.post('/book/:slug/bookmark/remove', requireAuth, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    return res.status(404).render('error', { title: 'Not found', message: 'No such book.' });
  }
  bookmarks.removeBookmark(req.user.id, book.id);
  res.redirect('/');
});

module.exports = router;
