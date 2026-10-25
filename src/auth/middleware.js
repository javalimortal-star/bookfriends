const { db } = require('../db');

const userStmt = () => db.prepare('SELECT id, email, role, display_name, auth_provider, lang FROM users WHERE id = ?');

function loadUser(req, res, next) {
  req.user = res.locals.user = (req.session && req.session.userId && userStmt().get(req.session.userId)) || null;
  next();
}

// A fresh session id on every login (no session fixation).
function logIn(req, res, userId) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { title: req.t('Error'), message: req.t('Session error.') });
    req.session.userId = userId;
    res.redirect('/');
  });
}

function wantsJson(req) {
  return req.path.startsWith('/api/') || req.get('accept') === 'application/json';
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'login required' });
  return res.redirect('/login');
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  if (wantsJson(req)) return res.status(403).json({ error: 'owner only' });
  return res.status(403).render('error', { title: req.t('Forbidden'), message: req.t('Only the site owner can do that.') });
}

// Visibility rule: public books are readable by anyone (login not required);
// private books exist only for the owner. Unauthorized access reads as 404,
// never 403, so private books' existence is not disclosed.
function canViewBook(book, user) {
  if (!book) return false;
  if (book.visibility === 'public') return true;
  return !!(user && user.role === 'owner');
}

function bookNotFound(req, res) {
  res.status(404).render('error', { title: req.t('Not found'), message: req.t('No such book.') });
}

// The book if this request may see it; otherwise answers 404 and returns null.
function viewableBook(req, res, book) {
  if (canViewBook(book, req.user)) return book;
  bookNotFound(req, res);
  return null;
}

module.exports = { loadUser, logIn, requireAuth, requireOwner, canViewBook, bookNotFound, viewableBook };
