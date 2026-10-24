/* BookFriends service worker: offline reading and phone notifications.
   Served at /sw.js by src/offline/routes.js, which fills in the two versions
   below. Every page registers it (views/partials/footer.ejs). Setting
   SW_DISABLED=1 on the server replaces it with a worker that removes itself.

   Rule of thumb: anything not listed here goes straight to the network as if
   the worker didn't exist. Only chapters and the shelf are saved as pages,
   and only GET requests are ever touched. */
'use strict';

var VERSION = 'dev';
var ASSET_VERSION = 'dev';

// Each deploy that changes the code or the assets gets new cache names; the
// old ones are deleted when the new worker activates.
var STATIC_CACHE = 'bf-static-' + VERSION; // css/js/icons/fonts, offline page: the same for everyone
var PAGES_CACHE = 'bf-pages-' + VERSION;   // chapters + shelf: personal (your name, private books)
var MEDIA_CACHE = 'bf-media-' + VERSION;   // book images and covers: personal too (private books)
var CURRENT_CACHES = [STATIC_CACHE, PAGES_CACHE, MEDIA_CACHE];

var MAX_PAGES = 60;       // newest kept: a few MB of phone storage
var MAX_MEDIA = 120;      // illustrated editions run ~200 KB a picture: ~25 MB at most
var PREFETCH_AHEAD = 5;   // chapters saved after the one being read
// Pictures fetched ahead per chapter visit, all chapters together: an
// illustrated edition would otherwise cost ~15 MB of mobile data each time.
var PREFETCH_IMAGES = 24;
var NETWORK_TIMEOUT_MS = 8000; // a crawling connection falls back to the saved copy
var OFFLINE_URL = '/offline';
var ICON = '/android-chrome-192x192.png';

// Never answered by the worker, not even with the offline page: sign-in
// flows, the language switch's redirect, downloads, the backup, health checks.
var PASS_THROUGH = /^\/(?:api|auth|lang)(?:\/|$)|^\/backup|^\/(?:healthz|logout|sw\.js)$|^\/book\/[^/]+\/download$/;
var CHAPTER = /^\/book\/([^/]+)\/(\d+)$/;
var MEDIA = /^\/media\/book\/\d+\/(?:cover|img\/[^/]+)$/;
var ICON_FILE = /^\/(?:favicon[^/]*|android-chrome-[^/]+|apple-touch-icon[^/]*)$/;
var FINGERPRINTED = /^\/(?:css|js)\//; // with ?v=<hash> they never change
var FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// Bumped by a purge (logout): saves still in flight for the previous
// account are dropped instead of landing in the fresh cache.
var generation = 0;

function noop() {}

/* ---------- install / activate ---------- */

self.addEventListener('install', function (event) {
  self.skipWaiting();
  // Best effort: a flaky connection must not keep the worker from installing.
  // Whatever is missing gets saved the next time it is used.
  event.waitUntil(caches.open(STATIC_CACHE).then(function (cache) {
    return Promise.all([
      OFFLINE_URL,
      '/css/app.css?v=' + ASSET_VERSION,
      '/js/reader.js?v=' + ASSET_VERSION,
      ICON + '?v=' + ASSET_VERSION,
    ].map(function (url) { return cache.add(url).catch(noop); }));
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) {
      return name.indexOf('bf-') === 0 && CURRENT_CACHES.indexOf(name) === -1;
    }).map(function (name) { return caches.delete(name); }));
  }).then(function () { return self.clients.claim(); }));
});

