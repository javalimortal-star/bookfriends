const net = require('net');

// Checks a browser's PushSubscription.toJSON() before it is stored. The
// server later POSTs to the endpoint, so a logged-in user must not be able to
// aim it at the server's own network: production accepts only https URLs on
// public host names (push services are fcm.googleapis.com,
// updates.push.services.mozilla.com, web.push.apple.com, ...).

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function decode(value) {
  return typeof value === 'string' && B64URL.test(value) ? Buffer.from(value, 'base64url') : null;
}

function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return net.isIP(host) !== 0 || !host.includes('.') || /\.(localhost|local|internal|lan|home)$/.test(host);
}

// Returns { endpoint, p256dh, auth } or null. allowLocal lets tests use a fake
// push service on 127.0.0.1 (never in production).
function parseSubscription(body, { allowLocal = false } = {}) {
  if (!body || typeof body !== 'object') return null;
  const { endpoint } = body;
  const keys = body.keys && typeof body.keys === 'object' ? body.keys : {};
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (!allowLocal && isPrivateHost(url.hostname)) return null;
  // p256dh: the device's uncompressed P-256 public key; auth: its 16-byte secret
  const p256dh = decode(keys.p256dh);
  const auth = decode(keys.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return null;
  if (!auth || auth.length < 16 || auth.length > 64) return null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

module.exports = { parseSubscription };
