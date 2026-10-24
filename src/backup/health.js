const express = require('express');
const backups = require('./index');

const router = express.Router();

// Polled every 15 minutes by .github/workflows/uptime.yml (docs/MONITORING.md).
// The site and repo are public, so the answer is coarse states only.
router.get('/healthz', (req, res) => {
  const { status, body } = backups.health();
  res.set('Cache-Control', 'no-store');
  res.status(status).json(body);
});

module.exports = router;
