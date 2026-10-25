const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway database: src/db opens DATA_DIR on require.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ratings-'));
process.env.DATA_DIR = dir;
const { db } = require('../src/db');
require('../src/db/migrate').migrate();
const ratings = require('../src/books/ratings');
const { imageExt, parseDetails } = require('../src/books/details');

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const addUser = db.prepare("INSERT INTO users (email, password_hash, role, display_name, created_at) VALUES (?, 'x', 'reader', ?, 0)");
const ana = Number(addUser.run('ana@example.com', 'Ana').lastInsertRowid);
const pedro = Number(addUser.run('pedro@example.com', null).lastInsertRowid);
const book = Number(db.prepare("INSERT INTO books (owner_id, title, slug, visibility, created_at) VALUES (?, 'B', 'b', 'public', 0)").run(ana).lastInsertRowid);

test('finish, rate, re-rate and unfinish', () => {
  ratings.finish(ana, book);
  assert.deepStrictEqual(ratings.mine(ana, book).stars, null);
  ratings.rate(ana, book, { stars: 4, review: 'Good' });
  ratings.rate(ana, book, { stars: 5, review: null }); // changing it keeps one row
  const mine = ratings.mine(ana, book);
  assert.strictEqual(mine.stars, 5);
  assert.strictEqual(mine.review, null);
  ratings.rate(pedro, book, { stars: 2, review: 'Meh' }); // rating marks finished too
  const all = ratings.forBook(book);
  assert.strictEqual(all.list.length, 2);
  assert.strictEqual(all.count, 2);
  assert.strictEqual(all.avg, 3.5);
  assert.strictEqual(all.list.find((r) => r.userId === pedro).name, 'pedro'); // email prefix without a display name
  const shelf = ratings.shelfSummary(pedro).get(book);
  assert.strictEqual(shelf.count, 2);
  assert.deepStrictEqual(shelf.mine, { stars: 2 });
  ratings.unfinish(pedro, book);
  assert.strictEqual(ratings.mine(pedro, book), null);
  assert.strictEqual(ratings.forBook(book).avg, 5);
});

test('finished without stars counts as finished, not in the average', () => {
  ratings.unfinish(ana, book);
  ratings.finish(ana, book);
  const all = ratings.forBook(book);
  assert.strictEqual(all.list.length, 1);
  assert.strictEqual(all.count, 0);
  assert.strictEqual(all.avg, null);
});

test('parseRating clamps stars and trims the review', () => {
  assert.deepStrictEqual(ratings.parseRating({ stars: '3', review: '  nice\n\n\n\nbook ' }), { stars: 3, review: 'nice\n\nbook' });
  assert.deepStrictEqual(ratings.parseRating({ stars: '9' }), { stars: null, review: null });
  assert.deepStrictEqual(ratings.parseRating({ stars: 'x', review: '' }), { stars: null, review: null });
  assert.ok(ratings.parseRating({ review: 'x'.repeat(ratings.REVIEW_MAX + 1) }).error);
});

test('cover type comes from the file bytes', () => {
  const pad = Buffer.alloc(16);
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), '.jpg');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), pad])), '.png');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from('GIF89a'), pad])), '.gif');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP'), pad])), '.webp');
  assert.strictEqual(imageExt(Buffer.concat([Buffer.from('<svg onload=alert(1)>'), pad])), null);
  assert.strictEqual(imageExt(Buffer.from('tiny')), null);
});

test('parseDetails validates title and series number', () => {
  const t = (s) => s;
  assert.strictEqual(parseDetails({ title: '  ' }, t).error, 'Enter a title.');
  const ok = parseDetails({ title: ' Dune  Messiah ', author: '', series: 'Dune', series_index: '2,5', description: 'a\r\n\r\n\r\nb' }, t);
  assert.strictEqual(ok.error, undefined);
  assert.deepStrictEqual(ok.values, { title: 'Dune Messiah', author: null, series: 'Dune', series_index: 2.5, description: 'a\n\nb' });
  assert.ok(parseDetails({ title: 'x', series_index: 'two' }, t).error);
  assert.ok(parseDetails({ title: 'x', series_index: '-1' }, t).error);
});
