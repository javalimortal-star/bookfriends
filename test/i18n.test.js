const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { CODES, dicts, keysIn, translator } = require('../src/i18n');

function sourceFiles(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

// Every t('…') key in the templates, the server code and reader.js.
const used = new Set();
for (const file of [
  ...sourceFiles(path.join(ROOT, 'views'), '.ejs'),
  ...sourceFiles(path.join(ROOT, 'src'), '.js'),
  path.join(ROOT, 'server.js'),
  path.join(ROOT, 'public', 'js', 'reader.js'),
]) {
  for (const key of keysIn(fs.readFileSync(file, 'utf8'))) used.add(key);
}

const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(' ');
const tags = (s) => (s.match(/<\/?\w+>/g) || []).join(' ');

test('the code asks for translatable strings', () => {
  assert.ok(used.size > 100, `only ${used.size} keys found`);
});

for (const code of CODES.filter((c) => c !== 'en')) {
  test(`${code}: translates every string the code uses`, () => {
    const missing = [...used].filter((key) => !dicts[code][key]);
    assert.deepStrictEqual(missing, []);
  });

  test(`${code}: has no leftover strings the code no longer uses`, () => {
    const unused = Object.keys(dicts[code]).filter((key) => !used.has(key));
    assert.deepStrictEqual(unused, []);
  });

  test(`${code}: keeps every {placeholder} and HTML tag`, () => {
    for (const [key, value] of Object.entries(dicts[code])) {
      assert.strictEqual(placeholders(value), placeholders(key), `placeholders in ${JSON.stringify(key)}`);
      assert.strictEqual(tags(value), tags(key), `tags in ${JSON.stringify(key)}`);
    }
  });
}

test('translator fills placeholders, picks plurals, falls back to English', () => {
  const t = translator('pt');
  assert.strictEqual(t('No such key {x}', { x: 1 }), 'No such key 1');
  const en = translator('en');
  assert.strictEqual(en.n('{count} book', '{count} books', 1), '1 book');
  assert.strictEqual(en.n('{count} book', '{count} books', 3), '3 books');
});
