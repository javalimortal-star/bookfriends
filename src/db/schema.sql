CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reader' CHECK (role IN ('owner', 'reader')),
  display_name TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  author TEXT,
  slug TEXT UNIQUE NOT NULL,
  cover_path TEXT,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_books_visibility ON books(visibility);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  content_html TEXT NOT NULL,
  UNIQUE (book_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, idx);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  para_index INTEGER,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  edited INTEGER NOT NULL DEFAULT 0,
  spoiler INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_anchor ON comments(chapter_id, para_index);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  value INTEGER NOT NULL CHECK (value IN (-1, 1)),
  UNIQUE (comment_id, user_id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  chapter_idx INTEGER NOT NULL,
  para_index INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'reply',
  created_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, seen);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

-- Friends ask the owner to upload a book; others add a "me too" vote.
-- book_id links a fulfilled request to the uploaded book.
CREATE TABLE IF NOT EXISTS book_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
  book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_book_requests_status ON book_requests(status);

CREATE TABLE IF NOT EXISTS book_request_votes (
  request_id INTEGER NOT NULL REFERENCES book_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (request_id, user_id)
);

-- One row per finished /backup/download (the off-site copy), so the owner can
-- see whether the nightly download still happens. Trimmed to the newest 100.
CREATE TABLE IF NOT EXISTS backup_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  ip TEXT,
  created_at INTEGER NOT NULL
);
