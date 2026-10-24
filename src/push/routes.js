const express = require('express');
const { requireAuth } = require('../auth/middleware');
const { pushTestLimiter } = require('../rate-limit');
const push = require('./index');
const { parseSubscription } = require('./subscription');

const router = express.Router();
const PROD = process.env.NODE_ENV === 'production';

// The public half of the site's VAPID key: browsers need it to subscribe.
router.get('/api/push/key', (req, res) => {
  res.json({ key: push.publicKey() });
});

// The Settings card posts PushSubscription.toJSON() here when notifications
// are turned on (and again on each visit, to keep this copy current).
router.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = parseSubscription(req.body, { allowLocal: !PROD });
  if (!sub) return res.status(400).json({ error: 'bad subscription' });
  push.saveSubscription(req.user.id, sub);
  res.json({ ok: true });
});

router.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  if (typeof req.body.endpoint !== 'string') return res.status(400).json({ error: 'endpoint required' });
  push.removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true });
});

// "Send a test" waits for the push services' answers so the card can say
// whether it worked (unlike real notifications, which never hold a request).
router.post('/api/push/test', requireAuth, pushTestLimiter, (req, res) => {
  push.sendToUser(req.user.id, {
    title: req.t('Test notification'),
    body: req.t('If you can see this, phone notifications work on this device.'),
    url: '/settings',
  }).then((result) => res.json(result));
});

module.exports = router;
