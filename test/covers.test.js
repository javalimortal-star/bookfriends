const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { db, dir, addUser } = require('./fresh-db');
const sharp = require('sharp');
const covers = require('../src/books/covers');

const owner = addUser('owner@example.com', 'owner');
const addBook = db.prepare("INSERT INTO books (owner_id, title, slug, cover_path, created_at) VALUES (?, ?, ?, ?, 0)");
function bookWithCover(slug, file, bytes) {
  const id = Number(addBook.run(owner, slug, slug, file).lastInsertRowid);
  fs.mkdirSync(path.join(dir, 'books', String(id)), { recursive: true });
  fs.writeFileSync(path.join(dir, 'books', String(id), file), bytes);
  return id;
}
const row = (id) => db.prepare('SELECT cover_path, cover_thumb FROM books WHERE id = ?').get(id);

test('a big cover gets a small JPEG, 480 px wide', async () => {
  const big = await sharp({ create: { width: 1800, height: 2700, channels: 3, background: '#c33' } })
    .composite([{ input: Buffer.from('<svg width="1800" height="2700"><text x="100" y="900" font-size="300">DRACULA</text></svg>') }])
    .jpeg({ quality: 95 }).toBuffer();
  const id = bookWithCover('big', 'cover.jpg', big);
  await covers.queueThumb(id);
  const { cover_thumb: thumb } = row(id);
  assert.match(thumb, /^thumb-\d+\.jpg$/);
  const file = path.join(dir, 'books', String(id), thumb);
  const meta = await sharp(file).metadata();
  assert.strictEqual(meta.width, covers.WIDTH);
  assert.strictEqual(meta.format, 'jpeg');
  assert.ok(fs.statSync(file).size < big.length / 3, 'much smaller');
  // replacing the cover drops the old thumbnail file
  covers.dropThumb({ id, cover_path: 'cover.jpg', cover_thumb: thumb });
  assert.ok(!fs.existsSync(file));
});

test('a cover a JPEG would not shrink, or a broken one, keeps the original (and is not retried)', async () => {
  const tiny = await sharp({ create: { width: 40, height: 60, channels: 3, background: '#000' } }).png({ palette: true }).toBuffer();
  const small = bookWithCover('tiny', 'cover.png', tiny);
  const broken = bookWithCover('broken', 'cover.jpg', Buffer.from('not an image at all'));
  await covers.backfillThumbs();
  assert.strictEqual(row(small).cover_thumb, 'cover.png');
  assert.strictEqual(row(broken).cover_thumb, 'cover.jpg');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM books WHERE cover_path IS NOT NULL AND cover_thumb IS NULL').get().n, 0);
});
