const fs = require('fs');
const path = require('path');

// English is the source language: the English text itself is the key, so a
// string without a translation still shows up (in English). Translations live
// in <code>.json next to this file; test/i18n.test.js checks they cover every
// string the code asks for.
const LANGS = {
  en: { name: 'English', htmlLang: 'en', locale: 'en-GB' },
  pt: { name: 'Português', htmlLang: 'pt-BR', locale: 'pt-BR' },
  es: { name: 'Español', htmlLang: 'es', locale: 'es-ES' },
};
const CODES = Object.keys(LANGS);
const COOKIE = 'bf_lang';

const dicts = { en: {} };
for (const code of CODES) {
  if (code !== 'en') dicts[code] = JSON.parse(fs.readFileSync(path.join(__dirname, `${code}.json`), 'utf8'));
}

function fill(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

function translator(lang) {
  const dict = dicts[lang] || {};
  const t = (key, vars) => fill(dict[key] || key, vars);
  // Singular and plural are separate keys; `count` is available as {count}.
  t.n = (one, other, count, vars) => t(count === 1 ? one : other, Object.assign({ count }, vars));
  return t;
}

// Every literal key passed to t, t.n or reader.js's tNodes in a source file.
const T_CALL = /\bt(?:Nodes)?\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
const TN_CALL = /\bt\.n\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g;
function keysIn(source) {
  const unquote = (s) => s.replace(/\\(.)/g, '$1');
  const keys = new Set();
  for (const m of source.matchAll(T_CALL)) keys.add(unquote(m[2]));
  for (const m of source.matchAll(TN_CALL)) { keys.add(unquote(m[2])); keys.add(unquote(m[4])); }
  return keys;
}

// reader.js gets only the strings it uses, scanned once at boot.
const clientKeys = [...keysIn(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'reader.js'), 'utf8'))];
const clientStrings = {};
for (const code of CODES) {
  const strings = {};
  for (const key of clientKeys) if (dicts[code][key]) strings[key] = dicts[code][key];
  // a JSON blob for an inline <script>: never let a string close the tag
  clientStrings[code] = JSON.stringify({ lang: LANGS[code].htmlLang, strings }).replace(/</g, '\\u003c');
}

// A chosen language (cookie, set by /lang/:code) wins; otherwise the best
// match for the browser's Accept-Language, falling back to English.
function pickLang(req) {
  const chosen = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\w+)`).exec(req.headers.cookie || '');
  if (chosen && LANGS[chosen[1]]) return chosen[1];
  return req.acceptsLanguages(...CODES) || 'en';
}

function middleware(req, res, next) {
  const lang = pickLang(req);
  req.lang = lang;
  req.t = translator(lang);
  res.vary('Accept-Language');
  Object.assign(res.locals, {
    lang,
    t: req.t,
    htmlLang: LANGS[lang].htmlLang,
    locale: LANGS[lang].locale,
    languages: CODES.map((code) => ({ code, name: LANGS[code].name })),
    clientI18n: clientStrings[lang],
    // where the footer's language links return to (a form post can't be revisited)
    currentUrl: req.method === 'GET' ? req.originalUrl : '/',
  });
  next();
}

// Push notifications reach users outside any request, so they are written in
// the language the user last browsed in. Runs after loadUser (the middleware
// above runs before the session is read); writes only when it changed.
function rememberUserLang(req, res, next) {
  if (req.user && req.user.lang !== req.lang) {
    // required here, not at the top: the i18n tests load this file without a DB
    require('../db').db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(req.lang, req.user.id);
    req.user.lang = req.lang;
  }
  next();
}

// "3 hours ago" in the reader's language; older than 30 days shows the date.
function relTime(ts, lang) {
  const rtf = new Intl.RelativeTimeFormat(LANGS[lang].locale, { numeric: 'auto' });
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return rtf.format(0, 'second');
  if (mins < 60) return rtf.format(-mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, 'day');
  return new Date(ts).toLocaleDateString(LANGS[lang].locale);
}

module.exports = { LANGS, CODES, COOKIE, dicts, translator, keysIn, middleware, rememberUserLang, relTime };
