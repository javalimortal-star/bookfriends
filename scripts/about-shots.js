// The phone pictures on /about: for each language, a throwaway copy of the
// site with public-domain books and a group of friends (the comments from
// src/about/samples.js), photographed by headless Chromium as Ana.
// Writes public/img/about/<lang>-<reading|news|shelf>.webp, the featured book's
// cover <lang>-cover.webp and <lang>-covers.webp, the three featured covers in a row.
// Usage: node scripts/about-shots.js [lang ...]   (books come from Project
// Gutenberg, downloaded once into the system's temp folder)
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const lib = require('../test/e2e/lib');
const samples = require('../src/about/samples');

const OUT = path.join(lib.ROOT, 'public', 'img', 'about');
const CACHE = path.join(os.tmpdir(), 'bookfriends-gutenberg');
const HOUR = 3600e3;
// Gutenberg numbers: Dom Casmurro, Dracula, Don Quijote, Frankenstein, Pride and Prejudice, Alice, Sherlock Holmes
const SHELF = [1661, 1342, 11, 84];

// What else the friends did this week, in each language.
const EXTRA = {
  pt: { ahead: 'Esse capítulo é curtinho mas explica o livro todo.', review: 'A criatura é o personagem mais humano do livro.', request: ['O Alienista', 'Machado de Assis'] },
  en: { ahead: 'Short chapter, but it explains the whole book.', review: 'The creature is the most human character in the book.', request: ['The Picture of Dorian Gray', 'Oscar Wilde'] },
  es: { ahead: 'Capítulo corto, pero explica todo el libro.', review: 'La criatura es el personaje más humano del libro.', request: ['Marianela', 'Benito Pérez Galdós'] },
};

