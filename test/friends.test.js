const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway database: src/db opens DATA_DIR on require.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-friends-'));
process.env.DATA_DIR = dir;
const { db } = require('../src/db');
require('../src/db/migrate').migrate();
const friends = require('../src/friends/service');

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const addUser = db.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, 'x', ?, ?, 0)");
const owner = { id: Number(addUser.run('owner@example.com', 'owner', null).lastInsertRowid), role: 'owner' };
const ana = { id: Number(addUser.run('ana@example.com', 'reader', 'Ana').lastInsertRowid), role: 'reader' };
const pedro = { id: Number(addUser.run('pedro@example.com', 'reader', 'Pedro').lastInsertRowid), role: 'reader' };
const addBook = db.prepare("INSERT INTO books (owner_id, title, slug, visibility, created_at) VALUES (?, ?, ?, ?, 0)");
const pub = Number(addBook.run(owner.id, 'Public', 'public', 'public').lastInsertRowid);
const priv = Number(addBook.run(owner.id, 'Private', 'private', 'private').lastInsertRowid);
const addChapter = db.prepare("INSERT INTO chapters (book_id, idx, title, content_html) VALUES (?, ?, 'c', '<p>x</p>')");
for (let i = 0; i < 12; i++) addChapter.run(pub, i);
for (let i = 0; i < 3; i++) addChapter.run(priv, i);
const mark = db.prepare('INSERT INTO bookmarks (user_id, book_id, chapter_idx, updated_at) VALUES (?, ?, ?, ?)');
mark.run(ana.id, pub, 10, 3000);
mark.run(pedro.id, pub, 5, 2000);
mark.run(owner.id, pub, 7, 1000);
mark.run(ana.id, priv, 2, 4000); // from when it was public

test('avatarTone matches the comment avatars in reader.js', () => {
  // reader.js: tone = (tone * 31 + charCode) % 5 over the name
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reader.js'), 'utf8');
  assert.match(src, /tone = \(tone \* 31 \+ \w+\.charCodeAt\(i\)\) % 5/);
  assert.strictEqual(friends.avatarTone('A'), 65 % 5);
  assert.strictEqual(friends.avatarTone('Ana'), 2); // 65 % 5 = 0, (0 + 110) % 5 = 0, (0 + 97) % 5 = 2
  for (const name of ['Ana', 'Pedro', 'javalimortal', 'Zoë']) {
    const tone = friends.avatarTone(name);
    assert.ok(tone >= 0 && tone <= 4);
  }
});

test('a reader sees the other readers on public books, newest first, never themself', () => {
  const list = friends.friendsProgress(pedro);
  assert.deepStrictEqual(list.map((f) => [f.name, f.bookId, f.chapter]), [['Ana', pub, 11], ['owner', pub, 8]]);
  assert.strictEqual(list[0].total, 12);
  assert.strictEqual(list[0].initial, 'A');
});

test('the owner also sees bookmarks on private books', () => {
  const list = friends.friendsProgress(owner);
  assert.deepStrictEqual(list.map((f) => [f.name, f.bookId]), [['Ana', priv], ['Ana', pub], ['Pedro', pub]]);
});

test('bookId narrows the list to one book; logged-out viewers get nothing', () => {
  assert.deepStrictEqual(friends.friendsProgress(owner, { bookId: priv }).map((f) => f.name), ['Ana']);
  assert.deepStrictEqual(friends.friendsProgress(null), []);
});

test('share_progress = 0 hides a user everywhere', () => {
  db.prepare('UPDATE users SET share_progress = 0 WHERE id = ?').run(ana.id);
  try {
    assert.deepStrictEqual(friends.friendsProgress(owner).map((f) => f.name), ['Pedro']);
    assert.deepStrictEqual(friends.friendsProgress(pedro).map((f) => f.name), ['owner']);
  } finally {
    db.prepare('UPDATE users SET share_progress = 1 WHERE id = ?').run(ana.id);
  }
});

test('groupByBook keeps the newest-first order per book', () => {
  const byBook = friends.groupByBook(friends.friendsProgress(owner));
  assert.deepStrictEqual(byBook.get(pub).map((f) => f.name), ['Ana', 'Pedro']);
  assert.strictEqual(byBook.get(999), undefined);
});

test('closestFriend picks the nearest chapter, the most recent on a tie', () => {
  const list = [{ name: 'Ana', chapterIdx: 10 }, { name: 'Pedro', chapterIdx: 4 }, { name: 'Bia', chapterIdx: 8 }];
  assert.strictEqual(friends.closestFriend(6, list).name, 'Pedro'); // 2 behind vs Bia 2 ahead: Pedro is newer
  assert.strictEqual(friends.closestFriend(9, list).name, 'Ana');
  assert.strictEqual(friends.closestFriend(8, list).name, 'Bia');
  assert.strictEqual(friends.closestFriend(3, []), null);
  assert.strictEqual(friends.closestFriend(3, undefined), null);
});
