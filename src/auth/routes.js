const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireOwner, logIn } = require('./middleware');
const { normalizeEmail, normalizeDisplayName, roleFor } = require('../users');
const { loginLimiter, passwordLimiter, registerLimiter } = require('../rate-limit');
const backups = require('../backup');

const router = express.Router();
const BCRYPT_COST = 12;

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth-register', { title: req.t('Register'), error: null });
});

router.post('/register', registerLimiter, (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).render('auth-register', { title: req.t('Register'), error: req.t('Enter a valid email address.') });
  }
  if (password.length < 8) {
    return res.status(400).render('auth-register', { title: req.t('Register'), error: req.t('Password must be at least 8 characters.') });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    return res.status(400).render('auth-register', { title: req.t('Register'), error: req.t('That email is already registered.') });
  }
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(email, hash, roleFor(email), normalizeDisplayName(req.body.display_name), Date.now());
  logIn(req, res, info.lastInsertRowid);
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth-login', { title: req.t('Log in'), error: null });
});

router.post('/login', loginLimiter, (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('auth-login', { title: req.t('Log in'), error: req.t('Wrong email or password.') });
  }
  logIn(req, res, user.id);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

function renderSettings(res, extra = {}) {
  const shareProgress = db.prepare('SELECT share_progress FROM users WHERE id = ?').get(res.locals.user.id).share_progress === 1;
  res.render('settings', {
    title: res.locals.t('Settings'), saved: false, pwSaved: false, pwError: null, privacySaved: false, shareProgress, ...extra,
  });
}

router.get('/settings', requireAuth, (req, res) => {
  renderSettings(res);
});

router.post('/settings', requireAuth, (req, res) => {
  const displayName = normalizeDisplayName(req.body.display_name);
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
  res.locals.user.display_name = displayName;
  renderSettings(res, { saved: true });
});

// Off = your bookmarks no longer show up in friends' shelves and readers.
router.post('/settings/privacy', requireAuth, (req, res) => {
  const share = req.body.share_progress === '1' ? 1 : 0;
  db.prepare('UPDATE users SET share_progress = ? WHERE id = ?').run(share, req.user.id);
  renderSettings(res, { privacySaved: true });
});

router.post('/settings/password', requireAuth, passwordLimiter, (req, res) => {
  if (req.user.auth_provider !== 'local') {
    return res.status(400).render('error', { title: req.t('Not available'), message: req.t('You sign in with Google — there is no password to change.') });
  }
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, row.password_hash)) {
    res.status(400);
    return renderSettings(res, { pwError: req.t('Current password is wrong.') });
  }
  if (next.length < 8) {
    res.status(400);
    return renderSettings(res, { pwError: req.t('New password must be at least 8 characters.') });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, BCRYPT_COST), req.user.id);
  renderSettings(res, { pwSaved: true });
});

// ---------- owner user admin: list users, reset a friend's lost password ----------

function listUsers() {
  return db.prepare('SELECT id, email, display_name, role, auth_provider, created_at FROM users ORDER BY created_at').all();
}

// The page opens with the backups box (views/partials/backup-status.ejs). It
// can hold the backup token and shows temporary passwords: never cache it.
function renderUsers(req, res, { status = 200, resetInfo = null, error = null } = {}) {
  res.set('Cache-Control', 'no-store');
  res.status(status).render('users', { title: req.t('Users'), users: listUsers(), backup: backups.ownerView(req), resetInfo, error });
}

router.get('/users', requireOwner, (req, res) => {
  renderUsers(req, res);
});

router.post('/users/:id/reset-password', requireOwner, (req, res) => {
  const target = db.prepare('SELECT id, email, auth_provider FROM users WHERE id = ?').get(Number(req.params.id));
  // Google accounts can't be locked out (Google is their login) and the owner
  // changes their own password in Settings, so neither is resettable here.
  if (!target || target.auth_provider !== 'local' || target.id === req.user.id) {
    return renderUsers(req, res, { status: 400, error: req.t('That account cannot be reset here.') });
  }
  const temp = crypto.randomBytes(4).toString('hex');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(temp, BCRYPT_COST), target.id);
  renderUsers(req, res, { resetInfo: { email: target.email, temp } });
});

module.exports = router;
