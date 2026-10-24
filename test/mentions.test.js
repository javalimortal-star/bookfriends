const test = require('node:test');
const assert = require('node:assert');
const { findMentions, suggest, MAX_MENTIONS } = require('../src/comments/mentions');

const users = [
  { id: 1, name: 'javalimortal' },
  { id: 2, name: 'Ana' },
  { id: 3, name: 'Pedro' },
  { id: 4, name: 'Ana Maria' },
  { id: 5, name: 'João Paulo' },
  { id: 6, name: 'b' },
];
const names = (text) => findMentions(text, users).map((m) => m.name);
const ids = (text) => findMentions(text, users).map((m) => m.id);

test('finds a plain mention and reports it as written', () => {
  assert.deepStrictEqual(findMentions('oi @Pedro tudo bem?', users), [{ id: 3, name: 'Pedro' }]);
});

test('is case-insensitive and keeps the written case', () => {
  assert.deepStrictEqual(findMentions('@pedro e @ANA', users), [{ id: 3, name: 'pedro' }, { id: 2, name: 'ANA' }]);
});

test('names with spaces match, longest name first', () => {
  assert.deepStrictEqual(ids('@Ana Maria chegou'), [4]);
  assert.deepStrictEqual(ids('@Ana chegou'), [2]);
  assert.deepStrictEqual(ids('@Ana Mar'), [2]);
  assert.deepStrictEqual(names('valeu @joão paulo!'), ['joão paulo']);
});

test('punctuation and the end of the text end a mention', () => {
  assert.deepStrictEqual(ids('@Pedro, @Ana.'), [3, 2]);
  assert.deepStrictEqual(ids('(@Pedro) @Ana?'), [3, 2]);
  assert.deepStrictEqual(ids("@Ana's turn"), [2]);
  assert.deepStrictEqual(ids('@Pedro'), [3]);
  assert.deepStrictEqual(ids('linha\n@Pedro\noutra'), [3]);
});

test('a name must not run on into a longer word', () => {
  assert.deepStrictEqual(ids('@Anabela @Pedros @Pedro_'), []);
  assert.deepStrictEqual(ids('@Pedro2'), []);
});

test('unknown names and a lone @ are ignored', () => {
  assert.deepStrictEqual(ids('@Carla @ @@'), []);
  assert.deepStrictEqual(ids(''), []);
  assert.deepStrictEqual(findMentions(null, users), []);
});

test('email addresses are not mentions', () => {
  assert.deepStrictEqual(ids('manda para a@b.com ou pedro@Pedro.com'), []);
  assert.deepStrictEqual(ids('x@Ana'), []);
});

test('each user is mentioned once, in order of first appearance', () => {
  assert.deepStrictEqual(names('@Pedro @Ana @pedro @PEDRO'), ['Pedro', 'Ana']);
});

test('two users with the same name are both mentioned', () => {
  const twins = [{ id: 1, name: 'Ana' }, { id: 2, name: 'ana' }, { id: 3, name: 'Anabela' }];
  assert.deepStrictEqual(findMentions('@Ana', twins).map((m) => m.id), [1, 2]);
});

test(`at most ${MAX_MENTIONS} users per comment`, () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, name: `user${i + 1}` }));
  const text = many.map((u) => `@${u.name}`).join(' ');
  const found = findMentions(text, many);
  assert.strictEqual(found.length, MAX_MENTIONS);
  assert.deepStrictEqual(found.map((m) => m.id), many.slice(0, MAX_MENTIONS).map((u) => u.id));
});

test('users without a name never match', () => {
  assert.deepStrictEqual(findMentions('@ hi @', [{ id: 1, name: '' }, { id: 2, name: '  ' }]), []);
});

test('suggest: prefix matches first, then later words, then anywhere; accent-blind', () => {
  assert.deepStrictEqual(suggest(users, 'a').map((u) => u.name), ['Ana', 'Ana Maria', 'javalimortal', 'João Paulo']);
  assert.deepStrictEqual(suggest(users, 'ped').map((u) => u.name), ['Pedro']);
  assert.deepStrictEqual(suggest(users, 'pa').map((u) => u.name), ['João Paulo']);
  assert.deepStrictEqual(suggest(users, 'joao').map((u) => u.name), ['João Paulo']);
  assert.deepStrictEqual(suggest(users, 'ANA ').map((u) => u.name), ['Ana Maria']);
  assert.deepStrictEqual(suggest(users, 'zzz'), []);
});

test('suggest: empty query lists everyone alphabetically, capped', () => {
  assert.strictEqual(suggest(users, '').length, users.length);
  assert.strictEqual(suggest(users, '', 3).length, 3);
  assert.deepStrictEqual(suggest(users, '', 2), [{ id: 2, name: 'Ana' }, { id: 4, name: 'Ana Maria' }]);
});

test('a hostile body full of "@" is cheap to scan', () => {
  const users = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Friend Number ${i}` }));
  const started = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) {
    findMentions('@'.repeat(10000), users);
    findMentions('@a '.repeat(3333), users);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 200, `40 scans took ${ms.toFixed(0)} ms`);
  // only "@" + a letter or digit starts a name ("@@Name" still counts, "@ Name" doesn't)
  assert.deepStrictEqual(findMentions('@@Friend Number 1 @ Friend Number 2', users).map((m) => m.name), ['Friend Number 1']);
});
