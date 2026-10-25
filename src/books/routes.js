const fs = require('fs');
const os = require('os');
const nodePath = require('path');
const express = require('express');
const multer = require('multer');
const { requireAuth, requireOwner, canViewBook } = require('../auth/middleware');
const books = require('./service');
const bookmarks = require('./bookmarks');
const ratings = require('./ratings');
const search = require('./search');
const { checkQuery } = require('./search-text');
const commentsService = require('../comments/service');
const friends = require('../friends/service');
const { LANGS } = require('../i18n');
const { searchLimiter } = require('../rate-limit');

const router = express.Router();

const MAX_EPUB_MB = Number(process.env.MAX_EPUB_MB) || 200;
const UPLOAD_TMP = nodePath.join(os.tmpdir(), 'bookfriends-uploads');
const upload = multer({
  // Re-create the temp folder on every upload rather than using multer's
  // `dest`, which creates it only once at boot: the OS tmp cleaner (Ubuntu's
  // systemd-tmpfiles, 30 days) deletes it after a quiet month, and every
  // upload after that failed with ENOENT.
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdir(UPLOAD_TMP, { recursive: true }, (err) => cb(err, UPLOAD_TMP));
    },
  }),
  limits: { fileSize: MAX_EPUB_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.toLowerCase().endsWith('.epub'));
  },
});

router.get('/', (req, res) => {
  const sort = ['added', 'title', 'author', 'series'].includes(req.query.sort) ? req.query.sort : 'added';
  const shelf = books.getShelf(req.user, sort);
  // The most recently read book gets a "Continue reading" card above the shelf
  let current = null;
  let currentAt = 0;
  if (req.user) {
    for (const book of shelf) {
      const mark = bookmarks.getBookmark(req.user.id, book.id);
      if (mark) {
        book.bookmarkIdx = mark.chapter_idx;
        book.chapterTotal = books.chapterCount(book.id);
        if (mark.updated_at > currentAt) {
          current = book;
          currentAt = mark.updated_at;
        }
      }
    }
  }
  const currentChapter = current ? books.chapterTitle(current.id, current.bookmarkIdx) : null;
  // Friends' bookmarks for every card in one query, grouped per book.
  const friendsByBook = friends.groupByBook(friends.friendsProgress(req.user, { lang: req.lang }));
  const currentFriend = current ? friends.closestFriend(current.bookmarkIdx, friendsByBook.get(current.id)) : null;
  res.render('shelf', {
    title: 'BookFriends', books: shelf, sort, current, currentChapter, friendsByBook, currentFriend,
    ratingsByBook: ratings.shelfSummary(req.user && req.user.id),
  });
});

router.get('/upload', requireOwner, (req, res) => {
  res.render('upload', { title: req.t('Upload a book'), error: null });
});

router.post('/upload', requireOwner, (req, res) => {
  // Run multer manually so its errors (e.g. file too large) render a helpful
  // message on the upload page instead of falling through to the 500 handler.
  upload.single('epub')(req, res, (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? req.t('That file is too large — the limit is {mb} MB (MAX_EPUB_MB in .env changes it).', { mb: MAX_EPUB_MB })
        : req.t('Upload failed: {error}', { error: uploadErr.message });
      return res.status(400).render('upload', { title: req.t('Upload a book'), error: message });
    }
    if (!req.file) {
      return res.status(400).render('upload', { title: req.t('Upload a book'), error: req.t('Choose a .epub file.') });
    }
    try {
      const book = books.createBookFromEpub(req.file.path, req.user.id);
      res.redirect(`/book/${book.slug}/0`);
    } catch (err) {
      res.status(400).render('upload', { title: req.t('Upload a book'), error: req.t('Could not parse that EPUB: {error}', { error: err.message }) });
    } finally {
      fs.rmSync(req.file.path, { force: true });
    }
  });
});

router.post('/book/:slug/visibility', requireOwner, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!book) return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
  const next = book.visibility === 'public' ? 'private' : 'public';
  require('../db').db.prepare('UPDATE books SET visibility = ? WHERE id = ?').run(next, book.id);
  res.redirect('/');
});

router.post('/book/:slug/delete', requireOwner, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!book) return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
  books.deleteBook(book.id);
  res.redirect('/');
});

router.get('/book/:slug/download', (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
  }
  const file = nodePath.join(books.bookDir(book.id), 'book.epub');
  if (!fs.existsSync(file)) {
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No EPUB stored for this book.') });
  }
  res.download(file, `${book.slug}.epub`);
});

// Search inside a book. Registered before /book/:slug/:idx, which would
// otherwise read "search" as a chapter number (and 404).
router.get('/book/:slug/search', searchLimiter, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const check = q ? checkQuery(q) : 'empty';
  // "Back" returns to the chapter the search was opened from (?from=),
  // else to the bookmark, else to the start.
  const total = books.chapterCount(book.id);
  const from = Number.parseInt(req.query.from, 10);
  const mark = req.user ? bookmarks.getBookmark(req.user.id, book.id) : null;
  const backIdx = Number.isInteger(from) && from >= 0 && from < total ? from : (mark ? mark.chapter_idx : 0);
  res.render('search', {
    title: req.t('Search in {book}', { book: book.title }),
    book,
    q,
    check,
    result: check === 'ok' ? search.searchBook(book.id, q) : null,
    status: search.indexStatus(book.id),
    backIdx,
    total,
    maxResults: search.MAX_RESULTS,
  });
});

router.get('/book/:slug/:idx', (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
  }
  const idx = Number.parseInt(req.params.idx, 10);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such chapter.') });
  }
  const chapter = books.getChapter(book.id, idx);
  if (!chapter) return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such chapter.') });
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
    finished: req.user ? !!ratings.mine(req.user.id, book.id) : false,
    title: `${chapter.title} — ${book.title}`,
    book,
    chapter,
    prevIdx: idx > 0 ? idx - 1 : null,
    nextIdx: idx + 1 < total ? idx + 1 : null,
    badgeCounts: commentsService.badgeCounts(chapter.id),
    chapterCommentCount: commentsService.chapterCommentCount(chapter.id),
    toc: books.chapterList(book.id),
    bookmark,
    ...readerFriends(req, book, idx),
  });
});

// The "Friends reading this book" strip above the chapter comments; friends
// on this very chapter come first and get a sentence of their own.
function readerFriends(req, book, idx) {
  const list = friends.friendsProgress(req.user, { bookId: book.id, lang: req.lang });
  const here = list.filter((f) => f.chapterIdx === idx);
  const others = list.filter((f) => f.chapterIdx !== idx);
  const names = here.length
    ? new Intl.ListFormat(LANGS[req.lang].locale, { type: 'conjunction' }).format(here.map((f) => f.name))
    : '';
  return { friends: here.concat(others), friendsHere: here.length, friendsHereNames: names };
}

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
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
  }
  bookmarks.removeBookmark(req.user.id, book.id);
  res.redirect('/');
});

module.exports = router;
