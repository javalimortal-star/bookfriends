const { db } = require('../db');

const userStmt = () => db.prepare('SELECT id, email, role, display_name, auth_provider FROM users WHERE id = ?');

function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session && req.session.userId) {
    res.locals.user = userStmt().get(req.session.userId) || null;
  }
  req.user = res.locals.user;
  next();
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
  return res.status(403).render('error', { title: 'Forbidden', message: 'Only the site owner can do that.' });
}

// Visibility rule: public books are readable by anyone (login not required);
// private books exist only for the owner. Unauthorized access reads as 404,
// never 403, so private books' existence is not disclosed.
function canViewBook(book, user) {
  if (!book) return false;
  if (book.visibility === 'public') return true;
  return !!(user && user.role === 'owner');
}

module.exports = { loadUser, requireAuth, requireOwner, canViewBook };
