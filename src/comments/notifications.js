const { db } = require('../db');
const push = require('../push');

// A notification points at the comment that caused it; `kind` says why
// ('reply': someone answered your comment). Rows cascade away with that
// comment (and thus with chapters/books/users).

function notify(recipientId, commentId, kind) {
  const info = db.prepare('INSERT INTO notifications (user_id, comment_id, kind, created_at) VALUES (?, ?, ?, ?)')
    .run(recipientId, commentId, kind, Date.now());
  push.notificationCreated(Number(info.lastInsertRowid));
}

function notifyReply(recipientId, replyCommentId) {
  notify(recipientId, replyCommentId, 'reply');
}

function unseenCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND seen = 0').get(userId).n;
}

function listForUser(userId, limit = 50) {
  return db.prepare(`
    SELECT n.id, n.kind, n.seen, n.created_at,
      c.body, c.para_index, c.spoiler,
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

module.exports = { notify, notifyReply, unseenCount, listForUser, markAllSeen };
