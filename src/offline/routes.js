const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

// SW_DISABLED=1 in .env is the emergency brake: browsers get a worker that
// deletes its caches and unregisters itself, and pages stop registering it.
const DISABLED = process.env.SW_DISABLED === '1';

const KILL_SWITCH = `// BookFriends: offline reading is switched off (SW_DISABLED=1).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n.indexOf('bf-') === 0; }).map(function (n) { return caches.delete(n); }));
  }).then(function () { return self.registration.unregister(); }));
});
`;

// The worker's VERSION (in its cache names) is a hash of its own code and of
// the fingerprinted assets: a deploy that changes either installs a new worker,
// which drops the old caches. Built once, on first request.
let script = null;
function workerScript(assetVersion) {
  if (script) return script;
  if (DISABLED) {
    script = KILL_SWITCH;
    return script;
  }
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'sw.js'), 'utf8');
  const version = crypto.createHash('md5').update(source).update(assetVersion).digest('hex').slice(0, 10);
  script = source
    .replace("var VERSION = 'dev';", `var VERSION = '${version}';`)
    .replace("var ASSET_VERSION = 'dev';", `var ASSET_VERSION = '${assetVersion}';`);
  return script;
}

// Served from the root so its scope is the whole site. no-cache: browsers
// must ask for it on every update check, or a fix could take a day to land.
router.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(workerScript(req.app.locals.assetVersion));
});

// Shown offline for pages that weren't saved; rendered logged out (it is
// precached), Content-Language tells the worker when to refresh it.
router.get('/offline', (req, res) => {
  res.locals.user = null;
  res.set('Content-Language', res.locals.htmlLang);
  // offlinePage: its footer must not take "logged out" for a logout (footer.ejs)
  res.render('offline', { title: req.t("You're offline"), bodyClass: 'offline-page', offlinePage: true });
});

module.exports = router;
