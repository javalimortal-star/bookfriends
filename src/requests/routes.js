const express = require('express');
const { requireAuth, requireOwner, canViewBook } = require('../auth/middleware');
const { bookRequestLimiter } = require('../rate-limit');
const books = require('../books/service');
const { displayName } = require('../users');
const requests = require('./service');

const router = express.Router();

function renderPage(req, res, { form = {}, error = null } = {}) {
  const isOwner = req.user.role === 'owner';
  // Newest first: a book just uploaded for a request is at the top.
  const shelf = isOwner ? books.getShelf(req.user, 'added') : [];
  const open = requests.listOpen(req.user.id).map((r) => Object.assign(r, {
    wanters: r.votes + 1, // the asker wants it too
    suggestedBookId: isOwner ? (requests.suggestBook(r.title, shelf) || {}).id : null,
  }));
  const finished = requests.listFinished(req.user.id).map((r) => Object.assign(r, {
    // a request may point at a book this viewer can't open (private)
    bookLink: r.book_slug && canViewBook({ visibility: r.book_visibility }, req.user) ? `/book/${r.book_slug}/0` : null,
  }));
  res.render('requests', {
    title: req.t('Book requests'),
    open,
    finished,
    shelf,
    isOwner,
    form,
    error,
    sent: req.query.sent === '1',
  });
}

function loadRequest(req, res) {
  const request = requests.getRequest(Number(req.params.id));
  if (!request) {
    res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book request.') });
    return null;
  }
  return request;
}

router.get('/requests', requireAuth, (req, res) => {
  renderPage(req, res);
});

router.post('/requests', requireAuth, bookRequestLimiter, (req, res) => {
  const { values, error } = requests.validate(req.body, req.t);
  if (error) {
    res.status(400);
    return renderPage(req, res, { form: values, error });
  }
  const duplicate = requests.findOpenDuplicate(values.title);
  if (duplicate) {
    res.status(400);
    return renderPage(req, res, {
      form: values,
      error: req.t('Someone already asked for “{title}”. Tap “Me too” on it instead.', { title: duplicate.title }),
    });
  }
  const request = requests.createRequest(req.user.id, values);
  requests.notifyCreated(request, displayName(req.user));
  res.redirect('/requests?sent=1');
});

// "Me too" on someone else's open request; a second tap takes it back.
router.post('/requests/:id/vote', requireAuth, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  if (request.status === 'open' && request.user_id !== req.user.id) requests.toggleVote(request.id, req.user.id);
  res.redirect(`/requests#req-${request.id}`);
});

router.post('/requests/:id/done', requireOwner, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  let book = null;
  if (req.body.book_id) {
    book = books.getBookById(Number(req.body.book_id));
    if (!book) return res.status(400).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
    // friends can't open a private book: the "it's here" notification would
    // reveal its title and link to a "not found" page
    if (book.visibility !== 'public') {
      return renderPage(req, res, { error: req.t('“{title}” is still private. Make it public on the shelf first, then mark the request as uploaded.', { title: book.title }) });
    }
  }
  if (request.status !== 'open') return res.redirect('/requests');
  requests.setStatus(request.id, 'done', book ? book.id : null);
  requests.notifyDone(request, book, req.user.id);
  res.redirect('/requests');
});

router.post('/requests/:id/decline', requireOwner, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  if (request.status === 'open') requests.setStatus(request.id, 'declined');
  res.redirect('/requests');
});

// The owner deletes any request; the asker only their own open one.
router.post('/requests/:id/delete', requireAuth, (req, res) => {
  const request = loadRequest(req, res);
  if (!request) return;
  const mine = request.user_id === req.user.id && request.status === 'open';
  if (req.user.role !== 'owner' && !mine) {
    return res.status(403).render('error', { title: req.t('Forbidden'), message: req.t('You can only delete your own open requests.') });
  }
  requests.deleteRequest(request.id);
  res.redirect('/requests');
});

module.exports = router;
