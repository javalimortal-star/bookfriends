const { db } = require('../db');
const { displayName, initialOf, avatarTone } = require('../users');

// "Friends" are simply every other user: the site is a small group that
// reads together. Their bookmarks show where they are in each book.

// Other users' bookmarks on the books `viewer` can see, most recently moved
// first, in one query for the whole page. People who turned off
// share_progress never appear. `bookId` narrows it to one book.
function friendsProgress(viewer, { bookId = null } = {}) {
  if (!viewer) return [];
  const rows = db.prepare(`
    SELECT bm.book_id, bm.chapter_idx, bm.updated_at, u.id AS user_id, u.display_name, u.email,
      (SELECT COUNT(*) FROM chapters c WHERE c.book_id = bm.book_id) AS total
    FROM bookmarks bm
    JOIN users u ON u.id = bm.user_id
    JOIN books b ON b.id = bm.book_id
    WHERE bm.user_id != @viewer AND u.share_progress = 1
      AND (b.visibility = 'public' OR @owner = 1)
      AND (@book IS NULL OR bm.book_id = @book)
    ORDER BY bm.updated_at DESC
  `).all({ viewer: viewer.id, owner: viewer.role === 'owner' ? 1 : 0, book: bookId });
  return rows.map((row) => {
    const name = displayName(row);
    return {
      userId: row.user_id,
      bookId: row.book_id,
      name,
      initial: initialOf(name),
      tone: avatarTone(name),
      chapterIdx: row.chapter_idx,
      chapter: row.chapter_idx + 1,
      total: row.total,
      updatedAt: row.updated_at,
    };
  });
}

function groupByBook(friends) {
  const byBook = new Map();
  for (const friend of friends) {
    if (!byBook.has(friend.bookId)) byBook.set(friend.bookId, []);
    byBook.get(friend.bookId).push(friend);
  }
  return byBook;
}

// The friend worth comparing with on the "Continue reading" card: the one
// nearest to your chapter (someone to talk to), the most recent on a tie.
// `friends` arrive newest first, so the first nearest one wins.
function closestFriend(myIdx, friends) {
  let best = null;
  for (const friend of friends || []) {
    if (!best || Math.abs(friend.chapterIdx - myIdx) < Math.abs(best.chapterIdx - myIdx)) best = friend;
  }
  return best;
}

module.exports = { friendsProgress, groupByBook, closestFriend };
