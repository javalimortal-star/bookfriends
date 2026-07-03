const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();
const BCRYPT_COST = 12;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
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
    'INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
  ).run(email, hash, role, Date.now());
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

module.exports = router;
