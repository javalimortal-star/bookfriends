const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bookfriends.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = { db, DATA_DIR };
