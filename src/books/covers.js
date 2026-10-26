const fs = require('fs');
const nodePath = require('path');
const { db, DATA_DIR } = require('../db');

// Covers show at most ~170 css px wide (shelf cards, book page), so a 480 px
// JPEG stays crisp on 3x phones at ~50 KB, where EPUB covers run up to 1.6 MB.
// books.cover_thumb names the file /media/book/:id/cover serves.
const WIDTH = 480;

let sharp; // loaded on first use; null if it can't load (covers then stay full size)
function lib() {
  if (sharp === undefined) {
    try {
      sharp = require('sharp');
      sharp.cache(false); // a 1 GB server: don't keep decoded images around
      sharp.concurrency(1);
    } catch (err) {
      sharp = null;
      console.error('covers: sharp could not load, covers stay full size:', err.message);
    }
  }
  return sharp;
}

const dirOf = (id) => nodePath.join(DATA_DIR, 'books', String(id));

// Records the original's name when a JPEG wouldn't be smaller (or the image
// can't be read), so nothing is retried on every boot.
async function makeThumb(id) {
  const book = db.prepare('SELECT id, cover_path, cover_thumb FROM books WHERE id = ?').get(id);
  if (!book || !book.cover_path || book.cover_thumb || !lib()) return;
  const original = nodePath.basename(book.cover_path);
  let use = original;
  let written = null;
  try {
    const input = await fs.promises.readFile(nodePath.join(dirOf(id), original));
    const thumb = await sharp(input).rotate().resize({ width: WIDTH, withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 78, mozjpeg: true }).toBuffer();
    if (thumb.length < input.length) {
      written = `thumb-${Date.now()}.jpg`;
      await fs.promises.writeFile(nodePath.join(dirOf(id), written), thumb);
      use = written;
    }
  } catch (err) {
    console.error(`covers: book ${id}: ${err.message}`);
  }
  // unless the cover changed meanwhile (an edit queues its own thumbnail)
  const info = db.prepare('UPDATE books SET cover_thumb = ? WHERE id = ? AND cover_path = ? AND cover_thumb IS NULL')
    .run(use, id, book.cover_path);
  if (!info.changes && written) fs.rmSync(nodePath.join(dirOf(id), written), { force: true });
}

// One at a time, in the background: thumbnails never hold up a request.
let queue = Promise.resolve();
function queueThumb(id) {
  queue = queue.then(() => makeThumb(id)).catch((err) => console.error('covers:', err.message));
  return queue;
}

// Covers from before thumbnails existed (or a restart mid-way).
function backfillThumbs() {
  for (const { id } of db.prepare('SELECT id FROM books WHERE cover_path IS NOT NULL AND cover_thumb IS NULL').all()) queueThumb(id);
  return queue;
}

// The thumbnail file of a cover that is being replaced or removed.
function dropThumb(book) {
  if (book.cover_thumb && book.cover_thumb !== book.cover_path) {
    fs.rmSync(nodePath.join(dirOf(book.id), nodePath.basename(book.cover_thumb)), { force: true });
  }
}

module.exports = { queueThumb, backfillThumbs, dropThumb, WIDTH };
