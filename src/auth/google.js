const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();

// "Continue with Google" via the plain OAuth 2.0 authorization-code flow —
// enabled only when both env vars are set; the UI hides the button otherwise.
function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// Must exactly match an Authorized redirect URI in the Google Cloud console.
function redirectUri(req) {
  return `${req.protocol}://${req.get('host')}/auth/google/callback`;
}

function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 30) || null;
}

router.get('/auth/google', (req, res) => {
  if (!configured()) return res.status(404).render('error', { title: 'Not found', message: 'Google login is not enabled.' });
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

router.get('/auth/google/callback', async (req, res) => {
  if (!configured()) return res.status(404).render('error', { title: 'Not found', message: 'Google login is not enabled.' });
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) throw new Error('OAuth state mismatch');
    delete req.session.oauthState;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error || 'token exchange failed');

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.email) throw new Error('userinfo failed');
    if (info.email_verified === false) throw new Error('Google email not verified');

    const email = String(info.email).trim().toLowerCase();
    let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!user) {
      const ownerEmail = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
      const role = email === ownerEmail ? 'owner' : 'reader';
      // Not a bcrypt hash, so password login can never match for this account.
      const unusablePassword = `google:${crypto.randomBytes(32).toString('hex')}`;
      const inserted = db.prepare(
        'INSERT INTO users (email, password_hash, role, display_name, auth_provider, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(email, unusablePassword, role, normalizeDisplayName(info.name), 'google', Date.now());
      user = { id: inserted.lastInsertRowid };
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).render('error', { title: 'Error', message: 'Session error.' });
      req.session.userId = user.id;
      res.redirect('/');
    });
  } catch (err) {
    console.error('google auth:', err.message);
    res.status(400).render('error', { title: 'Login failed', message: 'Google sign-in did not complete. Try again, or log in with email and password.' });
  }
});

module.exports = router;
