const { db } = require('../db');

function getBookmark(userId, bookId) {
  return db.prepare('SELECT chapter_idx, para_index, updated_at FROM bookmarks WHERE user_id = ? AND book_id = ?')
    .get(userId, bookId);
}

function setBookmark(userId, bookId, chapterIdx) {
  // Moving the bookmark to a chapter resets the in-chapter paragraph position.
  db.prepare(`
    INSERT INTO bookmarks (user_id, book_id, chapter_idx, para_index, updated_at) VALUES (?, ?, ?, NULL, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_idx = excluded.chapter_idx, para_index = NULL, updated_at = excluded.updated_at
  `).run(userId, bookId, chapterIdx, Date.now());
}

// Applies only while the bookmark still points at this chapter, so a stale
// tab (or a second device left behind) cannot drag the bookmark around.
function updatePosition(userId, bookId, chapterIdx, paraIndex) {
  const info = db.prepare(
    'UPDATE bookmarks SET para_index = ?, updated_at = ? WHERE user_id = ? AND book_id = ? AND chapter_idx = ?'
  ).run(paraIndex, Date.now(), userId, bookId, chapterIdx);
  return info.changes > 0;
}

function removeBookmark(userId, bookId) {
  db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND book_id = ?').run(userId, bookId);
}

module.exports = { getBookmark, setBookmark, updatePosition, removeBookmark };
