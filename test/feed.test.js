const test = require('node:test');
const assert = require('node:assert');
const { db, addUser } = require('./fresh-db');
const { feedFor, BURST } = require('../src/friends/feed');

const owner = { id: addUser('owner@example.com', 'owner', 'Bento'), role: 'owner' };
const ana = { id: addUser('ana@example.com', 'reader', 'Ana'), role: 'reader' };
const pedro = { id: addUser('pedro@example.com', 'reader', 'Pedro'), role: 'reader' };
const now = Date.now();
const H = 60 * 60 * 1000;

const addBook = db.prepare('INSERT INTO books (owner_id, title, slug, visibility, created_at, published_at) VALUES (?, ?, ?, ?, ?, ?)');
const pub = Number(addBook.run(owner.id, 'Dracula', 'dracula', 'public', now - 90 * 24 * H, now - 3 * H).lastInsertRowid);
const priv = Number(addBook.run(owner.id, 'Secret', 'secret', 'private', now - 2 * H, null).lastInsertRowid);
const chapterIds = {};
const addChapter = db.prepare("INSERT INTO chapters (book_id, idx, title, content_html) VALUES (?, ?, 'c', '<p>x</p>')");
for (const book of [pub, priv]) for (let i = 0; i < 12; i++) chapterIds[`${book}:${i}`] = Number(addChapter.run(book, i).lastInsertRowid);
const comment = db.prepare('INSERT INTO comments (book_id, chapter_id, para_index, user_id, body, created_at, spoiler) VALUES (?, ?, ?, ?, ?, ?, ?)');
const say = (user, book, idx, body, at, { para = null, spoiler = 0 } = {}) => comment.run(book, chapterIds[`${book}:${idx}`], para, user.id, body, at, spoiler);

say(ana, pub, 2, 'first of a burst', now - 5 * H);
say(ana, pub, 2, 'Those wolves gave me chills', now - 4 * H, { para: 7 }); // newest of the burst
say(ana, pub, 2, 'a day earlier: its own item', now - 4 * H - BURST - H);
say(ana, pub, 1, 'the count is a vampire', now - 2 * H, { spoiler: 1 });
say(ana, pub, 9, 'wait until chapter 9', now - 1 * H);
say(pedro, pub, 3, 'my own comment', now - 30 * 60 * 1000);
say(ana, priv, 0, 'on the private book', now - 30 * 60 * 1000);
say(ana, pub, 0, 'too old', now - 40 * 24 * H);
db.prepare('INSERT INTO bookmarks (user_id, book_id, chapter_idx, updated_at) VALUES (?, ?, 5, ?)').run(pedro.id, pub, now);
db.prepare('INSERT INTO book_ratings (user_id, book_id, stars, finished_at, updated_at) VALUES (?, ?, 4, ?, ?)').run(ana.id, pub, now - 6 * H, now - 6 * H);
db.prepare("INSERT INTO book_requests (user_id, title, status, created_at, updated_at) VALUES (?, 'Dune', 'open', ?, ?)").run(ana.id, now - 7 * H, now - 7 * H);

test("a friend sees others' recent activity, newest first, spoiler-safe", () => {
  const items = feedFor(pedro);
  assert.deepStrictEqual(items.map((i) => [i.kind, i.at]), [...items].sort((a, b) => b.at - a.at).map((i) => [i.kind, i.at]));
  const comments = items.filter((i) => i.kind === 'comment');
  assert.ok(!items.some((i) => i.name === 'Pedro'), 'never the viewer');
  assert.ok(!comments.some((i) => i.bookTitle === 'Secret'), 'no private books');
  assert.ok(!comments.some((i) => i.excerpt === 'too old'), 'only the last 30 days');
  const burst = comments.find((i) => i.chapter === 3 && i.count === 2);
  assert.ok(burst, 'two comments within the burst window read as one');
  assert.strictEqual(burst.excerpt, 'Those wolves gave me chills');
  assert.strictEqual(burst.link, '/book/dracula/2?peek=1&panel=7');
  assert.ok(comments.some((i) => i.chapter === 3 && i.count === 1 && i.excerpt === 'a day earlier: its own item'));
  const spoiler = comments.find((i) => i.chapter === 2);
  assert.ok(spoiler.spoiler && spoiler.excerpt === null);
  const ahead = comments.find((i) => i.chapter === 10);
  assert.ok(ahead.ahead && ahead.excerpt === null, 'a chapter past the bookmark hides the text');
  assert.ok(items.some((i) => i.kind === 'finished' && i.stars === 4 && i.name === 'Ana'));
  assert.ok(items.some((i) => i.kind === 'book' && i.bookTitle === 'Dracula'), 'newly published book');
  assert.ok(items.some((i) => i.kind === 'request' && i.bookTitle === 'Dune'));
});

test('the owner sees private books but not their own uploads; logged out sees nothing', () => {
  const items = feedFor(owner);
  assert.ok(items.some((i) => i.kind === 'comment' && i.bookTitle === 'Secret'));
  assert.ok(!items.some((i) => i.kind === 'book'));
  assert.deepStrictEqual(feedFor(null), []);
  assert.strictEqual(feedFor(pedro, { limit: 3 }).length, 3);
});
