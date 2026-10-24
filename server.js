require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const { migrate } = require('./src/db/migrate');
const { SqliteStore } = require('./src/db/session-store');
const { loadUser } = require('./src/auth/middleware');

migrate();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';

if (PROD) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Baseline security headers (media routes add a strict CSP of their own).
// Runs before the body parsers: a request they reject (malformed JSON from a
// scanner) jumps straight to the error handler, skipping loadUser, and the
// error page's nav needs `user` to exist or rendering it crashes too.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.locals.user = null;
  res.locals.googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  next();
});
// Uptime probe: before sessions and parsers, a monitor needs neither.
app.use(require('./src/backup/health'));
// Language before the body parsers too: their errors render the error page.
app.use(require('./src/i18n').middleware);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Templates fingerprint static assets as ?v=<content hash>, so production can
// cache them long-term and a deploy still busts the cache (new hash, new URL).
app.locals.assetVersion = crypto.createHash('md5')
  .update(fs.readFileSync(path.join(__dirname, 'public', 'css', 'app.css')))
  .update(fs.readFileSync(path.join(__dirname, 'public', 'js', 'reader.js')))
  .update(fs.readFileSync(path.join(__dirname, 'public', 'js', 'push.js')))
  .digest('hex').slice(0, 10);
// Offline reading + phone notifications (public/sw.js); SW_DISABLED=1 turns it off.
app.locals.swEnabled = process.env.SW_DISABLED !== '1';
// /sw.js before express.static: it needs no-cache, never the 30-day caching
app.use(require('./src/offline/routes'));
app.use(express.static(path.join(__dirname, 'public'), PROD ? { maxAge: '30d', immutable: true } : {}));

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set (see .env.example)');
}
app.use(session({
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // each visit extends the 30 days, so regular readers never get logged out
  // (a lapsed login also logged their phone notifications out)
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

app.use(loadUser);
app.use(require('./src/i18n').rememberUserLang);
// Unread-reply count for the nav bell on every rendered page.
const notifications = require('./src/comments/notifications');
app.use((req, res, next) => {
  res.locals.unseenNotifs = req.user ? notifications.unseenCount(req.user.id) : 0;
  next();
});
// Open book requests: a count on the owner's "Book requests" menu item.
const bookRequests = require('./src/requests/service');
app.use((req, res, next) => {
  res.locals.openRequests = req.user && req.user.role === 'owner' ? bookRequests.openCount() : 0;
  next();
});
// Owner only: a warning dot on the avatar when the backups are in trouble.
const backups = require('./src/backup');
app.use((req, res, next) => {
  res.locals.backupAlert = !!(req.user && req.user.role === 'owner') && backups.needsAttention();
  next();
});

app.use(require('./src/i18n/routes'));
app.use(require('./src/auth/routes'));
app.use(require('./src/auth/google'));
app.use(require('./src/backup/routes'));
app.use(require('./src/media/routes'));
app.use(require('./src/comments/routes'));
app.use(require('./src/requests/routes'));
app.use(require('./src/push/routes'));
app.use(require('./src/books/routes'));

app.use((req, res) => {
  res.status(404).render('error', { title: req.t('Not found'), message: req.t('Page not found.') });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // body-parser sets err.status (e.g. 400 entity.parse.failed); only true unknowns are 500s
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: status >= 500 ? 'server error' : 'bad request' });
  }
  res.status(status).render('error', { title: req.t('Error'), message: req.t('Something went wrong.') });
});

app.listen(PORT, () => {
  console.log(`BookFriends listening on http://localhost:${PORT}`);
  // Index books uploaded before search existed, in small background batches
  // (src/books/search.js), once the server is already answering requests.
  require('./src/books/search').startBackfill();
});
