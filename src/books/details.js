const fs = require('fs');
const nodePath = require('path');
const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { requireAuth, requireOwner, canViewBook } = require('../auth/middleware');
const books = require('./service');
const bookmarks = require('./bookmarks');
const ratings = require('./ratings');
const friends = require('../friends/service');
const { relTime } = require('../i18n');

// The book page (cover, description, ratings, finished) and the owner's
// "Edit details" form. Mounted before src/books/routes.js, whose
// /book/:slug/:idx would otherwise read "edit" as a chapter number.

const router = express.Router();

const COVER_MAX_MB = 5;
const cover = multer({ storage: multer.memoryStorage(), limits: { fileSize: COVER_MAX_MB * 1024 * 1024, files: 1 } });

// Image type from the file's first bytes (never trust the name or browser).
function imageExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return '.png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return '.gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function notFound(req, res) {
  res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
}

function viewableBook(req, res) {
  const book = books.getBookBySlug(req.params.slug);
  if (!canViewBook(book, req.user)) {
    notFound(req, res);
    return null;
  }
  return book;
}

router.get('/book/:slug', (req, res) => {
  const book = viewableBook(req, res);
  if (!book) return;
  const mark = req.user ? bookmarks.getBookmark(req.user.id, book.id) : null;
  res.render('book', {
    title: book.title,
    book,
    chapterTotal: books.chapterCount(book.id),
    mark,
    markTitle: mark ? books.chapterTitle(book.id, mark.chapter_idx) : null,
    ratings: ratings.forBook(book.id),
    mine: req.user ? ratings.mine(req.user.id, book.id) : null,
    friends: friends.friendsProgress(req.user, { bookId: book.id, lang: req.lang }),
    ago: (ts) => relTime(ts, req.lang),
  });
});

router.post('/book/:slug/finish', requireAuth, (req, res) => {
  const book = viewableBook(req, res);
  if (!book) return;
  ratings.finish(req.user.id, book.id);
  res.redirect(`/book/${book.slug}#rate`);
});

router.post('/book/:slug/unfinish', requireAuth, (req, res) => {
  const book = viewableBook(req, res);
  if (!book) return;
  ratings.unfinish(req.user.id, book.id);
  res.redirect(`/book/${book.slug}#rate`);
});

router.post('/book/:slug/rate', requireAuth, (req, res) => {
  const book = viewableBook(req, res);
  if (!book) return;
  const parsed = ratings.parseRating(req.body);
  if (parsed.error) return res.status(400).render('error', { title: req.t('Error'), message: req.t('Reviews can be up to {max} characters.', { max: ratings.REVIEW_MAX }) });
  ratings.rate(req.user.id, book.id, parsed);
  res.redirect(`/book/${book.slug}#ratings`);
});

// ---------- owner: edit details ----------

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Returns { values } or { values, error } (error already translated).
function parseDetails(body, t) {
  const description = String(body.description || '').trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  const rawIndex = String(body.series_index || '').trim().replace(',', '.');
  const values = {
    title: clean(body.title, 200),
    author: clean(body.author, 120) || null,
    series: clean(body.series, 120) || null,
    series_index: rawIndex === '' ? null : Number(rawIndex),
    description: description.slice(0, 2000) || null,
  };
  if (!values.title) return { values, error: t('Enter a title.') };
  if (values.series_index !== null && !(Number.isFinite(values.series_index) && values.series_index >= 0 && values.series_index < 10000)) {
    return { values, error: t('The number in the series must be a number, like 2 or 2.5.') };
  }
  return { values };
}

function renderEdit(req, res, book, { values = book, error = null } = {}) {
  res.status(error ? 400 : 200).render('book-edit', { title: req.t('Edit details'), book, values, error, coverMaxMb: COVER_MAX_MB });
}

router.get('/book/:slug/edit', requireOwner, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!book) return notFound(req, res);
  renderEdit(req, res, book);
});

router.post('/book/:slug/edit', requireOwner, (req, res) => {
  const book = books.getBookBySlug(req.params.slug);
  if (!book) return notFound(req, res);
  cover.single('cover')(req, res, (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? req.t('That image is too large — the limit is {mb} MB.', { mb: COVER_MAX_MB })
        : req.t('Upload failed: {error}', { error: uploadErr.message });
      return renderEdit(req, res, book, { values: Object.assign({}, book, req.body), error: message });
    }
    const { values, error } = parseDetails(req.body, req.t);
    if (error) return renderEdit(req, res, book, { values, error });

    let coverPath = book.cover_path;
    const dir = books.bookDir(book.id);
    if (req.file) {
      const ext = imageExt(req.file.buffer);
      if (!ext) return renderEdit(req, res, book, { values, error: req.t('The cover must be a JPEG, PNG, WebP or GIF image.') });
      coverPath = `cover-${Date.now()}${ext}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(nodePath.join(dir, coverPath), req.file.buffer);
    } else if (req.body.remove_cover === '1') {
      coverPath = null;
    }
    db.prepare(`
      UPDATE books SET title = ?, author = ?, series = ?, series_index = ?, description = ?, cover_path = ?, updated_at = ?
      WHERE id = ?
    `).run(values.title, values.author, values.series, values.series_index, values.description, coverPath, Date.now(), book.id);
    // the old cover file goes once the new one is in place
    if (book.cover_path && book.cover_path !== coverPath) {
      fs.rmSync(nodePath.join(dir, nodePath.basename(book.cover_path)), { force: true });
    }
    res.redirect(`/book/${book.slug}`);
  });
});

module.exports = router;
module.exports.imageExt = imageExt;
module.exports.parseDetails = parseDetails;
