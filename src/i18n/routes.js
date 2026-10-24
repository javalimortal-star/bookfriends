const express = require('express');
const { LANGS, COOKIE } = require('./index');

const router = express.Router();
const PROD = process.env.NODE_ENV === 'production';

// The footer's language links: remember the choice for a year, then go back
// to the page the link was clicked on (same-site paths only).
router.get('/lang/:code', (req, res) => {
  const code = LANGS[req.params.code] ? req.params.code : 'en';
  res.cookie(COOKIE, code, { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: true, secure: PROD });
  const next = typeof req.query.next === 'string' && /^\/(?![/\\])/.test(req.query.next) ? req.query.next : '/';
  res.redirect(next);
});

module.exports = router;
