const test = require('node:test');
const assert = require('node:assert');
const { db, addUser } = require('./fresh-db');
const { createBookFromEpub } = require('../src/books/service');
const search = require('../src/books/search');
const { MAX_PARA } = require('../src/books/search-text');
const { reparseBook } = require('../scripts/reparse');
const { writeMadeUpEpub } = require('./made-up-epub');

test('reparse updates chapters that read the same or only grew at the end, and leaves changed ones alone', async () => {
  const book = createBookFromEpub(writeMadeUpEpub(), addUser('owner@example.com', 'owner'));
  for (let i = 0; i < 50 && !search.indexStatus(book.id).ready; i++) await new Promise((r) => setTimeout(r, 20));
  const html = (idx) => db.prepare('SELECT content_html FROM chapters WHERE book_id = ? AND idx = ?').get(book.id, idx).content_html;
  const store = (idx, value) => db.prepare('UPDATE chapters SET content_html = ? WHERE book_id = ? AND idx = ?').run(value, book.id, idx);
  const today = [0, 1, 2, 3, 4].map(html);
  // as an older parser stored them: no footnote link, a chapter missing its
  // last paragraphs, and one whose words differ (comments would move)
  store(1, '<h3>Chapter 1</h3>\n<p data-p="0">One a.1</p>\n<p data-p="1">One b.</p>');
  store(3, '<h3>Chapter 3</h3>\n<p data-p="0">Three a.2</p>');
  store(2, '<h3>Chapter 2</h3>\n<p data-p="0">Other words.</p>');
  // ...and the search index without chapter 3's last two paragraphs
  const [bookStart] = search.bookRange(book.id);
  const chapter3 = bookStart + 3n * BigInt(MAX_PARA);
  db.prepare('DELETE FROM para_search WHERE rowid BETWEEN ? AND ?').run(chapter3 + 1n, chapter3 + BigInt(MAX_PARA) - 1n);
  assert.strictEqual(search.searchBook(book.id, 'goes on').total, 0);

  assert.deepStrictEqual(reparseBook(book), { updated: 2, kept: 1 });
  assert.strictEqual(html(1), today[1]);
  assert.strictEqual(html(3), today[3]);
  assert.match(html(2), /Other words/);
  assert.deepStrictEqual([0, 4].map(html), [today[0], today[4]]);
  assert.strictEqual(search.searchBook(book.id, 'goes on').groups[0].chapterIdx, 3, 'the paragraphs it gained are searchable');
  assert.deepStrictEqual(reparseBook(book), { updated: 0, kept: 1 }, 'running it again changes nothing');
});
