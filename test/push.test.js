const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// src/push/index.js opens the database: give it a throwaway DATA_DIR.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-push-test-'));
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const { notificationPayload, excerpt, EXCERPT_CHARS } = require('../src/push/payload');
const { parseSubscription } = require('../src/push/subscription');
const { linkFor } = require('../src/comments/notifications');
const push = require('../src/push');
const { db } = require('../src/db');

require('../src/db/migrate').migrate();

test.after(() => {
  require('../src/db').db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const reply = {
  kind: 'reply', body: 'What a twist!', spoiler: 0,
  author_name: 'Ana', author_email: 'ana@example.com',
  book_slug: 'dracula', chapter_idx: 4, para_index: 12,
};

test('titles by kind, in the recipient language', () => {
  assert.strictEqual(notificationPayload(reply, 'en', '/x').title, 'Ana replied to your comment');
  assert.strictEqual(notificationPayload(reply, 'pt', '/x').title, 'Ana respondeu ao seu comentário');
  assert.strictEqual(notificationPayload(reply, 'es', '/x').title, 'Ana respondió a tu comentario');
  assert.strictEqual(notificationPayload({ ...reply, kind: 'mention' }, 'pt', '/x').title, 'Ana mencionou você');
  assert.strictEqual(notificationPayload({ ...reply, kind: 'mention' }, 'en', '/x').title, 'Ana mentioned you');
  assert.strictEqual(notificationPayload({ ...reply, kind: 'party' }, 'en', '/x').title, 'New notification from Ana');
});

test('unknown or missing language falls back to English', () => {
  assert.strictEqual(notificationPayload(reply, null, '/x').title, 'Ana replied to your comment');
  assert.strictEqual(notificationPayload(reply, 'xx', '/x').title, 'Ana replied to your comment');
});

test('author without a display name shows the email prefix', () => {
  const p = notificationPayload({ ...reply, author_name: null }, 'en', '/x');
  assert.strictEqual(p.title, 'ana replied to your comment');
});

test('body is the comment excerpt; spoilers are masked', () => {
  assert.strictEqual(notificationPayload(reply, 'en', '/x').body, 'What a twist!');
  const spoiler = notificationPayload({ ...reply, spoiler: 1, body: 'Lucy dies' }, 'pt', '/x');
  assert.strictEqual(spoiler.body, 'Spoiler — abra para ler');
  assert.ok(!spoiler.body.includes('Lucy'));
  assert.ok(!JSON.stringify(spoiler).includes('Lucy'));
});

test('long comments are cut to one short line', () => {
  const long = 'word '.repeat(100);
  const body = notificationPayload({ ...reply, body: long }, 'en', '/x').body;
  assert.ok(body.length <= EXCERPT_CHARS, `${body.length} chars`);
  assert.ok(body.endsWith('…'));
  assert.strictEqual(excerpt('  two\n\nlines  '), 'two lines');
});

test('the url is the same deep link the notifications page uses', () => {
  assert.strictEqual(linkFor(reply), '/book/dracula/4?peek=1&panel=12');
  assert.strictEqual(linkFor({ ...reply, para_index: null }), '/book/dracula/4?peek=1#comments');
  assert.strictEqual(notificationPayload(reply, 'en', linkFor(reply)).url, '/book/dracula/4?peek=1&panel=12');
});

function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}

test('accepts a real-looking subscription', () => {
  const keys = browserKeys();
  const sub = parseSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', expirationTime: null, keys });
  assert.deepStrictEqual(sub, { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: keys.p256dh, auth: keys.auth });
});

test('rejects endpoints that would make the server call its own network', () => {
  const keys = browserKeys();
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc', // not https
    'https://127.0.0.1/push', 'https://10.0.0.5/push', 'https://[::1]/push', 'https://169.254.169.254/latest',
    'https://localhost/push', 'https://printer.local/push', 'https://metadata/computeMetadata',
    'https://user:pw@fcm.googleapis.com/x', 'not a url', 'x'.repeat(3000),
  ]) {
    assert.strictEqual(parseSubscription({ endpoint, keys }), null, endpoint);
  }
  // tests run a fake push service on 127.0.0.1
  assert.ok(parseSubscription({ endpoint: 'https://127.0.0.1:3142/push/abc', keys }, { allowLocal: true }));
});

test('rejects malformed keys', () => {
  const keys = browserKeys();
  const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/abc';
  assert.strictEqual(parseSubscription({ endpoint }), null);
  assert.strictEqual(parseSubscription({ endpoint, keys: { ...keys, p256dh: 'abc' } }), null);
  assert.strictEqual(parseSubscription({ endpoint, keys: { ...keys, auth: 'short' } }), null);
  assert.strictEqual(parseSubscription({ endpoint, keys: { ...keys, auth: 'not base64!!' } }), null);
  assert.strictEqual(parseSubscription(null), null);
  assert.strictEqual(parseSubscription('nope'), null);
});

test('VAPID keys are generated once, saved privately, and reused', () => {
  const file = path.join(process.env.DATA_DIR, 'vapid.json');
  const key = push.publicKey();
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).publicKey, key);
  assert.strictEqual(push.publicKey(), key);
});

test('sendToUser without subscriptions resolves quietly', async () => {
  assert.deepStrictEqual(await push.sendToUser(12345, { title: 'x', body: 'y', url: '/' }), { sent: 0, failed: 0, removed: 0 });
});

test('subscriptions: upsert by endpoint, reassigned to whoever subscribes, capped per user', () => {
  const addUser = db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, 'x', 0)");
  const ana = Number(addUser.run('ana@test').lastInsertRowid);
  const bob = Number(addUser.run('bob@test').lastInsertRowid);
  const rows = (userId) => db.prepare('SELECT endpoint, p256dh FROM push_subscriptions WHERE user_id = ? ORDER BY id').all(userId);
  const sub = (n, keys = browserKeys()) => ({ endpoint: `https://push.example.com/${n}`, ...keys });

  push.saveSubscription(ana, sub(1));
  const newKeys = browserKeys();
  push.saveSubscription(ana, sub(1, newKeys)); // same device again: one row, fresh keys
  assert.deepStrictEqual(rows(ana), [{ endpoint: 'https://push.example.com/1', p256dh: newKeys.p256dh }]);

  push.saveSubscription(bob, sub(1)); // Bob turned it on on Ana's phone
  assert.strictEqual(rows(ana).length, 0);
  assert.strictEqual(rows(bob).length, 1);

  push.removeSubscription(ana, 'https://push.example.com/1'); // not hers any more: no effect
  assert.strictEqual(rows(bob).length, 1);
  push.removeSubscription(bob, 'https://push.example.com/1');
  assert.strictEqual(rows(bob).length, 0);

  for (let i = 0; i < 12; i++) push.saveSubscription(ana, sub(100 + i));
  const kept = rows(ana).map((r) => r.endpoint);
  assert.strictEqual(kept.length, 10);
  assert.ok(kept.includes('https://push.example.com/111'), 'newest kept');
  assert.ok(!kept.includes('https://push.example.com/100'), 'oldest dropped');

  // deleting a user takes their devices along
  db.prepare('DELETE FROM users WHERE id = ?').run(ana);
  assert.strictEqual(rows(ana).length, 0);
});
