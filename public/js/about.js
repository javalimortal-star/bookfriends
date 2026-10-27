// BookFriends' own page (/about): the paragraph's comment bubble and spoiler,
// the phone screens' tabs and their slow crossfade, sharing the page, the
// invitation, and parts of each section rising into view once.
(function () {
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // the bubble opens and closes the paragraph's comments, as in the reader
  var toggle = document.querySelector('[data-thread-toggle]');
  var thread = document.getElementById('thread');
  if (toggle && thread) toggle.addEventListener('click', function () {
    var open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    thread.classList.toggle('is-closed', !open);
    thread.inert = !open;
  });
  document.querySelectorAll('[data-spoiler]').forEach(function (spoiler) {
    spoiler.addEventListener('click', function () {
      spoiler.classList.toggle('is-shown');
      spoiler.removeAttribute('aria-label');
    });
  });

  // the phone screens: tabs, and a slow crossfade between them while the
  // plate is in view, until a tab is chosen by hand
  var tabs = [].slice.call(document.querySelectorAll('[data-tab]'));
  var plate = document.querySelector('.plate');
  var current = 0;
  function show(i, focus) {
    loadScreens();
    current = (i + tabs.length) % tabs.length;
    tabs.forEach(function (tab, k) {
      var on = k === current;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).classList.toggle('is-on', on);
      document.querySelector('[data-shot="' + tab.dataset.tab + '"]').classList.toggle('is-on', on);
    });
    if (focus) tabs[current].focus();
  }
  // the hidden screens arrive with the plate, not with the page
  function loadScreens() {
    document.querySelectorAll('.plate [data-src]').forEach(function (img) {
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    });
  }
  var timer = null;
  var chosen = false;
  var inView = false;
  function run() {
    clearInterval(timer);
    timer = null;
    if (!still && !chosen && inView && !document.hidden) timer = setInterval(function () { show(current + 1); }, 5600);
  }
  tabs.forEach(function (tab, k) {
    tab.addEventListener('click', function () { chosen = true; run(); show(k); });
    tab.addEventListener('keydown', function (event) {
      var step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      chosen = true;
      run();
      show(current + step, true);
    });
  });
  if (plate && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      if (inView) loadScreens();
      run();
    }, { threshold: 0.4 }).observe(plate);
  }
  document.addEventListener('visibilitychange', run);

  // "Share this page": the phone's share menu, else copy the link
  var share = document.querySelector('[data-share]');
  if (share) share.addEventListener('click', function () {
    var url = location.origin + location.pathname;
    function copy() {
      if (!navigator.clipboard) return window.prompt(share.dataset.prompt, url);
      navigator.clipboard.writeText(url).then(function () {
        var label = share.textContent;
        share.textContent = share.dataset.copied;
        setTimeout(function () { share.textContent = label; }, 2000);
      }, function () { window.prompt(share.dataset.prompt, url); });
    }
    if (!navigator.share) return copy();
    navigator.share({ title: document.title, url: url }).catch(function (err) { if (err && err.name !== 'AbortError') copy(); });
  });

  // the invitation: the share menu with a message, else WhatsApp (the form
  // itself opens WhatsApp with the plain message when this never runs)
  var invite = document.querySelector('[data-invite]');
  if (invite) invite.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = invite.querySelector('.invite-name').value.trim();
    var text = name ? invite.dataset.textNamed.replace('{name}', name) : invite.dataset.text;
    var url = location.origin + '/';
    if (navigator.share) {
      navigator.share({ text: text, url: url }).catch(function () {});
    } else {
      window.open('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url), '_blank', 'noopener');
    }
  });

  // each part of a section rises in once, when it is nearly in view
  var parts = document.querySelectorAll('[data-reveal]');
  if (!('IntersectionObserver' in window)) {
    parts.forEach(function (el) { el.classList.add('is-in'); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.1 });
  parts.forEach(function (el) { io.observe(el); });
})();
