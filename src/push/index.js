const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('../db');
const { notificationPayload } = require('./payload');

// Web Push to a user's subscribed devices (phones, computers, the installed
// app). The browser's push service (Google, Mozilla, Apple) holds the message
// until the device is reachable; public/sw.js shows it.
//
// Sending is never part of a request: callers return at once and delivery
// happens on a later tick, so a slow or failing push service can't slow down
// or break posting a comment. Failures are only logged.

const TTL_SECONDS = 24 * 60 * 60; // a reply a day late isn't worth a buzz any more
const SEND_TIMEOUT_MS = 10 * 1000;
const MAX_DEVICES_PER_USER = 10;
const ICON = '/android-chrome-192x192.png';

// Loaded on first use: boot stays quick, and a server whose node_modules
// predate this dependency still runs (only push fails, with a logged error).
let webpushLib = null;
function webpush() {
  if (!webpushLib) webpushLib = require('web-push');
  return webpushLib;
}

// The site's VAPID key pair identifies it to the push services; every
// subscription is tied to the public key, so it must stay the same. From the
// environment if set, else generated once and kept next to the database
// (scripts/backup.js archives it with the DB). If it is ever lost, new keys
// are made and each device has to turn notifications on again in Settings.
let vapid = null;
function vapidKeys() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    return vapid;
  }
  const file = path.join(DATA_DIR, 'vapid.json');
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`push: ${file} is unreadable (${err.message})`);
  }
  if (raw !== null) {
    // A damaged file must not be silently replaced: new keys would quietly
    // cut off every device. Push stays off until it is fixed or restored.
    let saved = null;
    try { saved = JSON.parse(raw); } catch { /* reported below */ }
    if (!saved || !saved.publicKey || !saved.privateKey) throw new Error(`push: ${file} is damaged; restore it from a backup`);
    vapid = { publicKey: saved.publicKey, privateKey: saved.privateKey };
    return vapid;
  }
  const keys = webpush().generateVAPIDKeys();
  // written next to it and renamed: a crash mid-write can't leave half a file
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  console.log(`push: generated VAPID keys in ${file}`);
  return vapid;
}

function publicKey() {
  return vapidKeys().publicKey;
}

// Push services may contact this address about problems with our pushes.
function subject() {
  const email = String(process.env.OWNER_EMAIL || '').trim();
  return /^[^\s@]+@[^\s@]+$/.test(email) ? `mailto:${email}` : 'mailto:admin@bookfriends.com.br';
}

// ---------- subscriptions ----------

// Upsert by endpoint: a device subscribes once, and if another account later
// turns notifications on there, the device is theirs now. created_at is
// refreshed so the per-user cap below drops devices that stopped checking in.
function saveSubscription(userId, sub) {
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at
  `).run(userId, sub.endpoint, sub.p256dh, sub.auth, Date.now());
  db.prepare(`
    DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
      SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)
  `).run(userId, userId, MAX_DEVICES_PER_USER);
}

function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}

// ---------- sending ----------

// Endpoints are secret-ish capability URLs: log only the push service's host.
function hostOf(endpoint) {
  try {
    return new URL(endpoint).host;
  } catch {
    return '?';
  }
}

async function deliver(userId, { title, body, url }) {
  const result = { sent: 0, failed: 0, removed: 0 };
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (subs.length === 0) return result;
  const keys = vapidKeys();
  const message = JSON.stringify({ title, body, url: url || '/', icon: ICON });
  const options = {
    TTL: TTL_SECONDS,
    timeout: SEND_TIMEOUT_MS,
    vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
  };
  await Promise.all(subs.map((sub) => webpush()
    .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, message, options)
    .then(() => { result.sent += 1; }, (err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // the browser dropped this subscription (turned off, site data cleared)
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        result.removed += 1;
      } else {
        result.failed += 1;
        console.error(`push: ${hostOf(sub.endpoint)} refused a notification: ${err.statusCode || err.code || err.message}`);
      }
    })));
  return result;
}

// Anything worth a phone notification. payload: { title, body, url }, already
// in the recipient's language. Resolves to { sent, failed, removed }; never
// rejects.
function sendToUser(userId, payload) {
  return new Promise((resolve) => setImmediate(resolve))
    .then(() => deliver(userId, payload))
    .catch((err) => {
      console.error('push: sending failed:', err.message);
      return { sent: 0, failed: 0, removed: 0 };
    });
}

// A new row in `notifications` (reply, mention, ...): tell the recipient's devices.
// At most one notification push per person per minute: a burst of replies
// or mentions (or someone spamming edits) buzzes the phone once; every one
// is still listed on /notifications.
const PUSH_GAP_MS = 60 * 1000;
const lastPushAt = new Map();

function notificationCreated(notificationId) {
  setImmediate(() => {
    try {
      const n = db.prepare(`
        SELECT n.user_id, n.kind, c.body, c.spoiler, c.para_index,
          a.display_name AS author_name, a.email AS author_email,
          r.lang AS recipient_lang, ch.idx AS chapter_idx, b.slug AS book_slug
        FROM notifications n
        JOIN users r ON r.id = n.user_id
        JOIN comments c ON c.id = n.comment_id
        JOIN users a ON a.id = c.user_id
        JOIN chapters ch ON ch.id = c.chapter_id
        JOIN books b ON b.id = c.book_id
        WHERE n.id = ?
      `).get(notificationId);
      if (!n) return; // deleted meanwhile
      const now = Date.now();
      if (now - (lastPushAt.get(n.user_id) || 0) < PUSH_GAP_MS) return;
      lastPushAt.set(n.user_id, now);
      // required here: notifications.js requires this module at load time
      const { linkFor } = require('../comments/notifications');
      sendToUser(n.user_id, notificationPayload(n, n.recipient_lang, linkFor(n)));
    } catch (err) {
      console.error(`push: notification ${notificationId} not sent:`, err.message);
    }
  });
}

module.exports = { notificationCreated, sendToUser, publicKey, saveSubscription, removeSubscription };
