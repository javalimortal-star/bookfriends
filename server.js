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

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Baseline security headers (media routes add a strict CSP of their own)
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.locals.googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  next();
});
// Templates fingerprint static assets as ?v=<content hash>, so production can
// cache them long-term and a deploy still busts the cache (new hash, new URL).
app.locals.assetVersion = crypto.createHash('md5')
  .update(fs.readFileSync(path.join(__dirname, 'public', 'css', 'app.css')))
  .update(fs.readFileSync(path.join(__dirname, 'public', 'js', 'reader.js')))
  .digest('hex').slice(0, 10);
app.use(express.static(path.join(__dirname, 'public'), PROD ? { maxAge: '30d', immutable: true } : {}));

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set (see .env.example)');
}
app.use(session({
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));

app.use(loadUser);

app.use(require('./src/auth/routes'));
app.use(require('./src/auth/google'));
app.use(require('./src/media/routes'));
app.use(require('./src/comments/routes'));
app.use(require('./src/books/routes'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // body-parser sets err.status (e.g. 400 entity.parse.failed); only true unknowns are 500s
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) console.error(err);
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ error: status >= 500 ? 'server error' : 'bad request' });
  }
  res.status(status).render('error', { title: 'Error', message: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`BookFriends listening on http://localhost:${PORT}`);
});
