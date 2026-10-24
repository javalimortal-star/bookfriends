const fs = require('fs');
const path = require('path');
const { db } = require('./index');

// Additive column migration for databases created before the column existed
// (CREATE TABLE IF NOT EXISTS does not alter existing tables).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  ensureColumn('users', 'display_name', 'display_name TEXT');
  ensureColumn('users', 'auth_provider', "auth_provider TEXT NOT NULL DEFAULT 'local'");
  ensureColumn('bookmarks', 'para_index', 'para_index INTEGER');
  ensureColumn('comments', 'spoiler', 'spoiler INTEGER NOT NULL DEFAULT 0');
  ensureColumn('notifications', 'kind', "kind TEXT NOT NULL DEFAULT 'reply'");
  // last language the user browsed in, so push notifications can use it
  ensureColumn('users', 'lang', 'lang TEXT');
}

module.exports = { migrate };
