const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(path.resolve(process.env.DATA_DIR || './data'), '..', 'backups');
const NAME_RE = /^bookfriends-\d{4}-\d{2}-\d{2}\.tar\.gz$/;

// Constant-time token check that is also false when BACKUP_TOKEN is unset.
// Hashing first sidesteps timingSafeEqual's equal-length requirement.
function tokenOk(given) {
  const expected = process.env.BACKUP_TOKEN || '';
  if (!expected || typeof given !== 'string') return false;
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(given).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );
}

// Serves the newest archive produced by scripts/backup.js so an off-site
// machine can fetch it nightly. The token lives only in the server .env and
// the downloader's script; a wrong token gets the same 404 as a random URL.
router.get('/backup/download', (req, res) => {
  if (!tokenOk(req.query.token)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
  }
  const latest = fs.existsSync(BACKUP_DIR)
    ? fs.readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)).sort().pop()
    : undefined;
  if (!latest) return res.status(503).json({ error: 'no backup available yet' });
  res.download(path.join(BACKUP_DIR, latest), latest);
});

module.exports = router;
