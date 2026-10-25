const { db } = require('../db');
const { LANGS } = require('../i18n');
const { listLocal, summarize, healthReport, checkDb, formatSize } = require('./status');
const { setupCommand } = require('./setup');

// Off-site download log + the owner's backup status. Every finished
// /backup/download is one row, so "is the mini PC still copying the backups?"
// has an answer without logging into either machine.

const KEEP_ROWS = 100;

// The owner's avatar dot is on every page they open: recompute at most once
// a minute (a recorded download refreshes it at once).
const attention = { at: 0, value: false };

function recordDownload({ file, size, ip }) {
  db.prepare('INSERT INTO backup_downloads (file_name, size, ip, created_at) VALUES (?, ?, ?, ?)')
    .run(file, size, ip || null, Date.now());
  // one row a night; trim so a misbehaving downloader can't grow it forever
  db.prepare(`DELETE FROM backup_downloads WHERE id <= (
    SELECT id FROM backup_downloads ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(KEEP_ROWS);
  attention.at = 0;
  // one line in the systemd journal too
  console.log(`backup downloaded: ${file} (${(size / 1024 / 1024).toFixed(1)} MB) by ${ip}`);
}

function lastDownload() {
  return db.prepare('SELECT file_name, size, ip, created_at FROM backup_downloads ORDER BY id DESC LIMIT 1').get() || null;
}

function statusWith(last) {
  return summarize({ files: listLocal(), lastDownload: last, tokenSet: !!process.env.BACKUP_TOKEN, now: Date.now() });
}

function currentStatus() {
  return statusWith(lastDownload());
}

function needsAttention() {
  const now = Date.now();
  if (now - attention.at > 60 * 1000) {
    attention.value = currentStatus().level === 'problem';
    attention.at = now;
  }
  return attention.value;
}

// What the owner's /users box shows, formatted in their language. The setup
// command embeds BACKUP_TOKEN, so it exists only when the token is set (and
// the page is owner-only and sent with no-store).
function ownerView(req) {
  const view = currentStatus();
  view.size = (bytes) => formatSize(bytes, LANGS[req.lang].locale);
  const command = setupCommand(`${req.protocol}://${req.get('host')}`, process.env.BACKUP_TOKEN);
  view.setup = command ? { command, site: req.get('host') } : null;
  // anyone who guesses the token downloads every book and comment
  view.tokenWeak = !!process.env.BACKUP_TOKEN && process.env.BACKUP_TOKEN.length < 24;
  return view;
}

// For /healthz: never throws, a broken database turns into ok: false.
function health() {
  let dbOk = checkDb(db);
  let last = null;
  if (dbOk) {
    try {
      last = lastDownload();
    } catch (err) {
      dbOk = false;
      console.error('healthz: database read failed:', err.message);
    }
  } else {
    console.error('healthz: database check (SELECT 1) failed');
  }
  return healthReport(dbOk, statusWith(last));
}

module.exports = { recordDownload, lastDownload, ownerView, needsAttention, health };
