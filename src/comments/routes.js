const express = require('express');
const { requireAuth, canViewBook } = require('../auth/middleware');
const { commentLimiter } = require('../rate-limit');
const comments = require('./service');
const notifications = require('./notifications');
const { findMentions, suggest } = require('./mentions');
const books = require('../books/service');
const { relTime } = require('../i18n');

const router = express.Router();

function loadViewableChapter(req, res) {
  const chapter = books.getChapterById(Number(req.params.chapterId));
  if (!chapter) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  const book = books.getBookById(chapter.book_id);
  if (!canViewBook(book, req.user)) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  return { chapter, book };
}

// JSON clients send true/false; a plain form post would send "on".
function isOn(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

// Tell the people a saved comment @mentions, once each, if they can see the
// book (private books are owner-only). On an edit, `oldBody`'s mentions were
// already handled; people already notified about this comment (the parent's
// author got 'reply') are skipped. Returns the names to highlight.
function notifyMentions(comment, book, oldBody) {
  const users = comments.mentionableUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  const before = new Set(oldBody === undefined ? [] : findMentions(oldBody, users).map((m) => m.id));
  const notified = notifications.recipientsOf(comment.id);
  for (const { id } of findMentions(comment.body, users)) {
    if (id === comment.user_id || before.has(id) || notified.has(id)) continue;
    if (!canViewBook(book, byId.get(id))) continue;
    notifications.notify(id, comment.id, 'mention');
  }
  return comments.mentionNames(comment.body, users);
}

// Names for the suggestions shown while typing "@" in a comment.
router.get('/api/mentions', requireAuth, (req, res) => {
  const q = String(req.query.q || '').slice(0, 50);
  res.json(suggest(comments.mentionableUsers().filter((u) => u.id !== req.user.id), q, 8));
});

// Readable by anyone who can view the book (incl. logged-out on public books).
router.get('/api/chapter/:chapterId/comments', (req, res) => {
  const ctx = loadViewableChapter(req, res);
  if (!ctx) return;
  const para = req.query.para === 'chapter' || req.query.para === undefined
    ? null
    : Number.parseInt(req.query.para, 10);
  if (para !== null && !Number.isInteger(para)) return res.status(400).json({ error: 'bad para' });
  const sort = req.query.sort === 'new' ? 'new' : 'top';
  res.json({
    comments: comments.listComments({
      chapterId: ctx.chapter.id,
      paraIndex: para,
      sort,
      user: req.user,
      bookOwnerId: ctx.book.owner_id,
    }),
  });
});

router.post('/api/chapter/:chapterId/comments', requireAuth, commentLimiter, (req, res) => {
  const ctx = loadViewableChapter(req, res);
  if (!ctx) return;
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 10000) return res.status(400).json({ error: 'comment body required (max 10000 chars)' });

  let paraIndex = null;
  if (req.body.para_index !== null && req.body.para_index !== undefined && req.body.para_index !== '') {
    paraIndex = Number.parseInt(req.body.para_index, 10);
    if (!Number.isInteger(paraIndex) || paraIndex < 0) return res.status(400).json({ error: 'bad para_index' });
  }

  let parentId = null;
  let parentAuthorId = null;
  if (req.body.parent_id) {
    const parent = comments.getComment(Number(req.body.parent_id));
    if (!parent || parent.chapter_id !== ctx.chapter.id) return res.status(400).json({ error: 'bad parent_id' });
    parentId = parent.id;
    parentAuthorId = parent.user_id;
    paraIndex = parent.para_index; // replies inherit the parent's anchor
  }

  const created = comments.createComment({
    bookId: ctx.book.id,
    chapterId: ctx.chapter.id,
    paraIndex,
    parentId,
    userId: req.user.id,
    body,
    spoiler: isOn(req.body.spoiler),
  });
  if (parentAuthorId !== null && parentAuthorId !== req.user.id) {
    notifications.notifyReply(parentAuthorId, created.id);
  }
  const mentions = notifyMentions(created, ctx.book);
  res.status(201).json({ id: created.id, spoiler: !!created.spoiler, mentions });
});

router.get('/notifications', requireAuth, (req, res) => {
  const items = notifications.listForUser(req.user.id).map((n) => {
    return Object.assign(n, {
      link: notifications.linkFor(n),
      replierName: n.replier_name || n.replier_email.split('@')[0],
      // a spoiler stays hidden here too; the reader blurs it until tapped
      excerpt: n.spoiler ? null : n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body,
      when: relTime(n.created_at, req.lang),
    });
  });
  notifications.markAllSeen(req.user.id);
  res.locals.unseenNotifs = 0; // the bell clears as this page renders
  res.render('notifications', { title: req.t('Notifications'), items });
});

function loadEditableComment(req, res, { ownerMayDelete = false } = {}) {
  const comment = comments.getComment(Number(req.params.id));
  if (!comment) {
    res.status(404).json({ error: 'not found' });
    return null;
  }
  const book = books.getBookById(comment.book_id);
  const isAuthor = req.user.id === comment.user_id;
  const isBookOwner = req.user.role === 'owner' && book && book.owner_id === req.user.id;
  if (!isAuthor && !(ownerMayDelete && isBookOwner)) {
    res.status(403).json({ error: 'not yours' });
    return null;
  }
  return comment;
}

router.patch('/api/comments/:id', requireAuth, (req, res) => {
  const comment = loadEditableComment(req, res);
  if (!comment) return;
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 10000) return res.status(400).json({ error: 'comment body required (max 10000 chars)' });
  // left out = unchanged, so an older client's edit can't drop the flag
  const spoiler = req.body.spoiler === undefined ? !!comment.spoiler : isOn(req.body.spoiler);
  const updated = comments.updateComment(comment.id, body, spoiler);
  const mentions = notifyMentions(updated, books.getBookById(comment.book_id), comment.body);
  res.json({ ok: true, spoiler: !!updated.spoiler, mentions });
});

router.delete('/api/comments/:id', requireAuth, (req, res) => {
  const comment = loadEditableComment(req, res, { ownerMayDelete: true });
  if (!comment) return;
  comments.deleteComment(comment.id);
  res.json({ ok: true });
});

router.post('/api/comments/:id/vote', requireAuth, (req, res) => {
  const comment = comments.getComment(Number(req.params.id));
  if (!comment) return res.status(404).json({ error: 'not found' });
  const book = books.getBookById(comment.book_id);
  if (!canViewBook(book, req.user)) return res.status(404).json({ error: 'not found' });
  const value = Number(req.body.value);
  if (value !== 1 && value !== -1) return res.status(400).json({ error: 'value must be 1 or -1' });
  res.json(comments.vote(comment.id, req.user.id, value));
});

module.exports = router;