async function epub(n) {
  if (n === 345) return lib.FIXTURE;
  const file = path.join(CACHE, `pg${n}.epub`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const res = await fetch(`https://www.gutenberg.org/cache/epub/${n}/pg${n}-images-3.epub`);
    if (!res.ok) throw new Error(`Gutenberg ${n}: ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

async function upload(owner, n) {
  const form = new FormData();
  form.append('epub', new Blob([fs.readFileSync(await epub(n))]), `pg${n}.epub`);
  const res = await owner.post('/upload', { body: form });
  const slug = (res.headers.get('location') || '').split('/')[2];
  if (res.status !== 302 || !slug) throw new Error(`upload ${n}: ${res.status}`);
  await owner.post(`/book/${slug}/visibility`);
  return slug;
}

async function comment(who, chapterId, para, c, parent) {
  const res = await who.post(`/api/chapter/${chapterId}/comments`, { json: { body: c.text, para_index: para, spoiler: !!c.spoiler, parent_id: parent } });
  if (res.status !== 201) throw new Error(`comment: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function photograph(lang) {
  const sample = samples[lang];
  const extra = EXTRA[lang];
  const srv = await lib.startServer();
  const db = new Database(path.join(srv.dataDir, 'bookfriends.db'));
  try {
    const owner = await lib.register(srv.url, lib.OWNER, 'Bento');
    const others = [55752, 345, 2000].filter((n) => n !== sample.epub);
    const slugs = {};
    const uploads = [...SHELF, ...others, sample.epub];
    for (const n of uploads) slugs[n] = await upload(owner, n);
    const book = slugs[sample.epub];
    const people = {};
    for (const name of ['Ana', 'Pedro', 'Lia', 'Caio']) people[name] = await lib.register(srv.url, `${name.toLowerCase()}@example.com`, name);
    for (const who of [owner, ...Object.values(people)]) await who.get(`/lang/${lang}`);

    // where everyone is: Lia on Ana's chapter, Pedro ahead, Caio in Frankenstein
    await people.Pedro.get(`/book/${book}/${sample.chapter + 11}`);
    await people.Lia.get(`/book/${book}/${sample.chapter}`);
    await people.Caio.get(`/book/${slugs[84]}/4`);
    await people.Ana.get(`/book/${slugs[others[0]]}/5`);
    await people.Ana.get(`/book/${book}/${sample.chapter}`);
    await owner.get(`/book/${book}/${sample.chapter + 3}`);

    const chapterId = (idx) => db.prepare('SELECT c.id FROM chapters c JOIN books b ON b.id = c.book_id WHERE b.slug = ? AND c.idx = ?').get(book, idx).id;
    let parent = null;
    for (const c of sample.comments) {
      const id = await comment(people[c.name], chapterId(sample.chapter), sample.para, c, c.reply ? parent : undefined);
      if (!c.reply) parent = id;
    }
    await comment(people.Caio, chapterId(sample.chapter + 1), 1, { text: extra.ahead });
    await people.Pedro.post(`/book/${slugs[84]}/rate`, { form: { stars: '5', review: extra.review } });
    await people.Caio.post(`/book/${slugs[345]}/rate`, { form: { stars: '4', review: '' } });
    await people.Lia.post(`/book/${slugs[11]}/rate`, { form: { stars: '4', review: '' } });
    await people.Caio.post('/requests', { form: { title: extra.request[0], author: extra.request[1], note: '' } });

    // spread it over a few days, like a real week
    const now = Date.now();
    // the featured book newest on the shelf, all added over a week ago
    uploads.slice().reverse().forEach((n, i) => {
      db.prepare('UPDATE books SET created_at = ?, published_at = ? WHERE slug = ?').run(now - (9 * 24 + i) * HOUR, now - (9 * 24 + i) * HOUR, slugs[n]);
    });
    const order = db.prepare('SELECT slug FROM books ORDER BY created_at DESC').all().map((b) => b.slug);
    if (order[0] !== book) throw new Error(`shelf order: ${order.join(' ')}`);
    const hoursAgo = [...sample.comments.map((c) => c.hours), 1.5];
    db.prepare('SELECT id FROM comments ORDER BY id').all()
      .forEach((row, i) => db.prepare('UPDATE comments SET created_at = ? WHERE id = ?').run(now - hoursAgo[i] * HOUR, row.id));
    for (const [email, hours] of [['pedro', 30], ['caio', 5], ['lia', 50]]) {
      db.prepare('UPDATE book_ratings SET updated_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(now - hours * HOUR, `${email}@example.com`);
    }
    db.prepare('UPDATE book_requests SET created_at = ?').run(now - 4 * HOUR);

    const browser = await lib.chromium.launch();
    const ctx = await browser.newContext({ ...lib.PHONE, locale: lang === 'pt' ? 'pt-BR' : lang, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await lib.login(page, srv.url, 'ana@example.com');
    // the plate on /about shows the top of the phone: keep 780 x 1400 of 780 x 1688
    const save = async (name, png) => {
      await sharp(png).extract({ left: 0, top: 0, width: 780, height: 1400 }).webp({ quality: 74 }).toFile(path.join(OUT, `${lang}-${name}.webp`));
    };

    await page.goto(`${srv.url}/book/${book}/${sample.chapter}`);
    await page.waitForLoadState('networkidle');
    await page.evaluate((para) => {
      const p = document.querySelector(`#chapter-content [data-p="${para}"]`);
      window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.42);
    }, sample.para);
    await page.waitForTimeout(600);
    await save('reading', await page.screenshot());

    await page.goto(srv.url + '/');
    await page.waitForLoadState('networkidle');
    await save('news', await page.screenshot());
    await page.evaluate(() => {
      const shelf = document.querySelector('.shelf-header');
      window.scrollTo(0, shelf.getBoundingClientRect().top + window.scrollY - 70);
    });
    await page.waitForTimeout(600);
    await save('shelf', await page.screenshot());

    const cover = await (await fetch(`${srv.url}/media/book/${db.prepare('SELECT id FROM books WHERE slug = ?').get(book).id}/cover`)).arrayBuffer();
    await sharp(Buffer.from(cover)).resize({ width: 320 }).webp({ quality: 80 }).toFile(path.join(OUT, `${lang}-cover.webp`));
    await browser.close();
    console.log(`${lang}: done`);
  } finally {
    db.close();
    srv.stop();
  }
}

// For the sentence on /about: this language's book first, then the other two.
async function coverStrips() {
  const langs = Object.keys(samples);
  if (!langs.every((lang) => fs.existsSync(path.join(OUT, `${lang}-cover.webp`)))) return;
  for (const lang of langs) {
    const order = [lang, ...langs.filter((l) => l !== lang)];
    const covers = await Promise.all(order.map((l) => sharp(path.join(OUT, `${l}-cover.webp`)).resize(120, 180, { fit: 'cover' }).toBuffer()));
    await sharp({ create: { width: 372, height: 180, channels: 3, background: '#1c1c1c' } })
      .composite(covers.map((input, i) => ({ input, left: i * 126, top: 0 })))
      .webp({ quality: 80 }).toFile(path.join(OUT, `${lang}-covers.webp`));
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const langs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(samples);
  for (const lang of langs) await photograph(lang);
  await coverStrips();
})().catch((err) => { console.error(err); process.exit(1); });
