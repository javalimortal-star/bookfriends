const { db } = require('../db');

function getBookmark(userId, bookId) {
  return db.prepare('SELECT chapter_idx, updated_at FROM bookmarks WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId);
}

function setBookmark(userId, bookId, chapterIdx) {
  db.prepare(`
    INSERT INTO bookmarks (user_id, book_id, chapter_idx, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_idx = excluded.chapter_idx, updated_at = excluded.updated_at
  `).run(userId, bookId, chapterIdx, Date.now());
}

function removeBookmark(userId, bookId) {
  db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND book_id = ?').run(userId, bookId);
}

module.exports = { getBookmark, setBookmark, removeBookmark };
