(function () {
  'use strict';

  var R = window.__READER__;
  var panel = document.getElementById('comment-panel');
  var backdrop = document.getElementById('panel-backdrop');
  var panelState = { para: null, sort: 'top' };
  var chapterSort = 'top';

  /* ---------- helpers ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function relTime(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' minute' + (m === 1 ? '' : 's') + ' ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' hour' + (h === 1 ? '' : 's') + ' ago';
    var d = Math.floor(h / 24);
    if (d < 30) return d + ' day' + (d === 1 ? '' : 's') + ' ago';
    var mo = Math.floor(d / 30);
    if (mo < 12) return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
    var y = Math.floor(mo / 12);
    return y + ' year' + (y === 1 ? '' : 's') + ' ago';
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
    badge.setAttribute('aria-label', count + ' comments on this paragraph');
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
    var avatar = el('div', 'comment-avatar', comment.userName.charAt(0).toUpperCase());
    var main = el('div', 'comment-main');

    var head = el('div', 'comment-head');
    head.appendChild(el('span', 'comment-user', comment.userName));
    head.appendChild(el('span', 'comment-time', relTime(comment.createdAt) + (comment.edited ? ' · edited' : '')));
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
      var reply = el('button', 'link-btn', 'Reply');
      reply.type = 'button';
      reply.addEventListener('click', function () {
        var existing = main.querySelector('.reply-form');
        if (existing) { existing.remove(); return; }
        main.appendChild(buildForm({
          placeholder: 'Write a reply…',
          submitLabel: 'Reply',
          className: 'reply-form',
          onSubmit: function (text) {
            return postComment(text, ctx.para, comment.id).then(function () { ctx.reload(); });
          },
        }));
      });
      actions.appendChild(reply);
    }
    if (comment.canEdit) {
      var edit = el('button', 'link-btn', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', function () {
        var existing = main.querySelector('.edit-form');
        if (existing) { existing.remove(); return; }
        main.appendChild(buildForm({
          placeholder: '', initial: comment.body, submitLabel: 'Save', className: 'edit-form',
          onSubmit: function (text) {
            return api('PATCH', '/api/comments/' + comment.id, { body: text }).then(function () { ctx.reload(); });
          },
        }));
      });
      actions.appendChild(edit);
    }
    if (comment.canDelete) {
      var del = el('button', 'link-btn danger', 'Delete');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (!window.confirm('Delete this comment?')) return;
        api('DELETE', '/api/comments/' + comment.id).then(function () { ctx.reload(); });
      });
      actions.appendChild(del);
    }
    main.appendChild(actions);

    if (comment.replies.length > 0) {
      var toggle = el('button', 'link-btn view-replies', 'View replies (' + comment.replies.length + ') ▾');
      toggle.type = 'button';
      var repliesBox = el('div', 'comment-replies');
      repliesBox.hidden = true;
      comment.replies.forEach(function (child) { repliesBox.appendChild(renderComment(child, ctx)); });
      toggle.addEventListener('click', function () {
        repliesBox.hidden = !repliesBox.hidden;
        toggle.textContent = (repliesBox.hidden ? 'View replies (' : 'Hide replies (') + comment.replies.length + ')' + (repliesBox.hidden ? ' ▾' : ' ▴');
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
    textarea.placeholder = opts.placeholder || 'Add a comment';
    textarea.required = true;
    if (opts.initial) textarea.value = opts.initial;
    var submit = el('button', 'btn', opts.submitLabel || 'Submit');
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
    var link = el('a', null, 'Log in');
    link.href = '/login';
    box.appendChild(link);
    box.appendChild(document.createTextNode(' or '));
    var reg = el('a', null, 'register');
    reg.href = '/register';
    box.appendChild(reg);
    box.appendChild(document.createTextNode(' to join the discussion.'));
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
    listNode.textContent = 'Loading…';
    api('GET', '/api/chapter/' + R.chapterId + '/comments?para=' + anchorQuery(para) + '&sort=' + sort)
      .then(function (res) {
        listNode.textContent = '';
        if (res.comments.length === 0) {
          listNode.appendChild(el('p', 'empty', 'No comments yet. Be the first!'));
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
    document.getElementById('panel-title').textContent = 'Paragraph ' + (paraIndex + 1);
    var formBox = document.getElementById('panel-form');
    formBox.textContent = '';
    formBox.appendChild(R.user ? buildForm({
      placeholder: 'Add a comment',
      submitLabel: 'Submit',
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
    if (event.key === 'Escape' && !panel.hidden) closePanel();
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
    placeholder: 'Add a comment',
    submitLabel: 'Submit',
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
        bmConfirm(prev === null ? 'Bookmark removed.' : 'Bookmark restored to where it was.');
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
        bmConfirm('Bookmarked! This is now your current chapter.');
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

  function currentPara() {
    for (var i = 0; i < paraNodes.length; i++) {
      if (paraNodes[i].getBoundingClientRect().bottom > 10) {
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

  // Deep links (comment panel or #comments anchor) win over position resume.
  if (panelParam === null && !location.hash
      && R.bookmark && R.bookmark.action === 'same' && R.bookmark.para > 0) {
    var resumeTarget = document.querySelector('#chapter-content [data-p="' + R.bookmark.para + '"]');
    if (resumeTarget) {
      var resumeInteracted = false;
      ['wheel', 'touchstart', 'keydown'].forEach(function (evt) {
        window.addEventListener(evt, function () { resumeInteracted = true; }, { passive: true, once: true });
      });
      var jumpToResume = function () {
        window.scrollTo(0, resumeTarget.getBoundingClientRect().top + window.scrollY - 70);
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
  var DEFAULTS = { font: 'opensans', size: 18, lh: 30, contrast: 'normal', badges: true, theme: 'dark' };

  function loadSettings() {
    var stored = {};
    try { stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { stored = {}; }
    var merged = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      merged[key] = stored[key] !== undefined ? stored[key] : DEFAULTS[key];
    });
    var legacySize = Number(localStorage.getItem('bf-font-size'));
    if (stored.size === undefined && legacySize) merged.size = legacySize;
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

  var topNav = document.querySelector('.nav');
  var bottomBar = document.querySelector('.reader-bottombar');
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
}());
