const { db } = require('../db');
const { findMentions } = require('./mentions');

// The name a user goes by in comments and @mentions.
function userName(row) {
  return row.display_name || String(row.email).split('@')[0];
}

// Everyone who can be @mentioned, with what canViewBook() needs (role).
function mentionableUsers() {
  return db.prepare('SELECT id, email, display_name, role FROM users').all()
    .map((row) => ({ id: row.id, name: userName(row), role: row.role }));
}

// Distinct mentioned names as written, for reader.js to highlight.
function mentionNames(body, users) {
  return [...new Set(findMentions(body, users).map((m) => m.name))];
}

// Per-paragraph badge counts for a chapter (paragraph comments only, replies included).
function badgeCounts(chapterId) {
  const rows = db.prepare(
    'SELECT para_index, COUNT(*) AS n FROM comments WHERE chapter_id = ? AND para_index IS NOT NULL GROUP BY para_index'
  ).all(chapterId);
  const counts = {};
  for (const row of rows) counts[row.para_index] = row.n;
  return counts;
}

function chapterCommentCount(chapterId) {
  return db.prepare('SELECT COUNT(*) AS n FROM comments WHERE chapter_id = ?').get(chapterId).n;
}

function toJson(row, user, isOwner, users) {
  return {
    id: row.id,
    paraIndex: row.para_index,
    parentId: row.parent_id,
    userId: row.user_id,
    userName: userName(row),
    body: row.body,
    spoiler: !!row.spoiler,
    mentions: mentionNames(row.body, users),
    createdAt: row.created_at,
    edited: !!row.edited,
    score: row.score || 0,
    likes: row.likes || 0,
    dislikes: row.dislikes || 0,
    myVote: row.my_vote || 0,
    canEdit: !!(user && user.id === row.user_id),
    canDelete: !!(user && (user.id === row.user_id || isOwner)),
    replies: [],
  };
}

// Threaded comment list for one anchor: a paragraph (para=<n>) or the chapter
// thread (para=null). Top-level sorted by `sort`; replies always oldest-first.
function listComments({ chapterId, paraIndex, sort, user, bookOwnerId }) {
  const anchorClause = paraIndex === null ? 'para_index IS NULL' : 'para_index = ?';
  const params = paraIndex === null ? [chapterId] : [chapterId, paraIndex];
  const rows = db.prepare(`
    SELECT c.*, u.email, u.display_name,
      COALESCE(SUM(v.value), 0) AS score,
      COALESCE(SUM(CASE WHEN v.value = 1 THEN 1 ELSE 0 END), 0) AS likes,
      COALESCE(SUM(CASE WHEN v.value = -1 THEN 1 ELSE 0 END), 0) AS dislikes,
      COALESCE((SELECT value FROM votes WHERE comment_id = c.id AND user_id = ?), 0) AS my_vote
    FROM comments c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN votes v ON v.comment_id = c.id
    WHERE c.chapter_id = ? AND ${anchorClause.replace('para_index', 'c.para_index')}
    GROUP BY c.id
  `).all(user ? user.id : 0, ...params);

  const isOwner = !!(user && user.role === 'owner' && bookOwnerId === user.id);
  const users = rows.length ? mentionableUsers() : [];
  const byId = new Map();
  const top = [];
  for (const row of rows) byId.set(row.id, toJson(row, user, isOwner, users));
  for (const row of rows) {
    const node = byId.get(row.id);
    if (row.parent_id && byId.has(row.parent_id)) {
      byId.get(row.parent_id).replies.push(node);
    } else {
      top.push(node);
    }
  }
  for (const node of byId.values()) node.replies.sort((a, b) => a.createdAt - b.createdAt);
  if (sort === 'new') {
    top.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    top.sort((a, b) => (b.score - a.score) || (b.createdAt - a.createdAt));
  }
  return top;
}

function getComment(id) {
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
}

function createComment({ bookId, chapterId, paraIndex, parentId, userId, body, spoiler = false }) {
  const info = db.prepare(
    'INSERT INTO comments (book_id, chapter_id, para_index, parent_id, user_id, body, spoiler, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(bookId, chapterId, paraIndex, parentId, userId, body, spoiler ? 1 : 0, Date.now());
  return getComment(info.lastInsertRowid);
}

function updateComment(id, body, spoiler) {
  db.prepare('UPDATE comments SET body = ?, spoiler = ?, updated_at = ?, edited = 1 WHERE id = ?')
    .run(body, spoiler ? 1 : 0, Date.now(), id);
  return getComment(id);
}

function deleteComment(id) {
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
}

// Vote toggle: same value removes the vote, different value replaces it.
function vote(commentId, userId, value) {
  const existing = db.prepare('SELECT value FROM votes WHERE comment_id = ? AND user_id = ?').get(commentId, userId);
  if (existing && existing.value === value) {
    db.prepare('DELETE FROM votes WHERE comment_id = ? AND user_id = ?').run(commentId, userId);
  } else {
    db.prepare(
      'INSERT INTO votes (comment_id, user_id, value) VALUES (?, ?, ?) ' +
      'ON CONFLICT(comment_id, user_id) DO UPDATE SET value = excluded.value'
    ).run(commentId, userId, value);
  }
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS likes,
      COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS dislikes,
      COALESCE((SELECT value FROM votes WHERE comment_id = ? AND user_id = ?), 0) AS myVote
    FROM votes WHERE comment_id = ?
  `).get(commentId, userId, commentId);
}

module.exports = {
  badgeCounts, chapterCommentCount, listComments, getComment,
  createComment, updateComment, deleteComment, vote,
  mentionableUsers, mentionNames,
};
