// A throwaway migrated database for a test file: require it before src/.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-test-'));
process.env.DATA_DIR = dir;
const { db } = require('../src/db');
require('../src/db/migrate').migrate();

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const insertUser = db.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, 'x', ?, ?, 0)");
const addUser = (email, role = 'reader', displayName = null) => Number(insertUser.run(email, role, displayName).lastInsertRowid);

module.exports = { db, dir, addUser };
