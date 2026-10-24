(function () {
  'use strict';

  var R = window.__READER__;

  /* ---------- translations (English text is the key; reader.ejs embeds the rest) ---------- */

  var I18N = window.__I18N__ || { lang: 'en', strings: {} };
  function t(key, vars) {
    var text = I18N.strings[key] || key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) { return name in vars ? String(vars[name]) : match; });
  }
  t.n = function (one, other, count) { return t(count === 1 ? one : other, { count: count }); };
  // A translated sentence with {placeholders} filled by DOM nodes (e.g. links).
  function tNodes(key, nodes) {
    var frag = document.createDocumentFragment();
    t(key).split(/(\{\w+\})/).forEach(function (part) {
      var name = /^\{(\w+)\}$/.exec(part);
      frag.appendChild(name && nodes[name[1]] ? nodes[name[1]] : document.createTextNode(part));
    });
    return frag;
  }
  var panel = document.getElementById('comment-panel');
  var backdrop = document.getElementById('panel-backdrop');
  var panelState = { para: null, sort: 'top' };
  var chapterSort = 'top';

  /* ---------- bar placement ---------- */

  // With a mouse or trackpad app.css moves the bottom bar to the top, under
  // the nav (the macOS Dock / Windows taskbar pop up over the bottom edge).
  // It is positioned from these measured heights, kept current as they
  // change; measured first so the scroll jumps below already account for it.
  var topBarQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
  var topNav = document.querySelector('.nav');
  var bottomBar = document.querySelector('.reader-bottombar');
  var measureBars = function () {
    var rootStyle = document.documentElement.style;
    if (topNav) rootStyle.setProperty('--nav-h', topNav.offsetHeight + 'px');
    if (bottomBar) rootStyle.setProperty('--bar-h', bottomBar.offsetHeight + 'px');
  };
  // Some languages' "Prev"/"Next" don't fit a narrow phone's bar: show just
  // the arrows then (app.css hides .bar-label in .bar-compact).
  var fitBar = function () {
    if (!bottomBar) return;
    bottomBar.classList.remove('bar-compact');
    if (bottomBar.scrollWidth > bottomBar.clientWidth) bottomBar.classList.add('bar-compact');
  };
  fitBar();
  window.addEventListener('resize', fitBar);
  measureBars();
  if (window.ResizeObserver) {
    var barObserver = new ResizeObserver(measureBars);
    if (topNav) barObserver.observe(topNav);
    if (bottomBar) barObserver.observe(bottomBar);
  } else {
    window.addEventListener('resize', measureBars);
  }

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function relTime(ts) {
    if (!window.Intl || !Intl.RelativeTimeFormat) return new Date(ts).toLocaleDateString(I18N.lang);
    var rtf = new Intl.RelativeTimeFormat(I18N.lang, { numeric: 'auto' });
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return rtf.format(0, 'second');
    var m = Math.floor(s / 60);
    if (m < 60) return rtf.format(-m, 'minute');
    var h = Math.floor(m / 60);
    if (h < 24) return rtf.format(-h, 'hour');
    var d = Math.floor(h / 24);
    if (d < 30) return rtf.format(-d, 'day');
    var mo = Math.floor(d / 30);
    if (mo < 12) return rtf.format(-mo, 'month');
    return rtf.format(-Math.floor(mo / 12), 'year');
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

  function anchorQuery(para) {
    return para === null ? 'chapter' : String(para);
  }

  /* ---------- badges ---------- */

  function makeBadge(paraIndex) {
    var count = R.badgeCounts[paraIndex] || 0;
    var badge = el('button', 'para-badge' + (count > 0 ? ' has-comments' : ''), String(count));
    badge.type = 'button';
    badge.setAttribute('data-badge-for', paraIndex);
    badge.setAttribute('aria-label', t.n('{count} comment on this paragraph', '{count} comments on this paragraph', count));
    badge.addEventListener('click', function () { openPanel(paraIndex); });
    return badge;
  }

  document.querySelectorAll('#chapter-content [data-p]').forEach(function (block) {
    block.appendChild(makeBadge(Number(block.getAttribute('data-p'))));
  });

  function bumpBadge(paraIndex) {
    R.badgeCounts[paraIndex] = (R.badgeCounts[paraIndex] || 0) + 1;
    var badge = document.querySelector('[data-badge-for="' + paraIndex + '"]');
    if (badge) {
      badge.textContent = String(R.badgeCounts[paraIndex]);
      badge.classList.add('has-comments');
    }
  }

  /* ---------- comment rendering ---------- */

  function renderComment(comment, ctx) {
    var card = el('div', 'comment');
    var tone = 0; // same name, same avatar colour
    for (var i = 0; i < comment.userName.length; i++) tone = (tone * 31 + comment.userName.charCodeAt(i)) % 5;
    var avatar = el('div', 'comment-avatar avatar-' + tone, comment.userName.charAt(0).toUpperCase());
    var main = el('div', 'comment-main');

    var head = el('div', 'comment-head');
    head.appendChild(el('span', 'comment-user', comment.userName));
    head.appendChild(el('span', 'comment-time', relTime(comment.createdAt) + (comment.edited ? ' · ' + t('edited') : '')));
    main.appendChild(head);

    var body = el('div', 'comment-body', comment.body);
    main.appendChild(body);

    var actions = el('div', 'comment-actions');
    var like = el('button', 'vote-btn' + (comment.myVote === 1 ? ' active' : ''), '👍 ' + comment.likes);
    var dislike = el('button', 'vote-btn' + (comment.myVote === -1 ? ' active' : ''), '👎 ' + comment.dislikes);
    like.type = 'button';
    dislike.type = 'button';
    if (R.user) {
      like.addEventListener('click', function () { voteOn(comment.id, 1, like, dislike); });
      dislike.addEventListener('click', function () { voteOn(comment.id, -1, like, dislike); });
    } else {
      like.disabled = true;
      dislike.disabled = true;
    }
    actions.appendChild(like);
    actions.appendChild(dislike);

    if (R.user) {
      var reply = el('button', 'link-btn', t('Reply'));
      reply.type = 'button';
      reply.addEventListener('click', function () {
        var existing = main.querySelector('.reply-form');
        if (existing) { existing.remove(); return; }
        main.appendChild(buildForm({
          placeholder: t('Write a reply…'),
          submitLabel: t('Reply'),
          className: 'reply-form',
          onSubmit: function (text) {
            return postComment(text, ctx.para, comment.id).then(function () { ctx.reload(); });
          },
        }));
      });
      actions.appendChild(reply);
    }
    if (comment.canEdit) {
      var edit = el('button', 'link-btn', t('Edit'));
      edit.type = 'button';
      edit.addEventListener('click', function () {
        var existing = main.querySelector('.edit-form');
        if (existing) { existing.remove(); return; }
        main.appendChild(buildForm({
          placeholder: '', initial: comment.body, submitLabel: t('Save'), className: 'edit-form',
          onSubmit: function (text) {
            return api('PATCH', '/api/comments/' + comment.id, { body: text }).then(function () { ctx.reload(); });
          },
        }));
      });
      actions.appendChild(edit);
    }
    if (comment.canDelete) {
      var del = el('button', 'link-btn danger', t('Delete'));
      del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm(t('Delete this comment?'))) return;
        api('DELETE', '/api/comments/' + comment.id).then(function () { ctx.reload(); });
      });
      actions.appendChild(del);
    }
    main.appendChild(actions);

    if (comment.replies.length > 0) {
      var replyCount = { count: comment.replies.length };
      var toggle = el('button', 'link-btn view-replies', t('View replies ({count})', replyCount) + ' ▾');
      toggle.type = 'button';
      var repliesBox = el('div', 'comment-replies');
      repliesBox.hidden = true;
      comment.replies.forEach(function (child) { repliesBox.appendChild(renderComment(child, ctx)); });
      toggle.addEventListener('click', function () {
        repliesBox.hidden = !repliesBox.hidden;
        toggle.textContent = repliesBox.hidden ? t('View replies ({count})', replyCount) + ' ▾' : t('Hide replies ({count})', replyCount) + ' ▴';
      });
      main.appendChild(toggle);
      main.appendChild(repliesBox);
    }

    card.appendChild(avatar);
    card.appendChild(main);
    return card;
  }

  function voteOn(commentId, value, likeBtn, dislikeBtn) {
    api('POST', '/api/comments/' + commentId + '/vote', { value: value }).then(function (res) {
      likeBtn.textContent = '👍 ' + res.likes;
      dislikeBtn.textContent = '👎 ' + res.dislikes;
      likeBtn.classList.toggle('active', res.myVote === 1);
      dislikeBtn.classList.toggle('active', res.myVote === -1);
    }).catch(function (err) { window.alert(err.message); });
  }

  function buildForm(opts) {
    var form = el('form', 'comment-form ' + (opts.className || ''));
    var textarea = el('textarea');
    textarea.placeholder = opts.placeholder || t('Add a comment');
    textarea.required = true;
    if (opts.initial) textarea.value = opts.initial;
    var submit = el('button', 'btn', opts.submitLabel || t('Submit'));
    submit.type = 'submit';
    form.appendChild(textarea);
    form.appendChild(submit);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = textarea.value.trim();
      if (!text) return;
      submit.disabled = true;
      opts.onSubmit(text).then(function () {
        textarea.value = '';
        submit.disabled = false;
      }).catch(function (err) {
        submit.disabled = false;
        window.alert(err.message);
      });
    });
    return form;
  }

  function loginPrompt() {
    var box = el('p', 'login-prompt');
    var link = el('a', null, t('Log in'));
    link.href = '/login';
    var reg = el('a', null, t('register'));
    reg.href = '/register';
    box.appendChild(tNodes('{login} or {register} to join the discussion.', { login: link, register: reg }));
    return box;
  }

  function postComment(body, para, parentId) {
    return api('POST', '/api/chapter/' + R.chapterId + '/comments', {
      body: body,
      para_index: para,
      parent_id: parentId || null,
    }).then(function (res) {
      if (!parentId && para !== null) bumpBadge(para);
      return res;
    });
  }

  function loadInto(listNode, para, sort, ctx) {
    listNode.textContent = t('Loading…');
    api('GET', '/api/chapter/' + R.chapterId + '/comments?para=' + anchorQuery(para) + '&sort=' + sort)
      .then(function (res) {
        listNode.textContent = '';
        if (res.comments.length === 0) {
          listNode.appendChild(el('p', 'empty', t('No comments yet. Be the first!')));
        }
        res.comments.forEach(function (comment) {
          listNode.appendChild(renderComment(comment, ctx));
        });
      })
      .catch(function (err) { listNode.textContent = err.message; });
  }

  /* ---------- slide-out panel (paragraph comments) ---------- */

  function panelCtx() {
    return {
      para: panelState.para,
      reload: function () { loadInto(document.getElementById('panel-list'), panelState.para, panelState.sort, panelCtx()); },
    };
  }

  function openPanel(paraIndex) {
    panelState.para = paraIndex;
    document.getElementById('panel-title').textContent = t('Paragraph {n}', { n: paraIndex + 1 });
    var formBox = document.getElementById('panel-form');
    formBox.textContent = '';
    formBox.appendChild(R.user ? buildForm({
      placeholder: t('Add a comment'),
      submitLabel: t('Submit'),
      onSubmit: function (text) { return postComment(text, panelState.para, null).then(panelCtx().reload); },
    }) : loginPrompt());
    panel.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('panel-open');
    panelCtx().reload();
  }

  function closePanel() {
    panel.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('panel-open');
  }

  document.getElementById('panel-close').addEventListener('click', closePanel);
  backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) return closePanel();
    // ← / → jump to the previous/next chapter — but not while typing in a
    // form field, holding a modifier (Alt+← is browser history), or reading
    // the comment panel (navigating would silently discard it).
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    var url = event.key === 'ArrowLeft' ? R.prevUrl : event.key === 'ArrowRight' ? R.nextUrl : null;
    if (!url || !panel.hidden) return;
    var target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    window.location.href = url;
  });
  document.getElementById('panel-sort').addEventListener('change', function (event) {
    panelState.sort = event.target.value;
    panelCtx().reload();
  });

  /* ---------- end-of-chapter comments ---------- */

  function chapterCtx() {
    return {
      para: null,
      reload: function () { loadInto(document.getElementById('chapter-comment-list'), null, chapterSort, chapterCtx()); },
    };
  }

  var chapterFormBox = document.getElementById('chapter-comment-form');
  chapterFormBox.appendChild(R.user ? buildForm({
    placeholder: t('Add a comment'),
    submitLabel: t('Submit'),
    onSubmit: function (text) { return postComment(text, null, null).then(chapterCtx().reload); },
  }) : loginPrompt());
  document.getElementById('chapter-sort').addEventListener('change', function (event) {
    chapterSort = event.target.value;
    chapterCtx().reload();
  });
  chapterCtx().reload();

  /* ---------- bookmark banner: undo auto-bookmark / bookmark older chapter ---------- */

  var bmBanner = document.getElementById('bm-banner');
  function bmConfirm(text) {
    bmBanner.textContent = '';
    bmBanner.appendChild(el('span', 'bm-icon bm-icon-ok', '✓'));
    bmBanner.appendChild(el('span', 'bm-text', text));
  }
  function refreshTocMarks(bmIdx) {
    Array.prototype.forEach.call(document.querySelectorAll('#toc-select option'), function (opt) {
      var idx = Number(opt.value.split('/').pop());
      var title = opt.textContent.replace(/^✓ /, '');
      opt.textContent = (idx <= bmIdx ? '✓ ' : '') + title;
    });
  }
  var bmUndo = document.getElementById('bm-undo');
  if (bmUndo) {
    bmUndo.addEventListener('click', function () {
      bmUndo.disabled = true;
      var prev = R.bookmark.prevIdx;
      var restore = prev === null
        ? api('DELETE', '/api/book/' + R.bookId + '/bookmark')
        : api('PUT', '/api/book/' + R.bookId + '/bookmark', { idx: prev });
      restore.then(function () {
        positionArmed = false;
        refreshTocMarks(prev === null ? -1 : prev);
        bmConfirm(prev === null ? t('Bookmark removed.') : t('Bookmark restored to where it was.'));
      }).catch(function (err) {
        bmUndo.disabled = false;
        window.alert(err.message);
      });
    });
  }
  var bmSet = document.getElementById('bm-set');
  if (bmSet) {
    bmSet.addEventListener('click', function () {
      bmSet.disabled = true;
      api('PUT', '/api/book/' + R.bookId + '/bookmark', { idx: R.chapterIdx }).then(function () {
        positionArmed = true;
        lastSavedPara = -1;
        savePosition(false);
        refreshTocMarks(R.chapterIdx);
        bmConfirm(t('Bookmarked! This is now your current chapter.'));
      }).catch(function (err) {
        bmSet.disabled = false;
        window.alert(err.message);
      });
    });
  }

  /* ---------- reading position: resume + save topmost paragraph ---------- */

  var paraNodes = Array.prototype.slice.call(document.querySelectorAll('#chapter-content [data-p]'));
  // Only push positions while the bookmark points at this chapter; the server
  // re-checks, this just avoids useless requests (e.g. after Undo or in
  // ?peek=1 pages opened from notifications).
  var positionArmed = !!(R.user && R.bookmark
    && (R.bookmark.action === 'advanced' || R.bookmark.action === 'same') && paraNodes.length);
  var lastSavedPara = (R.bookmark && R.bookmark.action === 'same' && R.bookmark.para) || 0;

  // How far down the screen the bars reach right now: the nav, plus the
  // reader bar when it sits on top. A bar slid out of view covers nothing.
  function coveredTop() {
    var edge = topNav ? topNav.getBoundingClientRect().bottom : 0;
    if (topBarQuery.matches && bottomBar) edge = Math.max(edge, bottomBar.getBoundingClientRect().bottom);
    return Math.max(0, edge);
  }

  // The topmost paragraph with at least READ_LINE px showing below the bars.
  // A resumed paragraph is placed just under the bars, so the end of the one
  // above still peeks out (hidden behind them, or in the gap); counting that
  // one moved the saved position back a paragraph on every resume-and-leave.
  var READ_LINE = 24;
  function currentPara() {
    var line = coveredTop() + READ_LINE;
    for (var i = 0; i < paraNodes.length; i++) {
      if (paraNodes[i].getBoundingClientRect().bottom > line) {
        return Number(paraNodes[i].getAttribute('data-p'));
      }
    }
    return Number(paraNodes[paraNodes.length - 1].getAttribute('data-p'));
  }

  function savePosition(unloading) {
    if (!positionArmed) return;
    var para = currentPara();
    if (para === lastSavedPara) return;
    lastSavedPara = para;
    fetch('/api/book/' + R.bookId + '/position', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idx: R.chapterIdx, para: para }),
      keepalive: !!unloading,
    }).catch(function () {});
  }

  var saveTimer = null;
  window.addEventListener('scroll', function () {
    if (!positionArmed || saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; savePosition(false); }, 3000);
  }, { passive: true });
  window.addEventListener('pagehide', function () { savePosition(true); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') savePosition(true);
  });

  // Deep link from a notification: open the right paragraph's comment panel.
  var panelParam = new URLSearchParams(location.search).get('panel');
  if (panelParam !== null && Number.isInteger(Number(panelParam)) && Number(panelParam) >= 0) {
    var panelBlock = document.querySelector('#chapter-content [data-p="' + Number(panelParam) + '"]');
    if (panelBlock) panelBlock.scrollIntoView();
    openPanel(Number(panelParam));
  }

  // Deep links (comment panel, #comments anchor, a search result's ?p=)
  // win over position resume.
  if (panelParam === null && !location.hash && !new URLSearchParams(location.search).has('p')
      && R.bookmark && R.bookmark.action === 'same' && R.bookmark.para > 0) {
    var resumeTarget = document.querySelector('#chapter-content [data-p="' + R.bookmark.para + '"]');
    if (resumeTarget) {
      var resumeInteracted = false;
      ['wheel', 'touchstart', 'keydown'].forEach(function (evt) {
        window.addEventListener(evt, function () { resumeInteracted = true; }, { passive: true, once: true });
      });
      var jumpToResume = function () {
        window.scrollTo(0, resumeTarget.getBoundingClientRect().top + window.scrollY - coveredTop() - 8);
        // Not a reader scroll: keep the bars shown, so coveredTop() still
        // matches what was measured here when the position is saved.
        lastScrollY = Math.max(0, window.scrollY);
      };
      jumpToResume();
      // Images above the target can shift the layout as they load; re-align
      // once everything has loaded, unless the reader already scrolled away.
      window.addEventListener('load', function () { if (!resumeInteracted) jumpToResume(); });
    }
  }

  /* ---------- reading settings: P badge toggle + tT font panel ---------- */

  var article = document.getElementById('chapter-content');
  var SETTINGS_KEY = 'bf-reader-settings';
  var SYSTEM_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  var FONTS = {
    opensans: '"Open Sans", ' + SYSTEM_SANS,
    sourceserif: '"Source Serif 4", Georgia, "Times New Roman", serif',
    inter: '"Inter", ' + SYSTEM_SANS,
    merriweather: '"Merriweather", Georgia, "Times New Roman", serif',
    lato: '"Lato", ' + SYSTEM_SANS,
    montserrat: '"Montserrat", ' + SYSTEM_SANS,
  };
  // Text size and line height match Wuxiaworld's reader as the owner uses
  // it: 20 px text on 24 px lines (measured from a phone screenshot). `v`
  // marks settings saved since then; see loadSettings.
  var SETTINGS_VERSION = 2;
  var DEFAULTS = { font: 'opensans', size: 20, lh: 24, contrast: 'normal', badges: true, theme: 'dark', v: SETTINGS_VERSION };
  var OLD_DEFAULT_SIZE = 18;
  var OLD_DEFAULT_LH = 30;

  function loadSettings() {
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { stored = {}; }
    var merged = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      merged[key] = stored[key] !== undefined ? stored[key] : DEFAULTS[key];
    });
    var legacySize = Number(localStorage.getItem('bf-font-size'));
    if (stored.size === undefined && legacySize) merged.size = legacySize;
    // Saved before the Wuxiaworld defaults: every visit stored the settings,
    // so exactly the old 18/30 means "never changed" and gets the new
    // defaults; any other pair was chosen by hand and stays as it was.
    if (stored.v === undefined) {
      var oldSize = stored.size !== undefined ? stored.size : (legacySize || OLD_DEFAULT_SIZE);
      var oldLh = stored.lh !== undefined ? stored.lh : OLD_DEFAULT_LH;
      var untouched = oldSize === OLD_DEFAULT_SIZE && oldLh === OLD_DEFAULT_LH;
      merged.size = untouched ? DEFAULTS.size : oldSize;
      merged.lh = untouched ? DEFAULTS.lh : oldLh;
      merged.v = SETTINGS_VERSION;
    }
    return merged;
  }

  var settings = loadSettings();
  var fontPanel = document.getElementById('font-panel');
  var fontToggle = document.getElementById('font-toggle');
  var badgesToggle = document.getElementById('badges-toggle');

  function applySettings() {
    article.style.fontFamily = FONTS[settings.font] || FONTS.opensans;
    article.style.fontSize = settings.size + 'px';
    article.style.lineHeight = settings.lh + 'px';
    document.body.classList.toggle('badges-off', !settings.badges);
    document.body.classList.toggle('high-contrast', settings.contrast === 'high');
    document.getElementById('size-value').textContent = String(settings.size);
    document.getElementById('lh-value').textContent = String(settings.lh);
    document.querySelectorAll('.font-choice').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-font') === settings.font);
    });
    document.getElementById('contrast-normal').classList.toggle('active', settings.contrast !== 'high');
    document.getElementById('contrast-high').classList.toggle('active', settings.contrast === 'high');
    document.documentElement.className =
      (settings.theme === 'light' || settings.theme === 'sepia') ? 'theme-' + settings.theme : '';
    document.querySelectorAll('.theme-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-theme') === (settings.theme || 'dark'));
    });
    badgesToggle.classList.toggle('active', settings.badges);
    badgesToggle.setAttribute('aria-pressed', settings.badges ? 'true' : 'false');
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }
  applySettings();

  function update(key, value) {
    settings[key] = value;
    applySettings();
  }

  badgesToggle.addEventListener('click', function () { update('badges', !settings.badges); });

  function toggleFontPanel(show) {
    fontPanel.hidden = !show;
    fontToggle.classList.toggle('open', show);
    fontToggle.setAttribute('aria-expanded', show ? 'true' : 'false');
  }
  fontToggle.addEventListener('click', function (event) {
    event.stopPropagation();
    toggleFontPanel(fontPanel.hidden);
  });
  document.addEventListener('click', function (event) {
    if (!fontPanel.hidden && !fontPanel.contains(event.target)) toggleFontPanel(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !fontPanel.hidden) toggleFontPanel(false);
  });

  document.querySelectorAll('.font-choice').forEach(function (btn) {
    btn.addEventListener('click', function () { update('font', btn.getAttribute('data-font')); });
  });
  document.getElementById('size-minus').addEventListener('click', function () { update('size', Math.max(12, settings.size - 1)); });
  document.getElementById('size-plus').addEventListener('click', function () { update('size', Math.min(28, settings.size + 1)); });
  document.getElementById('lh-minus').addEventListener('click', function () { update('lh', Math.max(20, settings.lh - 2)); });
  document.getElementById('lh-plus').addEventListener('click', function () { update('lh', Math.min(44, settings.lh + 2)); });
  document.getElementById('contrast-normal').addEventListener('click', function () { update('contrast', 'normal'); });
  document.getElementById('contrast-high').addEventListener('click', function () { update('contrast', 'high'); });
  document.querySelectorAll('.theme-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { update('theme', btn.getAttribute('data-theme')); });
  });
  document.getElementById('font-reset').addEventListener('click', function () {
    settings = Object.assign({}, DEFAULTS);
    applySettings();
  });

  document.getElementById('toc-select').addEventListener('change', function (event) {
    location.href = event.target.value;
  });

  /* ---------- immersive reading: hide top nav + bottom bar while scrolling down ---------- */

  var lastScrollY = Math.max(0, window.scrollY);
  window.addEventListener('scroll', function () {
    var y = Math.max(0, window.scrollY); // iOS overscroll reports negative values
    if (Math.abs(y - lastScrollY) < 8) return;
    // keep the bars while the font panel is open so it never floats detached
    var hide = y > lastScrollY && y > 80 && fontPanel.hidden;
    if (topNav) topNav.classList.toggle('nav-hidden', hide);
    if (bottomBar) bottomBar.classList.toggle('bar-hidden', hide);
    lastScrollY = y;
  }, { passive: true });

  // Some mobile browsers (Samsung Internet's toolbar, Chrome's bottom address
  // bar) overlay their UI on the page without reporting it via safe-area
  // insets. The visualViewport API exposes how much of the layout viewport is
  // actually visible, so lift the bottom bar by exactly the covered height.
  if (bottomBar && window.visualViewport) {
    var vv = window.visualViewport;
    var vvRaf = null;
    // No browser toolbar is this tall. A bigger reading is the soft keyboard,
    // or a frame where the toolbars are sliding back in (scrolling up) and the
    // two viewports haven't caught up with each other yet; following those
    // flung the bar halfway up the screen and back. Keep the last good lift.
    var MAX_TOOLBAR = 150;
    var lastGap = 0;
    var applyViewportGap = function () {
      vvRaf = null;
      // Bar on top (computers): an inline bottom would override the CSS
      // `bottom: auto` and stretch the bar down the whole screen.
      if (topBarQuery.matches) {
        bottomBar.style.bottom = '';
        fontPanel.style.bottom = '';
        return;
      }
      // While pinch-zoomed the visual viewport is a magnified slice; pinning
      // to its bottom would fling the bar around, so fall back to bottom: 0.
      // (offsetTop goes negative while overscrolling past the top of the page)
      var covered = vv.scale > 1.01 ? 0 : Math.max(0, window.innerHeight - (Math.max(0, vv.offsetTop) + vv.height));
      // Browsers that report the overlay via safe-area-inset-bottom already
      // lift the bar through its CSS padding (0.5rem base + inset); subtract
      // that so the bar is never lifted twice.
      var rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      var envInset = Math.max(0, (parseFloat(getComputedStyle(bottomBar).paddingBottom) || 0) - 0.5 * rootFont);
      var gap = covered > MAX_TOOLBAR ? lastGap : Math.max(0, covered - envInset);
      lastGap = gap;
      bottomBar.style.bottom = gap + 'px';
      fontPanel.style.bottom = 'calc(3.6rem + ' + gap + 'px + env(safe-area-inset-bottom, 0px))';
    };
    var queueViewportGap = function () {
      if (vvRaf === null) vvRaf = window.requestAnimationFrame(applyViewportGap);
    };
    vv.addEventListener('resize', queueViewportGap);
    vv.addEventListener('scroll', queueViewportGap);
    // A mouse plugged into a tablet (or one unplugged) flips the bar's side.
    if (topBarQuery.addEventListener) topBarQuery.addEventListener('change', queueViewportGap);
    else if (topBarQuery.addListener) topBarQuery.addListener(queueViewportGap);
    queueViewportGap();
  }

  /* ---------- search result links: ?p=<paragraph>&q=<words> ---------- */

  // Opened from the book's search page: put that paragraph just under the
  // bars (like the resume jump above, which ?p= overrides), flash it, and
  // mark the searched words in it. Runs after the reading settings are
  // applied, so the jump measures the final text size.
  var searchParams = new URLSearchParams(location.search);
  var searchPara = searchParams.get('p');
  var searchBlock = searchPara !== null && /^\d+$/.test(searchPara)
    ? document.querySelector('#chapter-content [data-p="' + Number(searchPara) + '"]') : null;
  if (searchBlock) {
    // a look at a search result is not reading progress (?peek=1 already
    // keeps the bookmark's chapter; this keeps its paragraph too)
    positionArmed = false;
    markSearchTerms(searchBlock, searchParams.get('q') || '');
    var searchInteracted = false;
    ['wheel', 'touchstart', 'keydown'].forEach(function (evt) {
      window.addEventListener(evt, function () { searchInteracted = true; }, { passive: true, once: true });
    });
    var jumpToSearchHit = function () {
      window.scrollTo(0, searchBlock.getBoundingClientRect().top + window.scrollY - coveredTop() - 8);
      lastScrollY = Math.max(0, window.scrollY); // not a reader scroll: keep the bars
    };
    jumpToSearchHit();
    window.addEventListener('load', function () { if (!searchInteracted) jumpToSearchHit(); });
    searchBlock.classList.add('search-target');
  }

  // Lower-case and drop accents, so "joao" marks "João" as the search
  // found it (SQLite's remove_diacritics). Per character, for offsets.
  function foldChar(ch) {
    return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  // Wraps the searched words in <mark>, touching only text nodes (never
  // the comment-count button): whole words, plus words starting with the
  // last search word, as the search itself matched them.
  function markSearchTerms(block, query) {
    var words = (query.match(/[\p{L}\p{N}]+/gu) || []).map(function (w) {
      return Array.prototype.map.call(w, foldChar).join('');
    });
    if (!words.length) return;
    var lastIsPrefix = words[words.length - 1].length >= 3 && !/"\s*$/.test(query);
    var walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    var textNodes = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentNode.closest('.para-badge')) textNodes.push(walker.currentNode);
    }
    textNodes.forEach(function (node) {
      var text = node.nodeValue;
      var folded = '';
      var starts = [];
      var ends = [];
      for (var i = 0; i < text.length; i++) {
        var width = text.codePointAt(i) > 0xffff ? 2 : 1;
        var f = foldChar(text.substr(i, width));
        for (var k = 0; k < f.length; k++) { folded += f[k]; starts.push(i); ends.push(i + width); }
        i += width - 1;
      }
      var hits = [];
      var wordRe = /[\p{L}\p{N}]+/gu;
      var m;
      while ((m = wordRe.exec(folded))) {
        var found = m[0];
        var hit = words.some(function (w, n) {
          return found === w || (lastIsPrefix && n === words.length - 1 && found.indexOf(w) === 0);
        });
        if (hit) hits.push([starts[m.index], ends[m.index + found.length - 1]]);
      }
      // from the end, so the earlier offsets in `node` stay valid
      for (var h = hits.length - 1; h >= 0; h--) {
        var range = document.createRange();
        range.setStart(node, hits[h][0]);
        range.setEnd(node, hits[h][1]);
        range.surroundContents(el('mark', 'search-term'));
      }
    });
  }

  /* ---------- swipe left/right on touch screens: next/previous chapter ---------- */

  // A clear horizontal flick turns the page, like an e-reader. Anything that
  // could mean something else is left alone: listeners are passive (vertical
  // scrolling is never blocked), and the gesture is ignored when it starts
  // at a screen edge (Android's back gesture), on a link/button/form field/
  // comment badge/the bars, inside something that scrolls sideways, while
  // pinch-zoomed or selecting text, or with the comment or font panel open.
  var SWIPE_MIN_X = 90;
  var SWIPE_RATIO = 2;
  var SWIPE_MAX_MS = 700;
  var SWIPE_EDGE = 30;
  var swipe = null;
  var swipeHint = null;

  function swipeAllowedNow() {
    var zoomed = window.visualViewport && window.visualViewport.scale > 1.01;
    var selecting = window.getSelection && String(window.getSelection()).length > 0;
    return !zoomed && !selecting && panel.hidden && fontPanel.hidden;
  }

  function swipeStartsOnControl(target) {
    if (!target || !target.closest) return true;
    // a[href]: EPUB anchors without href wrap whole paragraphs, and are text
    if (target.closest('a[href], button, input, textarea, select, label, summary, [contenteditable], .para-badge, .reader-bottombar, .nav, .font-panel, .comment-panel')) return true;
    for (var node = target; node && node !== document.body; node = node.parentElement) {
      var overflowX = getComputedStyle(node).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true;
    }
    return false;
  }

  // The chapter this gesture leads to, or null while it is no clear swipe.
  function swipeTarget(dx, dy) {
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < SWIPE_RATIO * Math.abs(dy)) return null;
    return dx < 0 ? R.nextUrl : R.prevUrl;
  }

  function showSwipeHint(url, next) {
    if (!url) {
      if (swipeHint) swipeHint.classList.remove('show');
      return;
    }
    if (!swipeHint) {
      swipeHint = el('div', 'swipe-hint');
      swipeHint.setAttribute('aria-hidden', 'true');
      document.body.appendChild(swipeHint);
    }
    swipeHint.textContent = next ? t('Next chapter') + ' ›' : '‹ ' + t('Previous chapter');
    swipeHint.classList.toggle('swipe-next', next);
    swipeHint.classList.toggle('swipe-prev', !next);
    swipeHint.classList.add('show');
  }

  if (R.prevUrl || R.nextUrl) {
    document.addEventListener('touchstart', function (event) {
      swipe = null;
      showSwipeHint(null);
      if (event.touches.length !== 1 || !swipeAllowedNow() || swipeStartsOnControl(event.target)) return;
      var touch = event.touches[0];
      if (touch.clientX < SWIPE_EDGE || touch.clientX > window.innerWidth - SWIPE_EDGE) return;
      swipe = { x: touch.clientX, y: touch.clientY, at: event.timeStamp };
    }, { passive: true });
    document.addEventListener('touchmove', function (event) {
      if (!swipe) return;
      if (event.touches.length !== 1) { swipe = null; showSwipeHint(null); return; }
      var dx = event.touches[0].clientX - swipe.x;
      showSwipeHint(swipeTarget(dx, event.touches[0].clientY - swipe.y), dx < 0);
    }, { passive: true });
    document.addEventListener('touchend', function (event) {
      if (!swipe) return;
      var start = swipe;
      swipe = null;
      showSwipeHint(null);
      var touch = event.changedTouches[0];
      var url = swipeTarget(touch.clientX - start.x, touch.clientY - start.y);
      if (url && event.touches.length === 0 && event.timeStamp - start.at <= SWIPE_MAX_MS && swipeAllowedNow()) {
        window.location.href = url;
      }
    }, { passive: true });
    document.addEventListener('touchcancel', function () { swipe = null; showSwipeHint(null); }, { passive: true });
  }
}());
