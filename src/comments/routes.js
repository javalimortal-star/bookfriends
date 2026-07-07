const express = require('express');
const { requireAuth, canViewBook } = require('../auth/middleware');
const comments = require('./service');
const notifications = require('./notifications');
const books = require('../books/service');

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

router.post('/api/chapter/:chapterId/comments', requireAuth, (req, res) => {
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
  });
  if (parentAuthorId !== null && parentAuthorId !== req.user.id) {
    notifications.notifyReply(parentAuthorId, created.id);
  }
  res.status(201).json({ id: created.id });
});

function relTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString('en-GB');
}

router.get('/notifications', requireAuth, (req, res) => {
  const items = notifications.listForUser(req.user.id).map((n) => {
    const base = `/book/${n.book_slug}/${n.chapter_idx}?peek=1`;
    return Object.assign(n, {
      link: n.para_index === null ? `${base}#comments` : `${base}&panel=${n.para_index}`,
      replierName: n.replier_name || n.replier_email.split('@')[0],
      excerpt: n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body,
      when: relTime(n.created_at),
    });
  });
  notifications.markAllSeen(req.user.id);
  res.locals.unseenNotifs = 0; // the bell clears as this page renders
  res.render('notifications', { title: 'Notifications', items });
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
  comments.updateComment(comment.id, body);
  res.json({ ok: true });
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
