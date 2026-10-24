const { rateLimit } = require('express-rate-limit');

// Per-IP limits on the endpoints an anonymous internet can abuse. In
// production `trust proxy` is 1 (server.js), so req.ip is the real client
// address behind Caddy, not the proxy's.
// `message` gets the request's translator, so the text is in the reader's language.
function tooMany(message) {
  return (req, res) => {
    const text = message(req.t);
    if (req.path.startsWith('/api/')) return res.status(429).json({ error: text });
    res.status(429).render('error', { title: req.t('Slow down'), message: text });
  };
}

function makeLimiter({ windowMs, limit, onlyFailures = false, message }) {
  return rateLimit({
    windowMs,
    limit,
    // Don't punish normal use: with onlyFailures a request that succeeds
    // (status < 400) is refunded, so only wrong passwords eat the budget.
    skipSuccessfulRequests: onlyFailures,
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany(message),
  });
}

module.exports = {
  loginLimiter: makeLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    onlyFailures: true,
    message: (t) => t('Too many login attempts. Wait 15 minutes and try again.'),
  }),
  passwordLimiter: makeLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    onlyFailures: true,
    message: (t) => t('Too many password attempts. Wait 15 minutes and try again.'),
  }),
  registerLimiter: makeLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    message: (t) => t('Too many new accounts from your network. Try again in an hour.'),
  }),
  commentLimiter: makeLimiter({
    windowMs: 5 * 60 * 1000,
    limit: 20,
    message: (t) => t('You are commenting too fast. Wait a few minutes and try again.'),
  }),
  bookRequestLimiter: makeLimiter({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    message: (t) => t('That is a lot of book requests at once. Try again in an hour.'),
  }),
  // Search inside a book is open to anyone on public books; one search is
  // cheap, a script firing thousands is not on the small VM.
  searchLimiter: makeLimiter({
    windowMs: 60 * 1000,
    limit: 30,
    message: (t) => t('Too many searches. Wait a minute and try again.'),
  }),
};
