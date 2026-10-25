const test = require('node:test');
const assert = require('node:assert');
const { db, addUser } = require('./fresh-db');
const search = require('../src/books/search');

const owner = addUser('o@x', 'owner');
function addBook(slug, chapters) {
  const id = db.prepare("INSERT INTO books (owner_id, title, slug, visibility, created_at) VALUES (?, ?, ?, 'public', 0)").run(owner, slug, slug).lastInsertRowid;
  const insert = db.prepare('INSERT INTO chapters (book_id, idx, title, content_html) VALUES (?, ?, ?, ?)');
  chapters.forEach((paras, idx) => {
    insert.run(id, idx, `Chapter ${idx + 1}`, paras.map((text, p) => `<p data-p="${p}">${text}</p>`).join(''));
  });
  return Number(id);
}
// The background indexer works in setImmediate steps; wait for it.
async function settle() {
  for (let i = 0; i < 200; i++) {
    const busy = db.prepare('SELECT (SELECT COUNT(*) FROM search_progress WHERE done = 0) + (SELECT COUNT(*) FROM search_purge) AS n').get().n;
    if (!busy) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('indexing did not finish');
}

const a = addBook('a', [['Alyosha met Ivan.', 'Smerdyakov listened.'], ['Ivan Karamázov returned.'], ['', '<img src="x.png">']]);
const b = addBook('b', [['Ivan in another book.']]);

test('backfill indexes every book; results stay inside their book, in reading order', async () => {
  assert.deepStrictEqual(search.indexStatus(a), { ready: false, percent: 0 });
  search.startBackfill();
  await settle();
  assert.strictEqual(search.indexStatus(a).ready, true);
  const result = search.searchBook(a, 'ivan');
  assert.strictEqual(result.total, 2);
  assert.deepStrictEqual(result.groups.map((g) => [g.chapterIdx, g.title, g.matches.map((m) => m.para)]), [
    [0, 'Chapter 1', [0]],
    [1, 'Chapter 2', [0]],
  ]);
  assert.deepStrictEqual(result.groups[1].matches[0].parts, [{ text: 'Ivan', hit: true }, { text: ' Karamázov returned.', hit: false }]);
  assert.strictEqual(search.searchBook(b, 'ivan').total, 1);
  assert.strictEqual(search.searchBook(a, 'karamazov').total, 1);
});

test('the index stores integers (FTS5 columns have no type affinity)', () => {
  const row = db.prepare('SELECT typeof(rowid) AS r, typeof(book_id) AS b, typeof(chapter_idx) AS c, typeof(para_index) AS p FROM para_search LIMIT 1').get();
  assert.deepStrictEqual(row, { r: 'integer', b: 'integer', c: 'integer', p: 'integer' });
});

test('a queued book is indexed, a removed one purged without touching others', async () => {
  const c = addBook('c', [['Ivan once more.']]);
  search.queueBook(c);
  await settle();
  assert.strictEqual(search.searchBook(c, 'ivan').total, 1);
  db.transaction(() => {
    search.removeBook(a);
    db.prepare('DELETE FROM books WHERE id = ?').run(a);
  })();
  await settle();
  const [lo, hi] = search.bookRange(a);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM para_search WHERE rowid BETWEEN ? AND ?').get(lo, hi).n, 0);
  assert.strictEqual(search.searchBook(b, 'ivan').total, 1);
  assert.strictEqual(search.searchBook(c, 'ivan').total, 1);
});

test('nonsense queries are empty results, not errors', () => {
  for (const q of ['" * - ( ) : ^', 'NEAR(', '"', 'a OR', 'col:ivan']) {
    assert.doesNotThrow(() => search.searchBook(b, q), q);
  }
  assert.deepStrictEqual(search.searchBook(b, '* -'), { groups: [], total: 0, more: false });
});
