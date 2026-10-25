const { displayName } = require('../users');
const { translator } = require('../i18n');

// What a phone notification says. Pure (no DB), so it is unit-tested on its
// own; src/push/index.js feeds it the notification row.

const EXCERPT_CHARS = 120;

// One line of the comment: phones show a line or two, and a push payload
// must stay small (the services cap it at about 4 KB).
function excerpt(text, max = EXCERPT_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// n: a notification joined with its comment and author (kind, body, spoiler,
// author_name, author_email); lang: the recipient's language; url: where a
// tap leads (notifications.linkFor).
function notificationPayload(n, lang, url) {
  const t = translator(lang || 'en');
  const name = displayName({ display_name: n.author_name, email: n.author_email });
  let title;
  if (n.kind === 'reply') title = t('{name} replied to your comment', { name });
  else if (n.kind === 'mention') title = t('{name} mentioned you', { name });
  else title = t('New notification from {name}', { name });
  // a spoiler's text must not show up on a lock screen
  const body = n.spoiler ? t('Spoiler — open it to read') : excerpt(n.body);
  return { title, body, url };
}

module.exports = { excerpt, notificationPayload, EXCERPT_CHARS };
