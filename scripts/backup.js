#!/usr/bin/env node
// Nightly backup: snapshot the SQLite DB with better-sqlite3's backup API
// (raw-copying a live WAL database can capture a torn state), bundle it with
// the extracted book media into backups/bookfriends-YYYY-MM-DD.tar.gz, and
// keep the newest 7 archives. Run from the repo root, e.g. via cron:
//   30 3 * * * cd /home/ubuntu/bookfriends && /usr/bin/node scripts/backup.js
// Restore = extract the archive into a fresh DATA_DIR:
//   tar -xzf bookfriends-YYYY-MM-DD.tar.gz -C data
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const BACKUP_DIR = process.env.BACKUP_DIR
  ? path.resolve(process.env.BACKUP_DIR)
  : path.join(DATA_DIR, '..', 'backups');
const KEEP = 7;
const NAME_RE = /^bookfriends-\d{4}-\d{2}-\d{2}\.tar\.gz$/;

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const out = path.join(BACKUP_DIR, `bookfriends-${new Date().toISOString().slice(0, 10)}.tar.gz`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookfriends-backup-'));
  try {
    const db = new Database(path.join(DATA_DIR, 'bookfriends.db'), { readonly: true });
    try {
      await db.backup(path.join(tmp, 'bookfriends.db'));
    } finally {
      db.close();
    }
    // Write to .part first so the download route never serves a half-written
    // archive, then rename into place (atomic on the same filesystem).
    const args = ['-czf', `${out}.part`, '-C', tmp, 'bookfriends.db'];
    if (fs.existsSync(path.join(DATA_DIR, 'books'))) args.push('-C', DATA_DIR, 'books');
    execFileSync('tar', args);
    fs.renameSync(`${out}.part`, out);

    const stale = fs.readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f)).sort().reverse().slice(KEEP);
    for (const f of stale) fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`backup written: ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('backup failed:', err);
  process.exit(1);
});
