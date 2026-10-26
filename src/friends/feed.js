const { db } = require('../db');
const { displayName, initialOf, avatarTone } = require('../users');
const { linkFor } = require('../comments/notifications');

// "What's new" on the shelf: what friends did lately, newest first. Only
// books the viewer can see, never the viewer's own doings. A comment's text
// shows only if it's no spoiler and the viewer has read that far.

const DAY = 24 * 60 * 60 * 1000;
const BURST = 12 * 60 * 60 * 1000; // a friend's comments on one chapter within this read as one item

function person(row) {
  const name = displayName(row);
  return { name, initial: initialOf(name), tone: avatarTone(name) };
}

function excerpt(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

function feedFor(viewer, { days = 30, limit = 20 } = {}) {
  if (!viewer) return [];
  const p = { viewer: viewer.id, owner: viewer.role === 'owner' ? 1 : 0, since: Date.now() - days * DAY };
  const visible = "(b.visibility = 'public' OR @owner = 1)";
  const readTo = new Map(db.prepare('SELECT book_id, chapter_idx FROM bookmarks WHERE user_id = ?').all(viewer.id)
    .map((r) => [r.book_id, r.chapter_idx]));
  const items = [];

  // comments, one item per burst on a chapter
  const comments = db.prepare(`
    SELECT c.user_id, c.chapter_id, c.para_index, c.body, c.spoiler, c.created_at, c.book_id,
      ch.idx AS chapter_idx, b.slug AS book_slug, b.title AS book_title, u.display_name, u.email
    FROM comments c JOIN chapters ch ON ch.id = c.chapter_id JOIN books b ON b.id = c.book_id JOIN users u ON u.id = c.user_id
    WHERE c.created_at > @since AND c.user_id != @viewer AND ${visible}
    ORDER BY c.created_at DESC LIMIT 300
  `).all(p);
  const open = new Map(); // user:chapter -> the item collecting that burst
  for (const c of comments) {
    const key = `${c.user_id}:${c.chapter_id}`;
    const item = open.get(key);
    if (item && item.oldest - c.created_at < BURST) {
      item.count += 1;
      item.oldest = c.created_at;
      continue;
    }
    const ahead = c.chapter_idx > (readTo.has(c.book_id) ? readTo.get(c.book_id) : -1);
    const fresh = {
      kind: 'comment', ...person(c), at: c.created_at, oldest: c.created_at, count: 1,
      bookTitle: c.book_title, chapter: c.chapter_idx + 1, link: linkFor(c),
      spoiler: !!c.spoiler, ahead, excerpt: c.spoiler || ahead ? null : excerpt(c.body),
    };
    open.set(key, fresh);
    items.push(fresh);
  }

  for (const r of db.prepare(`
    SELECT r.stars, r.updated_at, b.slug, b.title, u.display_name, u.email
    FROM book_ratings r JOIN books b ON b.id = r.book_id JOIN users u ON u.id = r.user_id
    WHERE r.updated_at > @since AND r.user_id != @viewer AND ${visible}
    ORDER BY r.updated_at DESC LIMIT 50
  `).all(p)) {
    items.push({ kind: 'finished', ...person(r), at: r.updated_at, stars: r.stars, bookTitle: r.title, link: `/book/${r.slug}#ratings` });
  }

  for (const b of db.prepare(`
    SELECT b.*, COALESCE(b.published_at, b.created_at) AS at FROM books b
    WHERE COALESCE(b.published_at, b.created_at) > @since AND b.owner_id != @viewer AND ${visible}
    ORDER BY at DESC LIMIT 20
  `).all(p)) {
    items.push({ kind: 'book', at: b.at, book: b, bookTitle: b.title, link: `/book/${b.slug}` });
  }

  for (const r of db.prepare(`
    SELECT r.title, r.created_at, u.display_name, u.email FROM book_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'open' AND r.created_at > @since AND r.user_id != @viewer
    ORDER BY r.created_at DESC LIMIT 20
  `).all(p)) {
    items.push({ kind: 'request', ...person(r), at: r.created_at, bookTitle: r.title, link: '/requests' });
  }

  return items.sort((a, b) => b.at - a.at).slice(0, limit);
}

module.exports = { feedFor, BURST };
