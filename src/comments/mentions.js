// @mentions: pure text logic, no database. `users` are { id, name } with
// the same name comments show (display name, else the email's prefix).

const MAX_MENTIONS = 10;
// A mention must stand on its own: "a@b.com" is an address, "@Anabela" is
// not "@Ana". Letters/digits/_ on either side glue the "@" to a word.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

const isWordChar = (ch) => ch !== '' && WORD_CHAR.test(ch);

// Who `text` mentions, in order of appearance: [{ id, name }] where `name`
// is the text as written after the "@". Case-insensitive; names may contain
// spaces, so longer names win ("@Ana Maria" is Ana Maria, not Ana). Each
// user once; at most MAX_MENTIONS (a comment can't page the whole site).
function findMentions(text, users) {
  const body = String(text || '');
  const candidates = users
    .map((u) => ({ id: u.id, name: String(u.name || '').trim() }))
    .filter((u) => u.name)
    .sort((a, b) => b.name.length - a.name.length);
  const found = [];
  const seen = new Set();
  let at = body.indexOf('@');
  while (at !== -1 && found.length < MAX_MENTIONS) {
    let next = at + 1;
    if (!isWordChar(body.charAt(at - 1))) {
      let matchedLength = 0;
      for (const user of candidates) {
        // users sharing a name are all mentioned; a shorter name can't match once a longer one did
        if (matchedLength && user.name.length !== matchedLength) break;
        const written = body.substr(at + 1, user.name.length);
        if (written.toLowerCase() !== user.name.toLowerCase()) continue;
        if (isWordChar(body.charAt(at + 1 + user.name.length))) continue;
        matchedLength = user.name.length;
        if (!seen.has(user.id) && found.length < MAX_MENTIONS) {
          seen.add(user.id);
          found.push({ id: user.id, name: written });
        }
      }
      if (matchedLength) next = at + 1 + matchedLength;
    }
    at = body.indexOf('@', next);
  }
  return found;
}

// Lowercase without accents, so "joao" finds "João" in the suggestions.
function fold(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Suggestions for what follows a typed "@": names starting with the query
// first, then a later word starting with it, then names containing it.
// Not trimmed: "ana " (after a space) only keeps names that go on.
function suggest(users, query, limit = 8) {
  const q = fold(query);
  const ranked = [];
  for (const user of users) {
    const name = fold(user.name);
    let rank;
    if (name.startsWith(q)) rank = 0;
    else if (name.includes(` ${q}`)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else continue;
    ranked.push({ rank, user });
  }
  ranked.sort((a, b) => (a.rank - b.rank) || a.user.name.localeCompare(b.user.name));
  return ranked.slice(0, limit).map((r) => ({ id: r.user.id, name: r.user.name }));
}

module.exports = { findMentions, suggest, MAX_MENTIONS };
