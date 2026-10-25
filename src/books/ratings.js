const { db } = require('../db');
const { displayName, initialOf, avatarTone } = require('../users');

// Finished books and their ratings: one row per reader and book, created by
// "Mark as finished"; stars and a review are optional and editable.

const REVIEW_MAX = 1000;

function finish(userId, bookId) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO book_ratings (user_id, book_id, finished_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO NOTHING
  `).run(userId, bookId, now, now);
}

function unfinish(userId, bookId) {
  db.prepare('DELETE FROM book_ratings WHERE user_id = ? AND book_id = ?').run(userId, bookId);
}

// Rating a book also marks it finished.
function rate(userId, bookId, { stars, review }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO book_ratings (user_id, book_id, stars, review, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET stars = excluded.stars, review = excluded.review, updated_at = excluded.updated_at
  `).run(userId, bookId, stars, review, now, now);
}

function mine(userId, bookId) {
  return db.prepare('SELECT stars, review, finished_at FROM book_ratings WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId) || null;
}

// Everyone's ratings for the book page, newest first, with the average.
function forBook(bookId) {
  const rows = db.prepare(`
    SELECT r.user_id, r.stars, r.review, r.finished_at, r.updated_at, u.email, u.display_name
    FROM book_ratings r JOIN users u ON u.id = r.user_id
    WHERE r.book_id = ? ORDER BY r.updated_at DESC
  `).all(bookId);
  const list = rows.map((row) => {
    const name = displayName(row);
    return { userId: row.user_id, name, initial: initialOf(name), tone: avatarTone(name),
      stars: row.stars, review: row.review, finishedAt: row.finished_at, updatedAt: row.updated_at };
  });
  return Object.assign({ list }, average(list.map((r) => r.stars)));
}

function average(stars) {
  const rated = stars.filter((s) => s);
  return { count: rated.length, avg: rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null };
}

// Per book on the shelf: { count, avg } of everyone's stars, and the
// viewer's own { finished, stars }.
function shelfSummary(userId) {
  const byBook = new Map();
  for (const row of db.prepare('SELECT book_id, COUNT(stars) AS n, AVG(stars) AS avg FROM book_ratings GROUP BY book_id').all()) {
    byBook.set(row.book_id, { count: row.n, avg: row.avg, mine: null });
  }
  if (userId) {
    for (const row of db.prepare('SELECT book_id, stars FROM book_ratings WHERE user_id = ?').all(userId)) {
      byBook.get(row.book_id).mine = { stars: row.stars };
    }
  }
  return byBook;
}

// The rating form: stars 1-5 or none, review trimmed and capped.
function parseRating(body) {
  const stars = Number.parseInt(body.stars, 10);
  const review = String(body.review || '').trim().replace(/\n{3,}/g, '\n\n');
  if (review.length > REVIEW_MAX) return { error: 'review too long' };
  return { stars: stars >= 1 && stars <= 5 ? stars : null, review: review || null };
}

module.exports = { finish, unfinish, rate, mine, forBook, shelfSummary, parseRating, average, REVIEW_MAX };
