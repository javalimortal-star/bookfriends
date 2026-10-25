#!/usr/bin/env node
// Nightly backup (cron, see README "Backups"): a WAL-safe snapshot of the DB
// plus the book files in backups/bookfriends-YYYY-MM-DD.tar.gz; keeps 7.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const { BACKUP_DIR, NAME_RE } = require('../src/backup/status');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const KEEP = 7;

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
    // the push key pair: without it a restore would silently cut off every
    // device that turned on phone notifications
    if (fs.existsSync(path.join(DATA_DIR, 'vapid.json'))) args.push('-C', DATA_DIR, 'vapid.json');
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
