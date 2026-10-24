const { db } = require('../db');
const { paragraphTexts, buildMatchQuery, snippetParts, MAX_PARA } = require('./search-text');

// Search inside a book: SQLite FTS5 (table para_search in schema.sql).
//
// rowid = book_id * 2^40 + chapter_idx * 2^20 + para_index: a book's rows are
// one rowid range, which FTS5 scans directly (no wading through matches from
// other books), and rowid order is reading order, so "the first 50 matches"
// stops after 50 rows instead of sorting every match of a common word.
// Rowids are bound as BigInt: FTS5 ignores rowid bounds that arrive as
// floating point (how better-sqlite3 binds plain JS numbers), and every
// range query then silently scanned the whole table.
const BOOK_SPAN = 2n ** 40n;
const CHAPTER_SPAN = BigInt(MAX_PARA);
const MAX_RESULTS = 50;
const COUNT_CAP = 1000;

function rowidOf(bookId, chapterIdx, paraIndex) {
  return BigInt(bookId) * BOOK_SPAN + BigInt(chapterIdx) * CHAPTER_SPAN + BigInt(paraIndex);
}

function bookRange(bookId) {
  const lo = BigInt(bookId) * BOOK_SPAN;
  return [lo, lo + BOOK_SPAN - 1n];
}

