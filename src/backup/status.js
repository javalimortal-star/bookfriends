const fs = require('fs');
const path = require('path');

// How fresh the backups are, for the owner's /users box and /healthz.
// Pure functions plus a directory listing; nothing here touches the database,
// so the tests can load it without a DATA_DIR.

// scripts/backup.js writes here (default: a sibling of DATA_DIR)
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(path.resolve(process.env.DATA_DIR || './data'), '..', 'backups');
const NAME_RE = /^bookfriends-\d{4}-\d{2}-\d{2}\.tar\.gz$/;

const HOUR = 60 * 60 * 1000;
// Both jobs run nightly, so a healthy copy is under ~24h old. 36h tolerates
// one late or missed night before warning; 72h means several nights are gone.
const WARN_AFTER = 36 * HOUR;
const PROBLEM_AFTER = 72 * HOUR;

function ageLevel(ageMs) {
  if (ageMs < WARN_AFTER) return 'ok';
  if (ageMs <= PROBLEM_AFTER) return 'warning';
  return 'problem';
}

// Archives made by scripts/backup.js, newest first (the date is in the name).
function listLocal(dir = BACKUP_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => NAME_RE.test(f));
  } catch {
    return []; // no backups folder yet (local dev) or unreadable
  }
  return names.sort().reverse().flatMap((name) => {
    try {
      const st = fs.statSync(path.join(dir, name));
      return [{ name, size: st.size, mtime: st.mtimeMs }];
    } catch {
      return []; // deleted by the nightly rotation between the two calls
    }
  });
}

const RANK = { ok: 0, warning: 1, disabled: 1, problem: 2, missing: 2, never: 2 };

// files: listLocal() output; lastDownload: newest backup_downloads row or null.
// level: 'ok' | 'warning' | 'problem', or 'none' when this server has no
// backups and no off-site download configured (a dev machine).
function summarize({ files, lastDownload, tokenSet, now }) {
  const newest = files[0] || null;
  const local = {
    level: newest ? ageLevel(now - newest.mtime) : 'missing',
    newest,
    count: files.length,
  };
  let offsiteLevel;
  if (!tokenSet) offsiteLevel = 'disabled';
  else if (!lastDownload) offsiteLevel = 'never';
  else offsiteLevel = ageLevel(now - lastDownload.created_at);
  const offsite = { level: offsiteLevel, last: lastDownload || null };

  let level;
  if (local.level === 'missing' && offsiteLevel === 'disabled') level = 'none';
  else level = ['ok', 'warning', 'problem'][Math.max(RANK[local.level], RANK[offsiteLevel])];
  return { level, local, offsite };
}

// The public /healthz view: coarse states only (the repo and site are public,
// so no file names, sizes, times or IPs).
function healthReport(dbOk, summary) {
  const stale = (level) => (level === 'warning' || level === 'problem' ? 'stale' : level);
  const body = {
    ok: dbOk,
    db: dbOk ? 'ok' : 'error',
    backups: stale(summary.local.level),
    // without the database we can't know when the last download happened
    offsite: dbOk ? stale(summary.offsite.level) : 'unknown',
  };
  return { status: dbOk ? 200 : 503, body };
}

function checkDb(database) {
  try {
    database.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

// "203.4 MB" with the reader's decimal separator.
function formatSize(bytes, locale) {
  const num = (n, digits) => n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes < 1024 * 1024) return `${num(Math.max(1, Math.round(bytes / 1024)), 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${num(bytes / 1024 / 1024, 1)} MB`;
  return `${num(bytes / 1024 / 1024 / 1024, 2)} GB`;
}

module.exports = {
  BACKUP_DIR, NAME_RE, WARN_AFTER, PROBLEM_AFTER,
  ageLevel, listLocal, summarize, healthReport, checkDb, formatSize,
};
