const fs = require('fs');
const nodePath = require('path');
const express = require('express');
const { canViewBook } = require('../auth/middleware');
const books = require('../books/service');

const router = express.Router();

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

// Book assets are never served via express.static: every request passes the
// visibility check, and unauthorized access 404s like the book pages do.
function sendBookFile(req, res, book, filePath) {
  if (!canViewBook(book, req.user)) return res.status(404).end();
  const resolved = nodePath.resolve(filePath);
  if (!resolved.startsWith(nodePath.resolve(books.bookDir(book.id)) + nodePath.sep)) {
    return res.status(404).end();
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).end();
    // sandbox CSP: an SVG opened directly can't run script in the app origin
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.set('Content-Type', MIME[nodePath.extname(resolved).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(resolved).pipe(res);
  });
}

router.get('/media/book/:id/img/:name', (req, res) => {
  const book = books.getBookById(Number(req.params.id));
  if (!book) return res.status(404).end();
  const name = nodePath.basename(req.params.name);
  sendBookFile(req, res, book, nodePath.join(books.bookDir(book.id), 'images', name));
});

router.get('/media/book/:id/cover', (req, res) => {
  const book = books.getBookById(Number(req.params.id));
  if (!book || !book.cover_path) return res.status(404).end();
  sendBookFile(req, res, book, nodePath.join(books.bookDir(book.id), nodePath.basename(book.cover_path)));
});

module.exports = router;
