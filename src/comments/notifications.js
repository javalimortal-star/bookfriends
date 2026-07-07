const { db } = require('../db');

// One notification per reply, aimed at the parent comment's author. Rows
// cascade away with the reply comment (and thus with chapters/books/users).

function notifyReply(recipientId, replyCommentId) {
  db.prepare('INSERT INTO notifications (user_id, comment_id, created_at) VALUES (?, ?, ?)')
    .run(recipientId, replyCommentId, Date.now());
}

function unseenCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND seen = 0').get(userId).n;
}

function listForUser(userId, limit = 50) {
  return db.prepare(`
    SELECT n.id, n.seen, n.created_at,
      c.body, c.para_index,
      u.email AS replier_email, u.display_name AS replier_name,
      ch.idx AS chapter_idx, ch.title AS chapter_title,
      b.slug AS book_slug, b.title AS book_title
    FROM notifications n
    JOIN comments c ON c.id = n.comment_id
    JOIN users u ON u.id = c.user_id
    JOIN chapters ch ON ch.id = c.chapter_id
    JOIN books b ON b.id = c.book_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function markAllSeen(userId) {
  db.prepare('UPDATE notifications SET seen = 1 WHERE user_id = ? AND seen = 0').run(userId);
}

module.exports = { notifyReply, unseenCount, listForUser, markAllSeen };
