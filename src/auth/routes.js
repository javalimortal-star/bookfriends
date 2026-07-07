const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth, requireOwner } = require('./middleware');

const router = express.Router();
const BCRYPT_COST = 12;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Optional nickname shown on comments; empty means "fall back to email prefix".
function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30) || null;
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth-register', { title: 'Register', error: null });
});

router.post('/register', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).render('auth-register', { title: 'Register', error: 'Enter a valid email address.' });
  }
  if (password.length < 8) {
    return res.status(400).render('auth-register', { title: 'Register', error: 'Password must be at least 8 characters.' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) {
    return res.status(400).render('auth-register', { title: 'Register', error: 'That email is already registered.' });
  }
  const ownerEmail = normalizeEmail(process.env.OWNER_EMAIL);
  const role = email === ownerEmail ? 'owner' : 'reader';
  const hash = bcrypt.hashSync(password, BCRYPT_COST);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(email, hash, role, normalizeDisplayName(req.body.display_name), Date.now());
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { title: 'Error', message: 'Session error.' });
    req.session.userId = info.lastInsertRowid;
    res.redirect('/');
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth-login', { title: 'Log in', error: null });
});

router.post('/login', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('auth-login', { title: 'Log in', error: 'Wrong email or password.' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('error', { title: 'Error', message: 'Session error.' });
    req.session.userId = user.id;
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

function renderSettings(res, extra = {}) {
  res.render('settings', {
    title: 'Settings', saved: false, pwSaved: false, pwError: null, ...extra,
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

router.post('/settings/password', requireAuth, (req, res) => {
  if (req.user.auth_provider !== 'local') {
    return res.status(400).render('error', { title: 'Not available', message: 'You sign in with Google — there is no password to change.' });
  }
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current, row.password_hash)) {
    res.status(400);
    return renderSettings(res, { pwError: 'Current password is wrong.' });
  }
  if (next.length < 8) {
    res.status(400);
    return renderSettings(res, { pwError: 'New password must be at least 8 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, BCRYPT_COST), req.user.id);
  renderSettings(res, { pwSaved: true });
});

// ---------- owner user admin: list users, reset a friend's lost password ----------

function listUsers() {
  return db.prepare('SELECT id, email, display_name, role, auth_provider, created_at FROM users ORDER BY created_at').all();
}

router.get('/users', requireOwner, (req, res) => {
  res.render('users', { title: 'Users', users: listUsers(), resetInfo: null, error: null });
});

router.post('/users/:id/reset-password', requireOwner, (req, res) => {
  const target = db.prepare('SELECT id, email, auth_provider FROM users WHERE id = ?').get(Number(req.params.id));
  // Google accounts can't be locked out (Google is their login) and the owner
  // changes their own password in Settings, so neither is resettable here.
  if (!target || target.auth_provider !== 'local' || target.id === req.user.id) {
    return res.status(400).render('users', { title: 'Users', users: listUsers(), resetInfo: null, error: 'That account cannot be reset here.' });
  }
  const temp = crypto.randomBytes(4).toString('hex');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(temp, BCRYPT_COST), target.id);
  res.render('users', { title: 'Users', users: listUsers(), resetInfo: { email: target.email, temp }, error: null });
});

module.exports = router;
