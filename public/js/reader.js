(function () {
  'use strict';

  var R = window.__READER__;
  var params = new URLSearchParams(location.search);

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

  /* ---------- offline reading (service worker: public/sw.js) ---------- */

  // A copy saved for offline reading has stale bookmark state: treat it as a peek.
  if (window.__BF_SAVED_COPY__ && R.bookmark) {
    R.bookmark = { action: 'peek', bmIdx: R.bookmark.bmIdx };
    var staleBanner = document.getElementById('bm-banner');
    if (staleBanner) staleBanner.remove();
  }
  // Offline, comment forms can't send: say so instead of losing the text.
  document.addEventListener('submit', function (event) {
    if (navigator.onLine !== false || !event.target.classList.contains('comment-form')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.alert(t('Comments need an internet connection.'));
  }, true);
  // A position save that failed offline is retried once the connection is back.
  window.addEventListener('online', function () {
    if (!positionArmed) return;
    lastSavedPara = -1;
    savePosition(false);
  });

  var panel = document.getElementById('comment-panel');
  var backdrop = document.getElementById('panel-backdrop');
  var panelState = { para: null, sort: 'top' };
  var chapterSort = 'top';

  /* ---------- bar placement ---------- */

  // With a mouse the reader bar sits under the nav (the macOS Dock covers the
  // bottom edge); app.css places it from these heights, measured first.
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

  function button(className, text, onClick) {
    var node = el('button', className, text);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
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
    }).catch(function () {
      // no connection (see "offline reading" above): a readable message, not "Failed to fetch"
      throw new Error(/comments/.test(url) ? t('Comments need an internet connection.') : t("You're offline. This needs an internet connection."));
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


  /* ---------- comment text: @mention highlights + spoiler blur ---------- */

  // As in src/comments/mentions.js: a letter, digit or _ touching the "@" or
  // the end of the name glues it into a word (an email, a longer name).
  var WORD_CHAR = /[\p{L}\p{N}_]/u;
  function isWordChar(ch) { return ch !== '' && WORD_CHAR.test(ch); }

  // The body as text nodes, each @Name the server matched (`mentions`, as
  // written) in a span.mention. Text nodes only: never HTML from a comment.
  function bodyNodes(text, mentions) {
    var frag = document.createDocumentFragment();
    var names = (mentions || []).slice().sort(function (a, b) { return b.length - a.length; });
    var start = 0;
    var at = names.length ? text.indexOf('@') : -1;
    while (at !== -1) {
      var next = at + 1;
      if (!isWordChar(text.charAt(at - 1))) {
        for (var i = 0; i < names.length; i++) {
          var end = at + 1 + names[i].length;
          if (text.slice(at + 1, end).toLowerCase() === names[i].toLowerCase() && !isWordChar(text.charAt(end))) {
            if (at > start) frag.appendChild(document.createTextNode(text.slice(start, at)));
            frag.appendChild(el('span', 'mention', text.slice(at, end)));
            start = next = end;
            break;
          }
        }
      }
      at = text.indexOf('@', next);
    }
    if (start < text.length) frag.appendChild(document.createTextNode(text.slice(start)));
    return frag;
  }

  // Under a spoiler's blur: same word shapes, other letters (blur alone can be
  // read back, and real words would still be copyable / findable).
  var SPOILER_PREVIEW = 280;
  function scramble(text) {
    var letters = 'etaoinshrdlucmfwyp';
    var shown = text.slice(0, SPOILER_PREVIEW);
    var out = '';
    for (var i = 0; i < shown.length; i++) {
      var ch = shown.charAt(i);
      out += /\s/.test(ch) ? ch : letters.charAt((i * 7 + shown.charCodeAt(i)) % letters.length);
    }
    return out;
  }

  // Revealed spoilers stay revealed when a list reloads (after a reply...).
  var revealedSpoilers = {};

  function fillBody(body, comment) {
    body.textContent = '';
    if (!comment.spoiler || revealedSpoilers[comment.id]) {
      body.classList.remove('is-spoiler');
      body.appendChild(bodyNodes(comment.body, comment.mentions));
      return;
    }
    body.classList.add('is-spoiler');
    var hidden = el('span', 'spoiler-text', scramble(comment.body));
    hidden.setAttribute('aria-hidden', 'true');
    var reveal = button('spoiler-reveal', undefined, function () {
      revealedSpoilers[comment.id] = true;
      fillBody(body, comment);
      body.focus({ preventScroll: true }); // the button is gone: keep keyboard focus here
    });
    reveal.appendChild(el('span', 'spoiler-label', topBarQuery.matches ? t('Spoiler — click to show') : t('Spoiler — tap to show')));
    body.appendChild(hidden);
    body.appendChild(reveal);
  }

  /* ---------- badges ---------- */

  function makeBadge(paraIndex) {
    var count = R.badgeCounts[paraIndex] || 0;
    var badge = button('para-badge' + (count > 0 ? ' has-comments' : ''), String(count), function () { openPanel(paraIndex); });
    badge.setAttribute('data-badge-for', paraIndex);
    badge.setAttribute('aria-label', t.n('{count} comment on this paragraph', '{count} comments on this paragraph', count));
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
    var avatar = el('div', 'comment-avatar avatar-' + comment.tone, comment.initial);
    var main = el('div', 'comment-main');

    var head = el('div', 'comment-head');
    head.appendChild(el('span', 'comment-user', comment.userName));
    head.appendChild(el('span', 'comment-time', relTime(comment.createdAt) + (comment.edited ? ' · ' + t('edited') : '')));
    if (comment.spoiler) head.appendChild(el('span', 'spoiler-tag', t('Spoiler')));
    main.appendChild(head);

    var body = el('div', 'comment-body');
    if (comment.spoiler) body.tabIndex = -1;
    fillBody(body, comment);
    main.appendChild(body);

    var actions = el('div', 'comment-actions');
    var like = button('vote-btn' + (comment.myVote === 1 ? ' active' : ''), '👍 ' + comment.likes, function () { voteOn(comment.id, 1, like, dislike); });
    var dislike = button('vote-btn' + (comment.myVote === -1 ? ' active' : ''), '👎 ' + comment.dislikes, function () { voteOn(comment.id, -1, like, dislike); });
    like.disabled = dislike.disabled = !R.user;
    actions.appendChild(like);
    actions.appendChild(dislike);

    if (R.user) {
      actions.appendChild(button('link-btn', t('Reply'), function () {
        var existing = main.querySelector('.reply-form');
        if (existing) { existing.remove(); return; }
        main.appendChild(buildForm({
          placeholder: t('Write a reply…'),
          submitLabel: t('Reply'),
          className: 'reply-form',
          onSubmit: function (text, spoiler) {
            return postComment(text, ctx.para, comment.id, spoiler).then(function () { ctx.reload(); });
          },
        }));
      }));
    }
    if (comment.canEdit) {
      actions.appendChild(button('link-btn', t('Edit'), function () {
        var existing = main.querySelector('.edit-form');
        if (existing) { existing.remove(); return; }
        main.appendChild(buildForm({
          placeholder: '', initial: comment.body, spoiler: comment.spoiler, submitLabel: t('Save'), className: 'edit-form',
          onSubmit: function (text, spoiler) {
            return api('PATCH', '/api/comments/' + comment.id, { body: text, spoiler: spoiler }).then(function () { ctx.reload(); });
          },
        }));
      }));
    }
    if (comment.canDelete) {
      actions.appendChild(button('link-btn danger', t('Delete'), function () {
        if (!window.confirm(t('Delete this comment?'))) return;
        api('DELETE', '/api/comments/' + comment.id).then(function () { ctx.reload(); });
      }));
    }
    main.appendChild(actions);

    if (comment.replies.length > 0) {
      var replyCount = { count: comment.replies.length };
      var repliesBox = el('div', 'comment-replies');
      comment.replies.forEach(function (child) { repliesBox.appendChild(renderComment(child, ctx)); });
      var toggle = button('link-btn view-replies', t('Hide replies ({count})', replyCount) + ' ▴', function () {
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
    // a real checkbox (keyboard, screen readers), drawn as a pill by app.css
    var spoilerToggle = el('label', 'spoiler-toggle');
    spoilerToggle.title = t('Blur this comment until someone chooses to read it');
    var spoilerCheck = el('input', 'spoiler-check');
    spoilerCheck.type = 'checkbox';
    spoilerCheck.checked = !!opts.spoiler;
    spoilerToggle.appendChild(spoilerCheck);
    spoilerToggle.appendChild(el('span', 'spoiler-pill', t('Spoiler')));
    var row = el('div', 'comment-form-row');
    row.appendChild(submit);
    row.appendChild(spoilerToggle);
    form.appendChild(textarea);
    form.appendChild(row);
    attachMentions(textarea, form);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var text = textarea.value.trim();
      if (!text) return;
      submit.disabled = true;
      opts.onSubmit(text, spoilerCheck.checked).then(function () {
        textarea.value = '';
        spoilerCheck.checked = false;
        submit.disabled = false;
      }).catch(function (err) {
        submit.disabled = false;
        window.alert(err.message);
      });
    });
    return form;
  }

  /* ---------- @mention suggestions while typing ---------- */

  var mentionCache = {}; // query -> [{ id, name }], for this page view
  var mentionLists = 0;
  var openMention = null; // the form whose list is showing, to re-place it

  // The "@query" at the caret, if any: { at, caret, q } (names may have spaces).
  function mentionQuery(textarea) {
    var caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return null;
    var before = textarea.value.slice(0, caret);
    var at = before.lastIndexOf('@');
    if (at === -1 || caret - at > 32 || isWordChar(before.charAt(at - 1))) return null;
    var q = before.slice(at + 1);
    if (/^\s|\n/.test(q)) return null;
    return { at: at, caret: caret, q: q };
  }

  function attachMentions(textarea, form) {
    var list = el('ul', 'mention-list');
    list.id = 'mention-list-' + (++mentionLists);
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', t('People to mention'));
    list.hidden = true;
    // keep the focus, and the phone's keyboard, in the textarea
    list.addEventListener('mousedown', function (event) { event.preventDefault(); });
    form.appendChild(list);
    textarea.setAttribute('aria-autocomplete', 'list');
    textarea.setAttribute('aria-controls', list.id);
    textarea.setAttribute('aria-expanded', 'false');

    var people = [];
    var active = 0;
    var current = null;
    var timer = null;
    // after a pick or Escape, this "@" stays quiet: { at, name } (name '' = Escape)
    var quiet = null;
    var handle = { place: place };

    function close() {
      clearTimeout(timer);
      list.hidden = true;
      current = null;
      if (openMention === handle) openMention = null;
      textarea.setAttribute('aria-expanded', 'false');
      textarea.removeAttribute('aria-activedescendant');
    }

    function setActive(index) {
      active = index;
      Array.prototype.forEach.call(list.children, function (item, i) {
        item.classList.toggle('active', i === index);
        item.setAttribute('aria-selected', i === index ? 'true' : 'false');
      });
      var item = list.children[index];
      if (!item) return;
      textarea.setAttribute('aria-activedescendant', item.id);
      // scroll the list only (scrollIntoView could move the whole page)
      if (item.offsetTop < list.scrollTop) list.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = item.offsetTop + item.offsetHeight - list.clientHeight;
      }
    }

    // Under the textarea, unless the on-screen keyboard (or the window's
    // bottom edge) leaves more room above it.
    function place() {
      var rect = textarea.getBoundingClientRect();
      var vv = window.visualViewport;
      var visibleTop = Math.max(coveredTop(), vv ? vv.offsetTop : 0);
      var visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      var below = visibleBottom - rect.bottom - 12;
      var above = rect.top - visibleTop - 12;
      var full = people.length * 44 + 10;
      var under = below >= Math.min(full, 140) || below >= above;
      list.style.top = under ? (textarea.offsetTop + textarea.offsetHeight + 4) + 'px' : '';
      list.style.bottom = under ? '' : (form.offsetHeight - textarea.offsetTop + 4) + 'px';
      list.style.maxHeight = Math.max(under ? below : above, 96) + 'px';
    }

    function show(found) {
      people = found;
      if (!people.length) return close();
      list.textContent = '';
      people.forEach(function (person, i) {
        var item = el('li', 'mention-option');
        item.id = list.id + '-' + i;
        item.setAttribute('role', 'option');
        item.appendChild(el('span', 'comment-avatar avatar-' + person.tone, person.initial));
        item.appendChild(el('span', 'mention-name', person.name));
        item.addEventListener('click', function () { pick(person); });
        list.appendChild(item);
      });
      list.hidden = false;
      openMention = handle;
      textarea.setAttribute('aria-expanded', 'true');
      setActive(0);
      place();
    }

    function pick(person) {
      if (!current) return;
      var after = textarea.value.slice(current.caret);
      var spaced = /^\s/.test(after);
      textarea.value = textarea.value.slice(0, current.at) + '@' + person.name + (spaced ? '' : ' ') + after;
      var caret = current.at + person.name.length + 2;
      textarea.setSelectionRange(caret, caret);
      quiet = { at: current.at, name: person.name.toLowerCase() };
      close();
      textarea.focus();
    }

    function update() {
      var query = mentionQuery(textarea);
      if (!query) quiet = null; // the caret left that "@": a new one may list again
      else if (quiet && query.at === quiet.at && query.q.toLowerCase().indexOf(quiet.name) === 0) query = null;
      if (!query) return close();
      current = query;
      clearTimeout(timer);
      if (mentionCache[query.q]) return show(mentionCache[query.q]);
      // a query nobody's name contains can't start matching by typing more
      for (var known in mentionCache) {
        if (!mentionCache[known].length && query.q.indexOf(known) === 0) return close();
      }
      timer = setTimeout(function () {
        api('GET', '/api/mentions?q=' + encodeURIComponent(query.q)).then(function (found) {
          mentionCache[query.q] = found;
          var now = mentionQuery(textarea);
          if (now && now.q === query.q && document.activeElement === textarea) {
            current = now;
            show(found);
          }
        }).catch(close);
      }, 120);
    }

    // Typing opens the list; moving the caret only re-checks an open one
    // (clicking into an existing "@Name" while editing shouldn't pop it up).
    textarea.addEventListener('input', update);
    textarea.addEventListener('click', function () { if (!list.hidden) update(); });
    textarea.addEventListener('keyup', function (event) {
      if (!list.hidden && /^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) update();
    });
    textarea.addEventListener('blur', close);
    textarea.addEventListener('keydown', function (event) {
      if (list.hidden || event.isComposing) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((active + (event.key === 'ArrowDown' ? 1 : people.length - 1)) % people.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        pick(people[active]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation(); // close just the list, not the comment panel
        if (current) quiet = { at: current.at, name: '' };
        close();
      }
    });
  }

  if (window.visualViewport) {
    // the phone keyboard opening or closing changes which side has room
    window.visualViewport.addEventListener('resize', function () { if (openMention) openMention.place(); });
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

  function postComment(body, para, parentId, spoiler) {
    return api('POST', '/api/chapter/' + R.chapterId + '/comments', {
      body: body,
      para_index: para,
      parent_id: parentId || null,
      spoiler: !!spoiler,
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
      onSubmit: function (text, spoiler) { return postComment(text, panelState.para, null, spoiler).then(panelCtx().reload); },
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
    // ← / → change chapter, except in form fields, with modifiers (Alt+← is
    // history) or with the comment panel open.
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
    onSubmit: function (text, spoiler) { return postComment(text, null, null, spoiler).then(chapterCtx().reload); },
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
  // Positions are only saved while the bookmark is on this chapter (the server re-checks).
  var positionArmed = !!(R.user && R.bookmark
    && (R.bookmark.action === 'advanced' || R.bookmark.action === 'same') && paraNodes.length);
  var lastSavedPara = (R.bookmark && R.bookmark.action === 'same' && R.bookmark.para) || 0;
  // A notification link jumps to a comment, not to where the reader is:
  // saving starts only once they scroll themselves.
  if (positionArmed && (params.has('panel') || location.hash)) {
    positionArmed = false;
    var holdForDeepLink = true;
    ['wheel', 'touchmove', 'keydown'].forEach(function (evt) {
      window.addEventListener(evt, function (event) {
        if (!holdForDeepLink) return;
        if (panel && !panel.hidden && panel.contains(event.target)) return; // scrolling the comments
        holdForDeepLink = false;
        positionArmed = true;
      }, { passive: true });
    });
  }

  // How far down the screen the bars reach right now: the nav, plus the
  // reader bar when it sits on top. A bar slid out of view covers nothing.
  function coveredTop() {
    var edge = topNav ? topNav.getBoundingClientRect().bottom : 0;
    if (topBarQuery.matches && bottomBar) edge = Math.max(edge, bottomBar.getBoundingClientRect().bottom);
    return Math.max(0, edge);
  }

  // The topmost paragraph with READ_LINE px showing below the bars: the end of
  // the one above a resumed paragraph peeks out, and counting it made the
  // saved position creep back a paragraph per visit.
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
  var panelParam = params.get('panel');
  if (panelParam !== null && Number.isInteger(Number(panelParam)) && Number(panelParam) >= 0) {
    var panelBlock = document.querySelector('#chapter-content [data-p="' + Number(panelParam) + '"]');
    if (panelBlock) panelBlock.scrollIntoView();
    openPanel(Number(panelParam));
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
  // 20/24 px matches Wuxiaworld as the owner reads it; `v` marks settings saved since.
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
    // Older saves: exactly the old 18/30 defaults means "never changed".
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
  // Only the reader's own scrolling hides the bars: before a touch/wheel/key,
  // scrolls are the page's (jumps; cached images + scroll anchoring), and
  // hiding the bars then made currentPara() save the paragraph above.
  var readerScrolled = false;
  ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (evt) {
    window.addEventListener(evt, function () { readerScrolled = true; }, { passive: true, once: true });
  });
  window.addEventListener('scroll', function () {
    var y = Math.max(0, window.scrollY); // iOS overscroll reports negative values
    if (!readerScrolled) { lastScrollY = y; return; }
    if (Math.abs(y - lastScrollY) < 8) return;
    // keep the bars while the font panel is open so it never floats detached
    var hide = y > lastScrollY && y > 80 && fontPanel.hidden;
    if (topNav) topNav.classList.toggle('nav-hidden', hide);
    if (bottomBar) bottomBar.classList.toggle('bar-hidden', hide);
    lastScrollY = y;
  }, { passive: true });

  // Mobile toolbars (Samsung Internet, Chrome's bottom bar) cover the page
  // without safe-area insets: lift the bar by what visualViewport says is hidden.
  if (bottomBar && window.visualViewport) {
    var vv = window.visualViewport;
    var vvRaf = null;
    // No toolbar is this tall: a bigger reading is the keyboard or toolbars
    // mid-slide (it flung the bar up the screen). Keep the last good lift.
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
      // pinch-zoomed: no lift; offsetTop goes negative while overscrolling
      var covered = vv.scale > 1.01 ? 0 : Math.max(0, window.innerHeight - (Math.max(0, vv.offsetTop) + vv.height));
      // a safe-area inset already lifts it via the CSS padding: don't lift twice
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

  /* ---------- where the chapter opens: a search result (?p=), else the saved paragraph ---------- */

  // `block` just under the bars, again after images load unless the reader
  // moved; lastScrollY keeps the bars shown (coveredTop() then matches).
  function jumpTo(block) {
    var touched = false;
    ['wheel', 'touchstart', 'keydown'].forEach(function (evt) {
      window.addEventListener(evt, function () { touched = true; }, { passive: true, once: true });
    });
    var jump = function () {
      window.scrollTo(0, block.getBoundingClientRect().top + window.scrollY - coveredTop() - 8);
      lastScrollY = Math.max(0, window.scrollY);
    };
    jump();
    window.addEventListener('load', function () { if (!touched) jump(); });
  }

  var searchPara = params.get('p');
  var searchBlock = searchPara !== null && /^\d+$/.test(searchPara)
    ? document.querySelector('#chapter-content [data-p="' + Number(searchPara) + '"]') : null;
  if (searchBlock) {
    positionArmed = false; // looking at a search result is not reading progress
    markSearchTerms(searchBlock, params.get('q') || '');
    jumpTo(searchBlock);
    searchBlock.classList.add('search-target');
  } else if (panelParam === null && !location.hash && R.bookmark && R.bookmark.action === 'same' && R.bookmark.para > 0) {
    var resumeTarget = document.querySelector('#chapter-content [data-p="' + R.bookmark.para + '"]');
    if (resumeTarget) jumpTo(resumeTarget);
  }

  // Lower-case and drop accents, so "joao" marks "João" as the search
  // found it (SQLite's remove_diacritics). Per character, for offsets.
  function foldChar(ch) {
    return ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  // <mark>s the searched words (text nodes only), as the search matched them.
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

  // A clear horizontal flick turns the page. Ignored at screen edges (Android
  // back), on controls, in sideways scrollers, while zoomed/selecting or with a panel open.
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
    var url = dx < 0 ? R.nextUrl : R.prevUrl;
    // From a peek (notification / search result ahead of the bookmark) a
    // stray swipe mustn't drag the bookmark along; the buttons still do.
    if (url && R.bookmark && R.bookmark.action === 'peek') url += (url.indexOf('?') < 0 ? '?' : '&') + 'peek=1';
    return url;
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