/* ---------- fetch routing ---------- */

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  var url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (FONT_HOSTS.indexOf(url.hostname) !== -1) event.respondWith(cacheFirst(event, STATIC_CACHE, 0, true));
    return;
  }
  var path = url.pathname;
  if (PASS_THROUGH.test(path)) return;

  if (request.mode === 'navigate') {
    // Saved pages are keyed by path alone: ?peek=1 / ?panel= / ?sort= variants
    // share one copy (they are the same page).
    if (path === '/' || CHAPTER.test(path)) event.respondWith(networkFirst(event, path));
    else event.respondWith(fetch(request).catch(offlinePage));
    return;
  }
  if (MEDIA.test(path)) event.respondWith(cacheFirst(event, MEDIA_CACHE, MAX_MEDIA, false));
  else if (ICON_FILE.test(path) || (FINGERPRINTED.test(path) && url.searchParams.has('v'))) {
    event.respondWith(cacheFirst(event, STATIC_CACHE, 0, false));
  }
});

// Capped caches drop their oldest entries. Saved-at is stamped on each entry:
// keys() order can't be trusted for that (Chrome sorts by a coarse
// last-used time, so a just-saved chapter could go first).
var SAVED_AT = 'X-BF-Saved-At';

// (via a Blob: older Safari can't build a Response from another one's stream)
function stamped(response) {
  var headers = new Headers(response.headers);
  headers.set(SAVED_AT, String(Date.now()));
  return response.blob().then(function (body) {
    return new Response(body, { status: response.status, statusText: response.statusText, headers: headers });
  });
}

// One trim at a time: two working from the same list would pick the same
// victims and skip entries being written.
var trimming = Promise.resolve();
function trim(cache, max) {
  trimming = trimming.then(function () { return trimNow(cache, max); }).catch(noop);
  return trimming;
}

// Over the cap it drops to 80% of it: the scan reads every entry, so it
// should run once in a while, not on every save.
function trimNow(cache, max) {
  return cache.keys().then(function (keys) {
    if (keys.length <= max) return null;
    return Promise.all(keys.map(function (key) {
      return cache.match(key).then(function (hit) {
        // listed but not readable yet = still being written: the newest of all
        return { key: key, at: hit ? Number(hit.headers.get(SAVED_AT)) || 0 : Infinity };
      });
    })).then(function (entries) {
      entries.sort(function (a, b) { return a.at === b.at ? 0 : a.at < b.at ? -1 : 1; });
      var drop = entries.length - Math.floor(max * 0.8);
      return Promise.all(entries.slice(0, drop).map(function (entry) { return cache.delete(entry.key); }));
    });
  });
}

function store(cacheName, key, response, max, gen) {
  if (gen !== generation) return Promise.resolve();
  return Promise.all([caches.open(cacheName), max ? stamped(response) : response]).then(function (ready) {
    if (gen !== generation) return null; // purged while this was on its way
    var cache = ready[0];
    return cache.put(key, ready[1]).then(function () { return max ? trim(cache, max) : null; });
  }).catch(noop);
}

