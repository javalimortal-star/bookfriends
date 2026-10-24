/* Phone notifications on this device: the Settings card (turn on/off, send
   a test) and the hint on the notifications page. Every text comes from the
   page (translated there); this only picks which block to show. The service
   worker that receives the pushes is /sw.js (registered by footer.ejs). */
(function () {
  'use strict';

  var card = document.getElementById('push-card');
  var hint = document.getElementById('push-hint');
  if (!card && !hint) return;

  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var swOff = card && card.getAttribute('data-sw') === '0';

  // iPadOS reports itself as a Mac; a touch screen gives it away
  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error(json.error || ('HTTP ' + res.status));
        return json;
      });
    });
  }

  function keyBytes(base64url) {
    var base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function keyText(buffer) {
    var bytes = new Uint8Array(buffer);
    var raw = '';
    for (var i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // footer.ejs registers the worker; wait for it, but not forever
  function worker() {
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise(function (resolve, reject) {
        setTimeout(function () { reject(new Error('service worker not ready')); }, 15000);
      }),
    ]);
  }

  // 'on' | 'off' | 'blocked' | 'ios' | 'unsupported' | 'unavailable'.
  // sync: also re-send an existing subscription, so the server's copy belongs
  // to whoever is logged in now and survives the server forgetting it.
  function deviceState(sync) {
    if (swOff) return Promise.resolve('unavailable');
    if (!supported) return Promise.resolve(isIos() ? 'ios' : 'unsupported');
    if (Notification.permission === 'denied') return Promise.resolve('blocked');
    return worker().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return 'off';
      if (Notification.permission !== 'granted') return sub.unsubscribe().then(function () { return 'off'; });
      if (!sync) return 'on';
      return api('GET', '/api/push/key').then(function (res) {
        // made with another server key (the key file was replaced): it can never
        // receive anything again, so start over
        var used = sub.options && sub.options.applicationServerKey;
        if (used && keyText(used) !== res.key.replace(/=+$/, '')) {
          return api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(function () {})
            .then(function () { return sub.unsubscribe(); })
            .then(function () { return 'off'; });
        }
        return api('POST', '/api/push/subscribe', sub.toJSON()).then(function () { return 'on'; });
      });
    });
  }

  /* ---------- notifications page: one-line hint ---------- */

  if (hint) {
    deviceState(false).then(function (state) {
      hint.hidden = !(state === 'off' || state === 'ios');
    }).catch(function () {});
  }
  if (!card) return;

  /* ---------- Settings card ---------- */

  var msgBox = card.querySelector('.push-msg');
  function show(state) {
    Array.prototype.forEach.call(card.querySelectorAll('[data-push-state]'), function (block) {
      block.hidden = block.getAttribute('data-push-state') !== state;
    });
  }
  function say(name, error) {
    var text = card.getAttribute('data-msg-' + name) || '';
    msgBox.textContent = error ? text.replace('{error}', error) : text;
    msgBox.hidden = !text;
  }
  function busy(on) {
    Array.prototype.forEach.call(card.querySelectorAll('[data-push-action]'), function (btn) { btn.disabled = on; });
  }
  function fail(err) {
    say('error', err && err.message ? err.message : String(err));
  }

  // Safari before 15.4 only takes a callback. Must run straight from the tap:
  // iPhones refuse to ask for permission outside a user gesture.
  function askPermission() {
    return new Promise(function (resolve) {
      var answer = Notification.requestPermission(resolve);
      if (answer && answer.then) answer.then(resolve);
    });
  }

  function subscribe(reg, key) {
    var options = { userVisibleOnly: true, applicationServerKey: keyBytes(key) };
    return reg.pushManager.subscribe(options).catch(function (err) {
      // a leftover subscription made with an older key: replace it
      return reg.pushManager.getSubscription().then(function (old) {
        if (!old) throw err;
        return old.unsubscribe().then(function () { return reg.pushManager.subscribe(options); });
      });
    });
  }

  function turnOn() {
    busy(true);
    msgBox.hidden = true;
    askPermission().then(function (permission) {
      if (permission === 'denied') return show('blocked');
      if (permission !== 'granted') return say('dismissed');
      return Promise.all([worker(), api('GET', '/api/push/key')]).then(function (ready) {
        return subscribe(ready[0], ready[1].key);
      }).then(function (sub) {
        return api('POST', '/api/push/subscribe', sub.toJSON());
      }).then(function () {
        show('on');
        say('on');
      });
    }).catch(fail).then(function () { busy(false); });
  }

  function turnOff() {
    busy(true);
    msgBox.hidden = true;
    worker().then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return null;
      // the server first, so nothing more is sent even if the browser step fails
      return api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); });
    }).then(function () {
      show('off');
      say('off');
    }).catch(fail).then(function () { busy(false); });
  }

  function sendTest() {
    busy(true);
    msgBox.hidden = true;
    api('POST', '/api/push/test').then(function (res) {
      say(res.sent > 0 ? 'sent' : 'not-sent');
    }).catch(fail).then(function () { busy(false); });
  }

  card.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-push-action]');
    if (!btn || btn.disabled) return;
    var action = btn.getAttribute('data-push-action');
    if (action === 'on') turnOn();
    else if (action === 'off') turnOff();
    else if (action === 'test') sendTest();
  });

  deviceState(true).then(show).catch(function (err) {
    show('unavailable');
    fail(err);
  });
}());
