const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { BACKUP_DIR, listLocal } = require('./status');
const backups = require('./index');
const { backupLimiter } = require('../rate-limit');

const router = express.Router();

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
router.get('/backup/download', backupLimiter, (req, res, next) => {
  if (!tokenOk(req.query.token)) {
    return res.status(404).render('error', { title: req.t('Not found'), message: req.t('Page not found.') });
  }
  const latest = listLocal()[0];
  if (!latest) return res.status(503).json({ error: 'no backup available yet' });
  res.download(path.join(BACKUP_DIR, latest.name), latest.name, (err) => {
    // With a callback, errors are ours to answer (a dropped connection has
    // already sent its headers: nothing left to do).
    if (err) {
      if (!res.headersSent) next(err);
      return;
    }
    // Only a whole file counts as an off-site copy: not HEAD, a byte range
    // or a 304 revalidation.
    if (req.method !== 'GET' || res.statusCode !== 200) return;
    // outside Express's error handling here: a throw would crash the server
    try {
      backups.recordDownload({ file: latest.name, size: latest.size, ip: req.ip });
    } catch (e) {
      console.error('backup download not recorded:', e.message);
    }
  });
});

module.exports = router;
