// Browser tests: npm run e2e [section ...]  (sections: pages speed feed previews reader books layout share about backups offline)
// A throwaway server and headless Chromium; screenshots go to $E2E_SHOTS if set.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const lib = require('./lib');

const check = lib.checker();
const SHOTS = process.env.E2E_SHOTS;
const shot = (page, name, opts = {}) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts }) : null);
const noSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let srv, seed, browser;
// a fake nightly archive for the off-site download
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-e2e-backups-'));
const BACKUP_TOKEN = crypto.randomBytes(16).toString('hex');
const ARCHIVE = crypto.randomBytes(300 * 1024);
fs.writeFileSync(path.join(BACKUP_DIR, `bookfriends-${new Date().toISOString().slice(0, 10)}.tar.gz`), ARCHIVE);
const db = () => new Database(path.join(srv.dataDir, 'bookfriends.db'));
function query(sql, ...args) {
  const d = db();
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
}

async function context(opts, email) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US', ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  if (email) await lib.login(page, srv.url, email);
  return { ctx, page };
}

const sections = {
  // every page, as owner / friend / visitor, in English and Portuguese, phone and desktop
  async pages() {
    const { pub, priv } = seed;
    const pages = ['/', `/book/${pub}`, `/book/${pub}/3`, `/book/${pub}/31`, `/book/${pub}/search?q=wolves`,
      '/settings', '/requests', '/notifications', '/users', '/upload', `/book/${pub}/edit`, `/book/${priv}`, '/about', '/nope'];
    const expect = (who, p) => {
      if (p === '/nope') return 404;
      if (p === `/book/${priv}`) return who === 'owner' ? 200 : 404;
      if (['/users', '/upload', `/book/${pub}/edit`].includes(p)) return who === 'owner' ? 200 : 403;
      return 200;
    };
    for (const who of ['owner', 'ana', 'anon']) {
      for (const locale of ['en-US', 'pt-BR']) {
        for (const [dev, opts] of [['phone', lib.SMALL_PHONE], ['desktop', lib.DESKTOP]]) {
          const email = who === 'owner' ? lib.OWNER : who === 'ana' ? 'ana@example.com' : null;
          const { ctx, page } = await context({ ...opts, locale }, email);
          const bad = [];
          for (const p of pages) {
            const res = await page.goto(srv.url + p);
            await page.waitForLoadState('networkidle').catch(() => {});
            const loginWall = who === 'anon' && ['/settings', '/requests', '/notifications'].includes(p);
            const ok = loginWall ? page.url().includes('/login') : res.status() === expect(who, p);
            if (!ok) bad.push(`${p} -> ${res.status()} ${page.url()}`);
            if (!(await noSideways(page))) bad.push(`${p} scrolls sideways`);
          }
          check(bad.length === 0 && page.errors.length === 0, `pages: ${who} ${locale} ${dev} ${bad.concat(page.errors).join('; ')}`);
          await ctx.close();
        }
      }
    }
  },

  // small covers, compressed text, the light logo
  async speed() {
    const { ana, pub } = seed;
    let book;
    for (let i = 0; i < 50 && !(book = query('SELECT * FROM books WHERE slug = ?', pub)).cover_thumb; i++) await new Promise((r) => setTimeout(r, 100));
    check(/^thumb-\d+\.jpg$/.test(book.cover_thumb || ''), `speed: cover thumbnail made (${book.cover_thumb})`);
    const shelf = await (await ana.get('/')).text();
    const cover = shelf.match(/\/media\/book\/\d+\/cover\?v=\d+t/);
    check(!!cover, 'speed: shelf links the small cover (?v=...t)');
    const img = await ana.get(cover ? cover[0] : '/media/book/1/cover');
    const buf = Buffer.from(await img.arrayBuffer());
    const meta = await sharp(buf).metadata();
    check(img.headers.get('content-type') === 'image/jpeg' && meta.width <= 480 && buf.length < 150 * 1024,
      `speed: cover is a ${meta.width}px JPEG of ${Math.round(buf.length / 1024)} KB`);
    const css = shelf.match(/\/css\/app\.css\?v=\w+/)[0];
    for (const p of ['/', css, '/js/reader.js', `/book/${pub}/3`]) {
      const enc = (await ana.get(p, { headers: { 'Accept-Encoding': 'gzip, br' } })).headers.get('content-encoding');
      check(enc === 'br' || enc === 'gzip', `speed: ${p.replace(/\?.*/, '')} compressed (${enc})`);
    }
    const epub = await ana.get(`/book/${pub}/download`, { headers: { 'Accept-Encoding': 'gzip, br', Range: 'bytes=0-99' } });
    check(epub.status === 206 && !epub.headers.get('content-encoding'), 'speed: EPUB not re-compressed, ranges still work');
    check(/src="\/logo\.webp\?v=/.test(shelf) && !/android-chrome-192x192\.png/.test(shelf), 'speed: pages use the 11 KB logo');
  },

  // What's new: friends' comments, ratings, requests, spoiler-safe
  async feed() {
    const { ana, pub } = seed;
    const chapterId = async (idx) => {
      const html = await (await ana.get(`/book/${pub}/${idx}?peek=1`)).text();
      return Number(html.match(/chapterId: (\d+)/)[1]);
    };
    const say = async (idx, body, extra = {}) => ana.post(`/api/chapter/${await chapterId(idx)}/comments`, { json: { body, para_index: null, ...extra } });
    await say(3, 'Those wolves gave me chills!');
    await say(4, 'The count is a vampire', { spoiler: true });
    await say(20, 'Wait until you see chapter 21');
    await ana.post(`/book/${pub}/finish`);
    await ana.post(`/book/${pub}/rate`, { form: { stars: '5', review: 'Loved it' } });
    await ana.post('/requests', { form: { title: 'O Senhor dos Anéis', author: 'Tolkien' } });
    const markBefore = query("SELECT b.chapter_idx FROM bookmarks b JOIN users u ON u.id = b.user_id WHERE u.email = 'pedro@example.com'");

    for (const [locale, dev, opts, theme] of [['pt-BR', 'phone', lib.PHONE, 'dark'], ['en-US', 'desktop', lib.DESKTOP, 'light']]) {
      const { ctx, page } = await context({ ...opts, locale }, 'pedro@example.com');
      await page.evaluate((t) => localStorage.setItem('bf-reader-settings', JSON.stringify({ theme: t })), theme);
      await page.goto(srv.url + '/');
      const feed = page.locator('.feed');
      const text = (await feed.textContent()) || '';
      check(await feed.isVisible(), `feed: shown on ${dev} (${locale})`);
      check(text.includes('Ana') && text.includes('Those wolves gave me chills!'), 'feed: a friend\'s comment with its text');
      check(!text.includes('The count is a vampire') && !text.includes('Wait until you see'), 'feed: no spoiler or ahead-of-you text');
      check(/★★★★★/.test(text) && text.includes('O Senhor dos Anéis'), 'feed: rating and book request');
      check(await noSideways(page), `feed: fits the ${dev}`);
      await shot(page, `feed-${dev}-${theme}`, { fullPage: true });
      await ctx.close();
    }
    // a comment item opens the chapter as a peek: Pedro's bookmark stays
    const { ctx, page } = await context(lib.PHONE, 'pedro@example.com');
    await page.goto(srv.url + '/');
    const item = page.locator('.feed-item', { hasText: 'Those wolves' });
    if (!(await item.isVisible())) await page.click('.feed-more summary'); // past the first few
    const href = await item.getAttribute('href');
    await Promise.all([page.waitForNavigation(), item.click()]);
    await page.waitForTimeout(500);
    const markAfter = query("SELECT b.chapter_idx FROM bookmarks b JOIN users u ON u.id = b.user_id WHERE u.email = 'pedro@example.com'");
    check(/\?peek=1/.test(href) && markAfter.chapter_idx === markBefore.chapter_idx, `feed: ${href} keeps the bookmark at ${markBefore.chapter_idx}`);
    await ctx.close();
    // the owner sees it too; visitors don't
    const owner = await (await seed.owner.get('/')).text();
    const anon = await (await fetch(srv.url + '/')).text();
    check(owner.includes('class="feed"') && !anon.includes('class="feed"'), 'feed: owner sees it, visitors do not');
  },

  // link previews, as a crawler (no cookies) sees them
  async previews() {
    const { pub, priv } = seed;
    const metas = (html) => Object.fromEntries([...html.matchAll(/<meta property="og:(\w+(?::\w+)?)" content="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const home = metas(await (await fetch(srv.url + '/')).text());
    check(home.title === 'BookFriends' && /^http:\/\/127\.0\.0\.1:\d+\/og-image\.jpg\?v=/.test(home.image) && home.description,
      `previews: home ${JSON.stringify(home).slice(0, 140)}`);
    const banner = await fetch(home.image);
    const bannerMeta = await sharp(Buffer.from(await banner.arrayBuffer())).metadata();
    check(banner.ok && bannerMeta.width === 1200 && bannerMeta.height === 630, 'previews: banner 1200x630');
    const book = metas(await (await fetch(`${srv.url}/book/${pub}`)).text());
    check(book.type === 'book' && /Dracula/.test(book.title) && /\/media\/book\/\d+\/cover/.test(book.image), `previews: book ${book.title} ${book.image}`);
    const cover = await fetch(book.image);
    check(cover.ok && cover.headers.get('content-type') === 'image/jpeg', 'previews: the cover is public for crawlers');
    const chapter = metas(await (await fetch(`${srv.url}/book/${pub}/3`)).text());
    check(/Dracula/.test(chapter.title) && chapter.image === book.image, `previews: chapter ${chapter.title}`);
    check((await fetch(`${srv.url}/book/${priv}`)).status === 404, 'previews: a private book shows nothing');
    // WhatsApp & co. get the owner's language; people still get their own
    await seed.owner.get('/lang/pt?next=/');
    await seed.owner.get('/'); // records the owner's language
    const asWhatsApp = await (await fetch(`${srv.url}/book/${pub}`, { headers: { 'User-Agent': 'WhatsApp/2.24.1.0 A', 'Accept-Language': 'en-US' } })).text();
    check(metas(asWhatsApp).description === 'Leia com seus amigos no BookFriends.' && /<html lang="pt-BR"/.test(asWhatsApp),
      `previews: WhatsApp gets the owner's Portuguese (${metas(asWhatsApp).description})`);
    const asReader = metas(await (await fetch(`${srv.url}/book/${pub}`, { headers: { 'Accept-Language': 'es-ES' } })).text());
    check(asReader.description === 'Léelo con tus amigos en BookFriends.', `previews: a Spanish browser still gets Spanish (${asReader.description})`);
    await seed.owner.get('/lang/en?next=/');
    await seed.owner.get('/');
  },

  // reading position, the bar, replies
  async reader() {
    const { pub } = seed;
    const paras = (await (await seed.ana.get(`/book/${pub}/10?peek=1`)).text()).match(/data-p="/g).length;
    const want = Math.min(25, paras - 5);
    const paraOf = () => query("SELECT b.para_index FROM bookmarks b JOIN users u ON u.id = b.user_id WHERE u.email = 'ana@example.com'").para_index;
    for (const [dev, opts] of [['phone', lib.PHONE], ['desktop', lib.DESKTOP]]) {
      for (const settings of [null, { v: 2, size: 26, lh: 40 }]) {
        const { ctx, page } = await context(opts, 'ana@example.com');
        if (settings) await page.evaluate((s) => localStorage.setItem('bf-reader-settings', JSON.stringify(s)), settings);
        await page.goto(`${srv.url}/book/${pub}/10`);
        // bookmark on chapter 10 (other sections may have moved it), then the paragraph
        await page.evaluate(async (para) => {
          const put = (what, body) => fetch(`/api/book/${window.__READER__.bookId}/${what}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          await put('bookmark', { idx: 10 });
          await put('position', { idx: 10, para });
        }, want);
        for (let round = 0; round < 3; round++) {
          await page.goto(`${srv.url}/book/${pub}/10`); await page.waitForLoadState('load');
          await page.waitForTimeout(3500);
          await page.goto(srv.url + '/notifications'); await page.waitForTimeout(300);
        }
        check(paraOf() === want, `reader: ${dev} ${settings ? '26/40' : 'default'} keeps paragraph ${want} after 3 visits (${paraOf()})`);
        await ctx.close();
      }
    }
    for (const locale of ['en-US', 'pt-BR', 'es-ES']) {
      const { ctx, page } = await context({ ...lib.SMALL_PHONE, locale }, 'ana@example.com');
      await page.goto(`${srv.url}/book/${pub}/10`); await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(300);
      const bar = await page.evaluate(() => { const b = document.querySelector('.reader-bottombar'); return b.scrollWidth <= b.clientWidth; });
      check(bar, `reader: bottom bar fits 360px in ${locale}`);
      await ctx.close();
    }
    // a reply thread: shown, then hidden by its button
    const html = await (await seed.ana.get(`/book/${pub}/3?peek=1`)).text();
    await seed.ana.post(`/api/chapter/${html.match(/chapterId: (\d+)/)[1]}/comments`, { json: { body: 'Reply to me', para_index: null } });
    const { ctx, page } = await context(lib.DESKTOP, 'pedro@example.com');
    await page.goto(`${srv.url}/book/${pub}/3`); await page.waitForLoadState('networkidle');
    const first = page.locator('#chapter-comment-list .comment').first();
    await first.locator('.link-btn', { hasText: 'Reply' }).click();
    await page.fill('.reply-form textarea', 'Me too!');
    await page.click('.reply-form button[type=submit]');
    await page.waitForSelector('#chapter-comment-list .comment-replies');
    const box = page.locator('#chapter-comment-list .comment-replies').first();
    const visibleAtFirst = await box.isVisible();
    await page.locator('#chapter-comment-list .view-replies').first().click();
    check(visibleAtFirst && !(await box.isVisible()), 'reader: replies shown, the button hides them');
    check(page.errors.length === 0, `reader: no page errors ${page.errors.join('; ')}`);
    await ctx.close();
  },

  // book page: finish + rate, reviews hidden until finished, editing the cover
  async books() {
    const { pub } = seed;
    await seed.ana.post(`/book/${pub}/rate`, { form: { stars: '5', review: 'Loved it' } });
    const { ctx, page } = await context(lib.PHONE, 'pedro@example.com');
    await page.goto(`${srv.url}/book/${pub}`);
    check(!(await page.isVisible('.rating-list >> text=Loved it')) && await page.isVisible('.spoiler-reviews summary'),
      'books: an unfinished reader sees stars but no review text');
    await Promise.all([page.waitForNavigation(), page.click('#rate form button')]);
    await page.click('label[for="star-4"]');
    await Promise.all([page.waitForNavigation(), page.click('.rating-form button[type=submit]')]);
    check((await page.textContent('#ratings')).includes('Loved it'), 'books: after finishing, reviews show');
    await shot(page, 'book-phone', { fullPage: true });
    await ctx.close();
    // the owner replaces the cover: new URL, small version made again
    const { ctx: octx, page: owner } = await context(lib.DESKTOP, lib.OWNER);
    await owner.goto(`${srv.url}/book/${pub}`);
    const before = await owner.getAttribute('.book-hero-cover img', 'src');
    await owner.goto(`${srv.url}/book/${pub}/edit`);
    const big = await sharp({ create: { width: 1600, height: 2400, channels: 3, background: '#2d4c7e' } }).jpeg({ quality: 95 }).toBuffer();
    await owner.setInputFiles('input[name=cover]', { name: 'new.jpg', mimeType: 'image/jpeg', buffer: big });
    await Promise.all([owner.waitForNavigation(), owner.click('form[action$="/edit"] button[type=submit]')]);
    await owner.waitForTimeout(1500); // the thumbnail is made in the background
    await owner.reload();
    const after = await owner.getAttribute('.book-hero-cover img', 'src');
    const served = Buffer.from(await (await fetch(srv.url + after)).arrayBuffer());
    check(after !== before && /t$/.test(after) && served.length < big.length / 4, `books: new cover ${before} -> ${after}, served ${Math.round(served.length / 1024)} KB`);
    await octx.close();
  },

  // Share on the book page: the phone's share menu, else the clipboard; none for private books
  async share() {
    const { pub, priv } = seed;
    const bookUrl = `${srv.url}/book/${pub}`;
    const phone = await browser.newContext({ ...lib.PHONE, locale: 'pt-BR', serviceWorkers: 'block' });
    await phone.addInitScript(() => { navigator.share = (data) => { window.__shared = data; return Promise.resolve(); }; });
    let page = await phone.newPage();
    await page.goto(bookUrl);
    await page.click('.share-btn');
    const shared = await page.evaluate(() => window.__shared);
    check(shared && shared.url === bookUrl && shared.text === 'Leia Dracula comigo no BookFriends',
      `share: the share menu gets the book link and a message (${JSON.stringify(shared)})`);
    await shot(page, 'share-phone');
    await phone.close();
    const desk = await browser.newContext({ ...lib.DESKTOP, serviceWorkers: 'block' });
    await desk.addInitScript(() => { delete Navigator.prototype.share; delete navigator.share; });
    await desk.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.url });
    page = await desk.newPage();
    await page.goto(bookUrl + '?from=search#ratings');
    await page.click('.share-btn');
    await page.waitForTimeout(200);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied === bookUrl && (await page.textContent('.share-btn')).includes('Link copied!'),
      `share: without a share menu the link is copied, without ?query or #hash (${copied})`);
    await desk.close();
    const { ctx, page: owner } = await context(lib.DESKTOP, lib.OWNER);
    await owner.goto(`${srv.url}/book/${priv}`);
    check(!(await owner.locator('.share-btn').count()), 'share: no button on a private book');
    await ctx.close();
  },

  // the shelf and book page on a computer: books on the first screen, one orange button
  async layout() {
    const { pub } = seed;
    const { ctx, page } = await context(lib.DESKTOP, 'ana@example.com');
    await page.goto(srv.url + '/');
    const top = await page.evaluate(() => document.querySelector('.shelf .book-card').getBoundingClientRect().top);
    check(top < 800 - 150, `layout: the shelf's books start on the first screen (y=${Math.round(top)} of 800)`);
    check((await page.locator('.book-card .btn').count()) === 0 && (await page.locator('.book-card .progress-label[href]').count()) > 0,
      'layout: book cards carry no buttons; "You have read" continues the book');
    await ctx.close();
    // the owner hasn't finished the book: only "Start reading" is orange, not "Mark as finished"
    const owner = await context(lib.DESKTOP, lib.OWNER);
    await owner.page.goto(`${srv.url}/book/${pub}`);
    const cover = await owner.page.locator('.book-hero-cover').boundingBox();
    const body = await owner.page.locator('.book-body').boundingBox();
    const orange = await owner.page.locator('.book-page .btn:not(.btn-ghost)').count();
    check(cover.x + cover.width < body.x && orange === 1, `layout: book page has the cover beside the text, ${orange} orange button`);
    await owner.ctx.close();
    const visitor = await context(lib.SMALL_PHONE);
    await visitor.page.goto(srv.url + '/');
    check((await visitor.page.isVisible('.hero-demo .para-badge')) && (await visitor.page.getAttribute('.hero-more', 'href')) === '/about',
      'layout: visitors see a paragraph with its comments and a link to /about');
    await visitor.page.goto(`${srv.url}/book/${pub}`);
    check(!(await visitor.page.locator('#rate').count()) && (await visitor.page.textContent('#ratings')).includes('Log in'),
      'layout: visitors get one line about rating, not an empty section');
    await visitor.ctx.close();
  },

  // the project's page: the paragraph to try, the phone screens, sharing and the invitation
  async about() {
    const phone = await browser.newContext({ ...lib.PHONE, locale: 'pt-BR', serviceWorkers: 'block' });
    await phone.addInitScript(() => { navigator.share = (data) => { window.__shared = data; return Promise.resolve(); }; });
    const page = await phone.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(srv.url + '/');
    await page.click('.footer-about a');
    check(new URL(page.url()).pathname === '/about', 'about: linked from the footer of every page');
    check((await page.textContent('h1')).trim() === 'Seus amigos, nas margens' && (await page.textContent('.reader-book')).includes('Dom Casmurro'),
      'about: in Portuguese, with a paragraph of Dom Casmurro');
    const bubble = page.locator('[data-thread-toggle]');
    await bubble.click();
    const closed = (await bubble.getAttribute('aria-expanded')) === 'false' && (await page.$eval('#thread', (el) => el.classList.contains('is-closed')));
    await bubble.click();
    check(closed && (await bubble.getAttribute('aria-expanded')) === 'true', 'about: the bubble closes and opens the comments');
    await page.click('[data-spoiler]');
    check(await page.$eval('[data-spoiler]', (el) => el.classList.contains('is-shown')), 'about: a tap shows the spoiler');
    await page.click('[data-tab="news"]');
    check(await page.$eval('[data-shot="news"]', (el) => el.classList.contains('is-on')) && (await page.isVisible('#panel-news')) && !(await page.isVisible('#panel-reading')),
      'about: the tabs switch the phone screen and its text');
    await page.fill('.invite-name', 'Ana');
    await page.click('.invite-send');
    let shared = await page.evaluate(() => window.__shared);
    check(shared && shared.text === 'Ana, vem ler comigo no BookFriends!' && shared.url === srv.url + '/',
      `about: the invitation shares a message with the friend's name (${JSON.stringify(shared)})`);
    await page.click('[data-share]');
    shared = await page.evaluate(() => window.__shared);
    check(shared && shared.url === srv.url + '/about', 'about: "Share this page" shares the page');
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
    });
    await page.waitForLoadState('networkidle');
    const broken = await page.evaluate(() => [...document.images].filter((img) => !img.complete || !img.naturalWidth).map((img) => img.src));
    check(!broken.length, `about: every picture loads (${broken.join(' ') || 'all'})`);
    check((await noSideways(page)) && !errors.length, `about: no sideways scroll, no script errors (${errors.join('; ')})`);
    await shot(page, 'about-phone', { fullPage: true });
    await phone.close();
    // without motion, nothing waits for a scroll to appear
    const still = await browser.newContext({ ...lib.DESKTOP, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const desk = await still.newPage();
    await desk.goto(srv.url + '/about');
    const hidden = await desk.evaluate(() => [...document.querySelectorAll('[data-reveal]')]
      .filter((el) => getComputedStyle(el).opacity === '0' && !el.matches('.plate-shot:not(.is-on)')).length);
    check(hidden === 0 && (await desk.textContent('h1')).trim() === 'Your friends, in the margins' && (await noSideways(desk)),
      `about: in English on a computer, everything shown at once with reduced motion (${hidden} hidden)`);
    await shot(desk, 'about-desktop', { fullPage: true });
    await still.close();
  },

  // the mini PC's nightly download: the exact bytes, never re-compressed, and recorded
  async backups() {
    const before = await (await fetch(srv.url + '/healthz')).json();
    const res = await fetch(`${srv.url}/backup/download?token=${BACKUP_TOKEN}`, { headers: { 'Accept-Encoding': 'gzip, br' } });
    const body = Buffer.from(await res.arrayBuffer());
    check(res.ok && !res.headers.get('content-encoding') && body.equals(ARCHIVE), `backups: download is the archive, byte for byte (${body.length} bytes)`);
    await new Promise((r) => setTimeout(r, 300));
    const after = await (await fetch(srv.url + '/healthz')).json();
    check(before.offsite === 'never' && after.offsite === 'ok', `backups: recorded (offsite ${before.offsite} -> ${after.offsite})`);
    check((await fetch(`${srv.url}/backup/download?token=wrong`)).status === 404, 'backups: a wrong token gets a 404');
  },

  // the service worker installs and keeps the logo for offline pages
  async offline() {
    const ctx = await browser.newContext({ ...lib.PHONE });
    const page = await ctx.newPage();
    await lib.login(page, srv.url, 'ana@example.com');
    await page.goto(`${srv.url}/book/${seed.pub}/3`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const savedPaths = () => page.evaluate(async () => {
      const urls = [];
      for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
      return urls;
    });
    let cached = [];
    for (let i = 0; i < 40 && !(cached = await savedPaths()).includes(`/book/${seed.pub}/4`); i++) await page.waitForTimeout(250);
    check(cached.includes('/logo.webp') && cached.includes('/offline'), `offline: worker saved the logo and the offline page (${cached.length} entries)`);
    check(cached.includes(`/book/${seed.pub}/4`), 'offline: next chapters saved');
    await ctx.close();
  },
};

(async () => {
  const only = process.argv.slice(2);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  srv = await lib.startServer({ BACKUP_DIR, BACKUP_TOKEN });
  try {
    seed = await lib.seed(srv.url);
    browser = await lib.chromium.launch();
    for (const [name, run] of Object.entries(sections)) {
      if (only.length && !only.includes(name)) continue;
      try { await run(); } catch (err) { check(false, `${name}: crashed: ${err.stack}`); }
    }
  } finally {
    if (browser) await browser.close();
    if (check.failures()) console.log(srv.log().split('\n').filter((l) => /error|Error/.test(l)).slice(0, 10).join('\n'));
    srv.stop();
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  }
  console.log(check.failures() ? `${check.failures()} FAILED` : 'ALL PASS');
  process.exit(check.failures() ? 1 : 0);
})();
