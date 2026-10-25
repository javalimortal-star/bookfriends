const test = require('node:test');
const assert = require('node:assert');
const { db, addUser } = require('./fresh-db');
const friends = require('../src/friends/service');

const owner = { id: addUser('owner@example.com', 'owner'), role: 'owner' };
const ana = { id: addUser('ana@example.com', 'reader', 'Ana'), role: 'reader' };
const pedro = { id: addUser('pedro@example.com', 'reader', 'Pedro'), role: 'reader' };
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

test('avatar colour and initial come from the name', () => {
  const { avatarTone, initialOf } = require('../src/users');
  assert.strictEqual(avatarTone('A'), 65 % 5);
  assert.strictEqual(avatarTone('Ana'), 2); // 65 % 5 = 0, (0 + 110) % 5 = 0, (0 + 97) % 5 = 2
  for (const name of ['Ana', 'Pedro', 'javalimortal', 'Zoë']) assert.ok(avatarTone(name) >= 0 && avatarTone(name) <= 4);
  assert.strictEqual(initialOf('ana'), 'A');
  assert.strictEqual(initialOf('😀 Joy'), '😀'); // a whole emoji, not half of one
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