// Every cache read below falls back instead of failing: storage can break
// (quota, a browser bug), and a rejected answer would be a broken page.
function offlinePage() {
  var plain = function () {
    return new Response('You are offline.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  };
  return caches.match(OFFLINE_URL, { cacheName: STATIC_CACHE }).then(function (hit) {
    return hit || plain();
  }, plain);
}

// A saved page, flagged for reader.js: its bookmark state (Undo, position
// resume) is from when it was saved and must not be acted on. null if none.
function savedCopy(key) {
  return caches.match(key, { cacheName: PAGES_CACHE, ignoreVary: true }).then(function (hit) {
    if (!hit) return null;
    return hit.text().then(function (html) {
      return new Response(html.replace('</head>', '<script>window.__BF_SAVED_COPY__ = true;</script></head>'), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    });
  }).catch(function () { return null; });
}

function isSavablePage(response) {
  return response.status === 200 && response.type === 'basic' && !response.redirected
    && (response.headers.get('Content-Type') || '').indexOf('text/html') === 0;
}

// Chapters and the shelf: always the live page when the network answers (it
// moves the bookmark, has new comments), keeping a copy; the saved copy when
// it doesn't, or is too slow, or the server is down (5xx).
function networkFirst(event, key) {
  var gen = generation;
  var network = fetch(event.request).then(function (response) {
    if (isSavablePage(response)) {
      try {
        event.waitUntil(store(PAGES_CACHE, key, response.clone(), MAX_PAGES, gen));
      } catch { /* event already finished: skip saving this once */ }
    }
    return response;
  });
  return new Promise(function (resolve) {
    var done = false;
    var finish = function (response) {
      if (done) return;
      done = true;
      resolve(response);
    };
    var timer = setTimeout(function () {
      savedCopy(key).then(function (copy) { if (copy) finish(copy); }).catch(noop);
    }, NETWORK_TIMEOUT_MS);
    network.then(function (response) {
      if (response.status < 500) return response;
      return savedCopy(key).then(function (copy) { return copy || response; });
    }, function () {
      return savedCopy(key).then(function (copy) { return copy || offlinePage(); });
    }).catch(offlinePage).then(function (response) {
      clearTimeout(timer);
      finish(response);
    });
  });
}

// Fingerprinted assets, icons, fonts, book images: they never change at a
// given URL, so the saved copy is always good.
function cacheFirst(event, cacheName, max, cors) {
  var request = event.request;
  var gen = generation;
  // Google's font CSS is requested without CORS; asking with CORS gets a
  // readable response, which (unlike an opaque one) the browser doesn't
  // count as several MB of the phone's storage quota.
  var live = cors ? new Request(request.url, { mode: 'cors', credentials: 'omit' }) : request;
  var fromNetwork = function () {
    return fetch(live).then(function (response) {
      if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
        try {
          event.waitUntil(store(cacheName, request, response.clone(), max, gen));
        } catch { /* event already finished */ }
      }
      return response;
    });
  };
  // offline and not saved: an older fingerprint (?v=) of the same file beats none
  var olderCopy = function () {
    return caches.match(request, { ignoreSearch: true, ignoreVary: true }).then(function (old) {
      return old || Response.error();
    }, function () { return Response.error(); });
  };
  return caches.match(request, { cacheName: cacheName, ignoreVary: true }).catch(function () { return null; })
    .then(function (hit) { return hit || fromNetwork().catch(olderCopy); });
}

/* ---------- messages from pages (footer.ejs) ---------- */

self.addEventListener('message', function (event) {
  var msg = event.data || {};
  if (msg.type !== 'page') return;
  var work = Promise.resolve();
  if (msg.purge) work = work.then(purgePersonal);
  if (msg.online) {
    work = work.then(function () { return refreshOfflinePage(msg.lang); });
    if (msg.path === '/') work = work.then(saveShelf);
    work = work.then(function () { return prefetchAfter(msg.path); });
  }
  event.waitUntil(work.catch(noop));
});

// Logged out, or someone else logged in: the saved pages show the previous
// account's name and private books, and this device's notifications were
// theirs. Drop both.
function purgePersonal() {
  generation += 1;
  return Promise.all([caches.delete(PAGES_CACHE), caches.delete(MEDIA_CACHE)]).then(function () {
    return self.registration.pushManager ? self.registration.pushManager.getSubscription() : null;
  }).then(function (sub) {
    return sub ? sub.unsubscribe() : null;
  }).catch(noop);
}

// The offline page is in the language it was saved in: refetch it after a
// language switch (or if it never got saved).
function refreshOfflinePage(lang) {
  return caches.open(STATIC_CACHE).then(function (cache) {
    return cache.match(OFFLINE_URL).then(function (hit) {
      if (hit && (!lang || hit.headers.get('Content-Language') === lang)) return null;
      return cache.add(OFFLINE_URL);
    });
  }).catch(noop);
}

// The shelf is saved whenever it loads through the worker; this covers the
// very first visit, which loads before the worker is in charge. Covers too.
function saveShelf() {
  var gen = generation;
  var budget = { images: imageBudget() };
  return caches.match('/', { cacheName: PAGES_CACHE }).then(function (hit) {
    if (hit) return null;
    return fetch('/', { credentials: 'same-origin' }).then(function (response) {
      if (!isSavablePage(response)) return null;
      return response.clone().text().then(function (html) { return saveImages(html, budget); }).then(function () {
        return store(PAGES_CACHE, '/', response, MAX_PAGES, gen);
      });
    });
  }).catch(noop);
}

// Pictures are the expensive part: none when the phone asked to save data
// or is on a 2G-like connection (the chapter text is still saved).
function imageBudget() {
  var connection = self.navigator.connection;
  if (connection && (connection.saveData || /2g/.test(connection.effectiveType || ''))) return 0;
  return PREFETCH_IMAGES;
}

// Save the chapter being read and the next few, so the story goes on when
// the train enters a tunnel. Already-saved chapters are skipped (opening one
// online refreshes it); stops at the end of the book (404).
function prefetchAfter(path) {
  var match = CHAPTER.exec(path || '');
  if (!match) return Promise.resolve();
  var gen = generation;
  var budget = { images: imageBudget() };
  var idx = Number(match[2]);
  var keys = [path];
  for (var i = 1; i <= PREFETCH_AHEAD; i++) keys.push('/book/' + match[1] + '/' + (idx + i));
  return keys.reduce(function (chain, key) {
    return chain.then(function (goOn) {
      if (!goOn || gen !== generation) return false;
      return caches.match(key, { cacheName: PAGES_CACHE }).then(function (hit) {
        if (hit) return true;
        // ?peek=1 renders the chapter without moving the bookmark: the
        // server moves it forward whenever a later chapter is opened.
        return fetch(key + '?peek=1', { credentials: 'same-origin' }).then(function (response) {
          if (!isSavablePage(response)) return false;
          return response.clone().text().then(function (html) { return saveImages(html, budget); }).then(function () {
            return store(PAGES_CACHE, key, response, MAX_PAGES, gen);
          }).then(function () { return true; });
        });
      });
    });
  }, Promise.resolve(true)).catch(noop);
}

// Book illustrations in a prefetched chapter (a no-op for most chapters), or
// the covers on the shelf, while budget.images lasts.
function saveImages(html, budget) {
  var re = /src="(\/media\/book\/\d+\/(?:cover|img\/[^"]+))"/g;
  var urls = [];
  var m;
  while ((m = re.exec(html))) {
    var src = m[1].replace(/&amp;/g, '&');
    if (urls.indexOf(src) === -1) urls.push(src);
  }
  var gen = generation;
  return urls.reduce(function (chain, src) {
    return chain.then(function () {
      return caches.match(src, { cacheName: MEDIA_CACHE }).then(function (hit) {
        if (hit || budget.images <= 0) return null;
        budget.images -= 1;
        return fetch(src, { credentials: 'same-origin' }).then(function (response) {
          if (response.ok && response.type === 'basic') return store(MEDIA_CACHE, src, response, MAX_MEDIA, gen);
          return null;
        });
      });
    });
  }, Promise.resolve()).catch(noop);
}

/* ---------- phone notifications (src/push) ---------- */

self.addEventListener('push', function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'BookFriends', {
    body: data.body || '',
    icon: data.icon || ICON,
    data: { url: data.url || '/' },
  }));
});

// A tap opens the link: in a tab already showing it, else in an open
// BookFriends tab, else in a new one. Only same-site links are followed.
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    var i;
    for (i = 0; i < windows.length; i++) {
      if (windows[i].url === target.href && 'focus' in windows[i]) return windows[i].focus();
    }
    for (i = 0; i < windows.length; i++) {
      if ('navigate' in windows[i] && 'focus' in windows[i]) {
        var win = windows[i];
        return win.focus().then(function () { return win.navigate(target.href); })
          .catch(function () { return self.clients.openWindow(target.href); });
      }
    }
    return self.clients.openWindow(target.href);
  }));
});

// Browsers may replace a subscription (e.g. it expired): subscribe again with
// the same key and tell the server, so notifications keep coming.
self.addEventListener('pushsubscriptionchange', function (event) {
  var old = event.oldSubscription;
  var key = old && old.options && old.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    .then(function (sub) {
      return fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    }).catch(noop));
});
