const { db } = require('../db');
const push = require('../push');
const { LANGS, translator } = require('../i18n');
const { displayName } = require('../users');

// Book requests: friends ask the owner to upload a book, others add a
// "me too". Open requests are sorted by votes, then newest.

const LIMITS = { title: 120, author: 80, note: 300 };

// One line, single spaces.
function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// The note may keep its line breaks, but no runs of blank lines.
function cleanNote(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Lowercase, no accents or punctuation: "Dom Casmurro!" matches "dom  casmurro".
function normTitle(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// { values } when the form is fine, else { error } in the asker's language.
function validate(body, t) {
  const values = {
    title: cleanLine(body.title),
    author: cleanLine(body.author),
    note: cleanNote(body.note),
  };
  if (!values.title) return { values, error: t('Enter the title of the book.') };
  if (values.title.length > LIMITS.title) return { values, error: t('The title can have at most {max} characters.', { max: LIMITS.title }) };
  if (values.author.length > LIMITS.author) return { values, error: t('The author can have at most {max} characters.', { max: LIMITS.author }) };
  if (values.note.length > LIMITS.note) return { values, error: t('The note can have at most {max} characters.', { max: LIMITS.note }) };
  return { values, error: null };
}

// The shelf book that most likely fulfils a request, to preselect in the
// owner's "Mark as uploaded" form: same title, or one title inside the other.
function suggestBook(requestTitle, books) {
  const wanted = normTitle(requestTitle);
  if (wanted.length < 3) return null;
  const exact = books.find((b) => normTitle(b.title) === wanted);
  if (exact) return exact;
  return books.find((b) => {
    const title = normTitle(b.title);
    return title.length >= 3 && (title.includes(wanted) || wanted.includes(title));
  }) || null;
}

const LIST_SQL = `
  SELECT r.*, u.display_name, u.email,
    (SELECT COUNT(*) FROM book_request_votes v WHERE v.request_id = r.id) AS votes,
    EXISTS (SELECT 1 FROM book_request_votes v WHERE v.request_id = r.id AND v.user_id = @viewer) AS voted,
    b.slug AS book_slug, b.title AS book_title, b.visibility AS book_visibility
  FROM book_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN books b ON b.id = r.book_id`;

function withNames(rows) {
  return rows.map((row) => Object.assign(row, { requesterName: displayName(row), voted: row.voted === 1 }));
}

function listOpen(viewerId) {
  return withNames(db.prepare(`${LIST_SQL} WHERE r.status = 'open' ORDER BY votes DESC, r.created_at DESC, r.id DESC`)
    .all({ viewer: viewerId }));
}

// Done and declined ones, latest decision first.
function listFinished(viewerId, limit = 50) {
  return withNames(db.prepare(`${LIST_SQL} WHERE r.status != 'open' ORDER BY r.updated_at DESC, r.id DESC LIMIT @limit`)
    .all({ viewer: viewerId, limit }));
}

function openCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM book_requests WHERE status = 'open'").get().n;
}

function getRequest(id) {
  return db.prepare('SELECT * FROM book_requests WHERE id = ?').get(id);
}

// An open request for the same book already exists (to point at "Me too").
function findOpenDuplicate(title) {
  const wanted = normTitle(title);
  return db.prepare("SELECT id, title FROM book_requests WHERE status = 'open'").all()
    .find((r) => normTitle(r.title) === wanted) || null;
}

function createRequest(userId, { title, author, note }) {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO book_requests (user_id, title, author, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, title, author || null, note || null, 'open', now, now);
  return getRequest(Number(info.lastInsertRowid));
}

// Returns true when the user now votes for it.
function toggleVote(requestId, userId) {
  const removed = db.prepare('DELETE FROM book_request_votes WHERE request_id = ? AND user_id = ?').run(requestId, userId);
  if (removed.changes > 0) return false;
  db.prepare('INSERT INTO book_request_votes (request_id, user_id, created_at) VALUES (?, ?, ?)').run(requestId, userId, Date.now());
  return true;
}

function setStatus(requestId, status, bookId = null) {
  db.prepare('UPDATE book_requests SET status = ?, book_id = ?, updated_at = ? WHERE id = ?')
    .run(status, bookId, Date.now(), requestId);
}

function deleteRequest(requestId) {
  db.prepare('DELETE FROM book_requests WHERE id = ?').run(requestId);
}

// ---------- phone notifications, in each recipient's own language ----------

function langOf(userId) {
  const row = db.prepare('SELECT lang FROM users WHERE id = ?').get(userId);
  return row && LANGS[row.lang] ? row.lang : 'en';
}

// A failed push must never break the request itself.
function pushTo(userId, makePayload) {
  try {
    const sent = push.sendToUser(userId, makePayload(translator(langOf(userId))));
    if (sent && typeof sent.catch === 'function') sent.catch((err) => console.error('push failed:', err.message));
  } catch (err) {
    console.error('push failed:', err.message);
  }
}

function notifyCreated(request, askerName) {
  const owners = db.prepare("SELECT id FROM users WHERE role = 'owner' AND id != ?").all(request.user_id);
  for (const owner of owners) {
    pushTo(owner.id, (t) => ({
      title: t('New book request'),
      body: t('{name} asked for “{title}”', { name: askerName, title: request.title }),
      url: '/requests',
    }));
  }
}

// The asker and everyone who said "me too", except whoever marked it done.
function notifyDone(request, book, doneBy) {
  const voters = db.prepare('SELECT user_id FROM book_request_votes WHERE request_id = ?').all(request.id).map((v) => v.user_id);
  const recipients = new Set([request.user_id, ...voters]);
  recipients.delete(doneBy);
  const title = book ? book.title : request.title;
  for (const userId of recipients) {
    pushTo(userId, (t) => ({
      title: t('A book you asked for is here'),
      body: t('“{title}” is on the shelf now. Happy reading!', { title }),
      url: book ? `/book/${book.slug}/0` : '/',
    }));
  }
}

module.exports = {
  normTitle, validate, suggestBook, listOpen, listFinished, openCount, getRequest, findOpenDuplicate, createRequest, toggleVote, setStatus, deleteRequest, notifyCreated, notifyDone,
};