// Prepared on first use, so requiring this module never needs the tables
// (migrate() creates them at boot).
let prepared = null;
const S = () => prepared || (prepared = {
  insert: db.prepare('INSERT INTO para_search (rowid, text, book_id, chapter_idx, para_index) VALUES (?, ?, ?, ?, ?)'),
  results: db.prepare(`
    SELECT chapter_idx AS chapterIdx, para_index AS para,
           snippet(para_search, 0, char(1), char(2), '…', 24) AS snip
    FROM para_search
    WHERE para_search MATCH ? AND rowid BETWEEN ? AND ?
    ORDER BY rowid LIMIT ${MAX_RESULTS}`),
  count: db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM para_search WHERE para_search MATCH ? AND rowid BETWEEN ? AND ? LIMIT ${COUNT_CAP + 1}
    )`),
  progress: db.prepare('SELECT next_idx, done FROM search_progress WHERE book_id = ?'),
  queue: db.prepare('INSERT OR IGNORE INTO search_progress (book_id, next_idx, done) VALUES (?, 0, 0)'),
  nextPending: db.prepare('SELECT book_id, next_idx FROM search_progress WHERE done = 0 ORDER BY book_id LIMIT 1'),
  setProgress: db.prepare('UPDATE search_progress SET next_idx = ?, done = ? WHERE book_id = ?'),
  removeProgress: db.prepare('DELETE FROM search_progress WHERE book_id = ?'),
  unqueued: db.prepare('SELECT id FROM books WHERE id NOT IN (SELECT book_id FROM search_progress) ORDER BY id'),
  nextChapter: db.prepare('SELECT idx, content_html FROM chapters WHERE book_id = ? AND idx >= ? ORDER BY idx LIMIT 1'),
  chapterCount: db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?'),
  chapterTitle: db.prepare('SELECT title FROM chapters WHERE book_id = ? AND idx = ?'),
  addPurge: db.prepare('INSERT OR IGNORE INTO search_purge (book_id) VALUES (?)'),
  nextPurge: db.prepare('SELECT book_id FROM search_purge ORDER BY book_id LIMIT 1'),
  donePurge: db.prepare('DELETE FROM search_purge WHERE book_id = ?'),
  firstRow: db.prepare('SELECT rowid AS id FROM para_search WHERE rowid BETWEEN ? AND ? ORDER BY rowid LIMIT 1').safeIntegers(),
  removeRange: db.prepare('DELETE FROM para_search WHERE rowid BETWEEN ? AND ?'),
});

// { ready: true } once the whole book is indexed, else { ready: false,
// percent }. A book not queued yet counts as 0 %: the backfill will get there.
function indexStatus(bookId) {
  const row = S().progress.get(bookId);
  if (row && row.done) return { ready: true, percent: 100 };
  const total = S().chapterCount.get(bookId).n;
  const percent = row && total ? Math.min(99, Math.floor((row.next_idx / total) * 100)) : 0;
  return { ready: false, percent };
}

// The first MAX_RESULTS matching paragraphs in reading order, grouped by
// chapter, and how many paragraphs match in all (counted up to COUNT_CAP;
// `more` says there are even more).
function searchBook(bookId, raw) {
  const empty = { groups: [], total: 0, more: false };
  const match = buildMatchQuery(raw);
  if (!match) return empty;
  const [lo, hi] = bookRange(bookId);
  let rows;
  let total;
  try {
    rows = S().results.all(match, lo, hi);
    total = rows.length < MAX_RESULTS ? rows.length : S().count.get(match, lo, hi).n;
  } catch (err) {
    // buildMatchQuery should make this impossible; still, a query FTS5
    // rejects is "no results", never a 500.
    console.error('search failed for', JSON.stringify(match), err.message);
    return empty;
  }
  const groups = [];
  for (const row of rows) {
    let group = groups[groups.length - 1];
    if (!group || group.chapterIdx !== row.chapterIdx) {
      const chapter = S().chapterTitle.get(bookId, row.chapterIdx);
      group = { chapterIdx: row.chapterIdx, title: chapter ? chapter.title : '', matches: [] };
      groups.push(group);
    }
    group.matches.push({ para: row.para, parts: snippetParts(row.snip) });
  }
  return { groups, total: Math.min(total, COUNT_CAP), more: total > COUNT_CAP };
}

/* ---------- background work: index new books, purge deleted ones ---------- */

// Each step works for about STEP_MS, then yields to the event loop
// (setImmediate) so requests keep being served while a big book (one in
// production has 1852 chapters) is indexed. One transaction per step keeps
// the saved progress and the rows in step if the server stops midway.
const STEP_MS = 20;
const RETRY_MS = 60 * 1000;
// a monotonic clock: Date.now() can jump (NTP), stretching a step for seconds
const now = () => Number(process.hrtime.bigint() / 1000000n);
let running = false;

// Deleted book: drop its rows one chapter range at a time.
function purgeStep(bookId, started) {
  const [lo, hi] = bookRange(bookId);
  do {
    const row = S().firstRow.get(lo, hi);
    if (!row) { S().donePurge.run(bookId); return; }
    const chapterStart = row.id - ((row.id - lo) % CHAPTER_SPAN);
    S().removeRange.run(chapterStart, chapterStart + CHAPTER_SPAN - 1n);
  } while (now() - started < STEP_MS);
}

function indexStep(pending, started) {
  const bookId = pending.book_id;
  let next = pending.next_idx;
  let done = 0;
  do {
    const chapter = S().nextChapter.get(bookId, next);
    if (!chapter) { done = 1; break; }
    for (const { para, text } of paragraphTexts(chapter.content_html)) {
      // BigInt: FTS5 columns have no type affinity, a plain number would be stored as REAL
      S().insert.run(rowidOf(bookId, chapter.idx, para), text, BigInt(bookId), BigInt(chapter.idx), BigInt(para));
    }
    next = chapter.idx + 1;
  } while (now() - started < STEP_MS);
  S().setProgress.run(next, done, bookId);
}

function step() {
  try {
    const purge = S().nextPurge.get();
    const pending = purge ? null : S().nextPending.get();
    if (!purge && !pending) {
      running = false;
      return;
    }
    const started = now();
    db.transaction(() => (purge ? purgeStep(purge.book_id, started) : indexStep(pending, started)))();
    setImmediate(step);
  } catch (err) {
    // e.g. the database is busy: try again later rather than stall for good
    console.error('search indexing paused:', err.message);
    running = false;
    setTimeout(kick, RETRY_MS).unref();
  }
}

function kick() {
  if (running) return;
  running = true;
  setImmediate(step);
}

// A new book (createBookFromEpub): index it in the background.
function queueBook(bookId) {
  S().queue.run(bookId);
  kick();
}

// Books uploaded before search existed, and work a restart cut short;
// server.js calls this once it is listening.
function startBackfill() {
  try {
    for (const { id } of S().unqueued.all()) S().queue.run(id);
    kick();
  } catch (err) {
    // never take the server down over search; the next upload kicks it again
    console.error('search backfill not started:', err.message);
  }
}

// Part of deleteBook's transaction; the rows themselves go in the background.
function removeBook(bookId) {
  S().removeProgress.run(bookId);
  S().addPurge.run(bookId);
  kick();
}

module.exports = {
  MAX_RESULTS, rowidOf, bookRange, indexStatus, searchBook, queueBook, startBackfill, removeBook,
};
