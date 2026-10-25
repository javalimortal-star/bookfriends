const { rateLimit } = require('express-rate-limit');

// Per-IP limits on what an anonymous internet can abuse (behind Caddy,
// `trust proxy` makes req.ip the real client). `message` gets the request's
// translator, so the answer is in the reader's language.
function limiter(minutes, limit, message, { onlyFailures = false } = {}) {
  return rateLimit({
    windowMs: minutes * 60 * 1000,
    limit,
    // onlyFailures refunds successful requests: only wrong passwords/tokens count
    skipSuccessfulRequests: onlyFailures,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const text = message(req.t);
      if (req.path.startsWith('/api/')) return res.status(429).json({ error: text });
      res.status(429).render('error', { title: req.t('Slow down'), message: text });
    },
  });
}

const failures = { onlyFailures: true };

module.exports = {
  loginLimiter: limiter(15, 10, (t) => t('Too many login attempts. Wait 15 minutes and try again.'), failures),
  passwordLimiter: limiter(15, 10, (t) => t('Too many password attempts. Wait 15 minutes and try again.'), failures),
  registerLimiter: limiter(60, 5, (t) => t('Too many new accounts from your network. Try again in an hour.')),
  commentLimiter: limiter(5, 20, (t) => t('You are commenting too fast. Wait a few minutes and try again.')),
  bookRequestLimiter: limiter(60, 10, (t) => t('That is a lot of book requests at once. Try again in an hour.')),
  // search is open to anyone on public books: cheap once, not thousands of times
  searchLimiter: limiter(1, 30, (t) => t('Too many searches. Wait a minute and try again.')),
  backupLimiter: limiter(60, 10, (t) => t('Too many attempts. Try again in an hour.'), failures),
  // each test makes the server call out to the push services
  pushTestLimiter: limiter(10, 10, (t) => t('Too many test notifications. Wait a few minutes and try again.')),
};
