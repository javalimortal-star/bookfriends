const test = require('node:test');
const assert = require('node:assert');
const { db, addUser } = require('./fresh-db');
const push = require('../src/push');
const { translator } = require('../src/i18n');
const requests = require('../src/requests/service');

const owner = addUser('owner@example.com', 'owner');
const ana = addUser('ana@example.com', 'reader', 'Ana');
const pedro = addUser('pedro@example.com', 'reader', 'Pedro');

// Collect what would go to phones instead of sending it.
let sent = [];
push.sendToUser = (userId, payload) => { sent.push({ userId, ...payload }); };

const en = translator('en');

test('validate trims, collapses spaces and enforces the limits', () => {
  assert.deepStrictEqual(requests.validate({ title: '  Dom   Casmurro ', author: ' Machado ', note: 'a\r\n\r\n\r\n\r\nb  c' }, en),
    { values: { title: 'Dom Casmurro', author: 'Machado', note: 'a\n\nb c' }, error: null });
  assert.strictEqual(requests.validate({ title: '   ' }, en).error, 'Enter the title of the book.');
  assert.strictEqual(requests.validate({ title: 'x'.repeat(121) }, en).error, 'The title can have at most 120 characters.');
  assert.strictEqual(requests.validate({ title: 'x'.repeat(120) }, en).error, null);
  assert.strictEqual(requests.validate({ title: 'x', author: 'y'.repeat(81) }, en).error, 'The author can have at most 80 characters.');
  assert.strictEqual(requests.validate({ title: 'x', note: 'z'.repeat(301) }, en).error, 'The note can have at most 300 characters.');
  assert.strictEqual(requests.validate({ title: '' }, translator('pt')).error, 'Digite o título do livro.');
  assert.strictEqual(requests.validate({}, en).error, 'Enter the title of the book.');
});

test('normTitle and suggestBook match titles loosely', () => {
  assert.strictEqual(requests.normTitle('  Dom Casmurro!! '), 'dom casmurro');
  assert.strictEqual(requests.normTitle('Memórias Póstumas'), 'memorias postumas');
  const shelf = [{ id: 1, title: 'Dracula' }, { id: 2, title: 'The Count of Monte Cristo' }, { id: 3, title: 'It' }];
  assert.strictEqual(requests.suggestBook('drácula', shelf).id, 1);
  assert.strictEqual(requests.suggestBook('Monte Cristo', shelf).id, 2);
  assert.strictEqual(requests.suggestBook('Dune', shelf), null);
  assert.strictEqual(requests.suggestBook('It', shelf), null); // too short to guess
});

test('open requests sort by votes, then newest; votes toggle', () => {
  const first = requests.createRequest(ana, { title: 'First', author: '', note: '' });
  const second = requests.createRequest(pedro, { title: 'Second', author: 'Someone', note: 'please' });
  db.prepare('UPDATE book_requests SET created_at = created_at - 1000 WHERE id = ?').run(first.id);
  assert.deepStrictEqual(requests.listOpen(owner).map((r) => r.title), ['Second', 'First']);
  assert.strictEqual(requests.toggleVote(first.id, pedro), true);
  const list = requests.listOpen(pedro);
  assert.deepStrictEqual(list.map((r) => [r.title, r.votes, r.voted]), [['First', 1, true], ['Second', 0, false]]);
  assert.strictEqual(list[0].requesterName, 'Ana');
  assert.strictEqual(list[0].author, null);
  assert.strictEqual(requests.openCount(), 2);
  assert.strictEqual(requests.toggleVote(first.id, pedro), false);
  assert.strictEqual(requests.listOpen(pedro)[0].title, 'Second');
  requests.deleteRequest(first.id);
  requests.deleteRequest(second.id);
  assert.strictEqual(requests.openCount(), 0);
});

test('findOpenDuplicate ignores case, accents and finished requests', () => {
  const r = requests.createRequest(ana, { title: 'O Cortiço' });
  assert.strictEqual(requests.findOpenDuplicate('o cortico').id, r.id);
  requests.setStatus(r.id, 'declined');
  assert.strictEqual(requests.findOpenDuplicate('o cortico'), null);
  assert.deepStrictEqual(requests.listFinished(owner).map((x) => [x.title, x.status]), [['O Cortiço', 'declined']]);
  requests.deleteRequest(r.id);
});

test('pushes go out in each recipient\'s language and skip whoever acted', () => {
  db.prepare("UPDATE users SET lang = 'pt' WHERE id = ?").run(owner);
  db.prepare("UPDATE users SET lang = 'es' WHERE id = ?").run(pedro);
  db.prepare("UPDATE users SET lang = 'xx' WHERE id = ?").run(ana); // unknown: English

  sent = [];
  const r = requests.createRequest(ana, { title: 'Dom Casmurro' });
  requests.notifyCreated(r, 'Ana');
  assert.deepStrictEqual(sent, [{ userId: owner, title: 'Novo pedido de livro', body: 'Ana pediu “Dom Casmurro”', url: '/requests' }]);

  requests.toggleVote(r.id, pedro);
  requests.toggleVote(r.id, owner);
  const book = { id: Number(db.prepare("INSERT INTO books (owner_id, title, slug, visibility, created_at) VALUES (?, 'Dom Casmurro', 'dom-casmurro', 'public', 0)").run(owner).lastInsertRowid), title: 'Dom Casmurro', slug: 'dom-casmurro' };
  requests.setStatus(r.id, 'done', book.id);
  sent = [];
  requests.notifyDone(r, book, owner);
  assert.deepStrictEqual(sent.map((s) => [s.userId, s.title, s.url]).sort(), [
    [ana, 'A book you asked for is here', '/book/dom-casmurro/0'],
    [pedro, 'Llegó un libro que pediste', '/book/dom-casmurro/0'],
  ].sort());

  // a book deleted later leaves the request done, without a link
  db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
  const done = requests.listFinished(owner)[0];
  assert.deepStrictEqual([done.status, done.book_id, done.book_slug], ['done', null, null]);
});

test('a failing push never breaks the request', async () => {
  push.sendToUser = () => { throw new Error('offline'); };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const r = requests.createRequest(pedro, { title: 'Iracema' });
    assert.doesNotThrow(() => requests.notifyCreated(r, 'Pedro'));
    push.sendToUser = () => Promise.reject(new Error('rejected'));
    assert.doesNotThrow(() => requests.notifyCreated(r, 'Pedro'));
    await new Promise((resolve) => setImmediate(resolve)); // let the rejection be handled
  } finally {
    console.error = original;
  }
  assert.ok(errors[0].includes('offline'));
  assert.ok(errors[1].includes('rejected'));
});
