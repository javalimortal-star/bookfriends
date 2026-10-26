// Shared helpers for the browser tests (npm run e2e): a throwaway server with
// its own data, filled through the real pages, and a headless Chromium.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'pg345-images-3.epub'); // Dracula, 32 chapters, with a cover
const PASSWORD = 'testpass123';
const OWNER = 'owner@example.com';

// Starts `node server.js` on a free port with a fresh DATA_DIR.
async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-e2e-'));
  // 4200-4999: clear of the ports fetch() refuses to call (e.g. 3659, 4190)
  const port = 4200 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), SESSION_SECRET: 'e2e', OWNER_EMAIL: OWNER, NODE_ENV: 'development', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + '/healthz')).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url, dataDir, log: () => log,
    stop() {
      child.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// A cookie-keeping HTTP client for one user.
function client(url) {
  let cookie = '';
  async function request(method, p, { form, json, body, headers = {}, redirect = 'manual' } = {}) {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    let payload = body;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    if (json) { h['Content-Type'] = 'application/json'; h.Accept = 'application/json'; payload = JSON.stringify(json); }
    const res = await fetch(url + p, { method, headers: h, body: payload, redirect });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  }
  return {
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    patch: (p, o) => request('PATCH', p, o),
    cookie: () => cookie,
  };
}

async function register(url, email, displayName) {
  const c = client(url);
  const res = await c.post('/register', { form: { email, password: PASSWORD, display_name: displayName || '' } });
  if (res.status !== 302) throw new Error(`register ${email}: ${res.status}`);
  return c;
}

// The owner uploads the fixture (public) and a private copy; Ana and Pedro
// join and open chapters, which puts their bookmarks there.
async function seed(url) {
  const owner = await register(url, OWNER, 'Bento');
  async function upload() {
    const form = new FormData();
    form.append('epub', new Blob([fs.readFileSync(FIXTURE)]), 'dracula.epub');
    const res = await owner.post('/upload', { body: form });
    const slug = (res.headers.get('location') || '').split('/')[2];
    if (res.status !== 302 || !slug) throw new Error(`upload: ${res.status}`);
    return slug;
  }
  const pub = await upload();
  await owner.post(`/book/${pub}/visibility`);
  const priv = await upload();
  const ana = await register(url, 'ana@example.com', 'Ana');
  const pedro = await register(url, 'pedro@example.com', 'Pedro');
  await ana.get(`/book/${pub}/10`);
  await pedro.get(`/book/${pub}/5`);
  return { owner, ana, pedro, pub, priv };
}

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SMALL_PHONE = { viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

async function login(page, url, email) {
  await page.goto(url + '/login');
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type=submit]')]);
}

// PASS/FAIL lines and a final count.
function checker() {
  let fails = 0;
  const check = (ok, msg) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
    if (!ok) fails += 1;
  };
  check.failures = () => fails;
  return check;
}

module.exports = { ROOT, FIXTURE, PASSWORD, OWNER, startServer, client, register, seed, PHONE, SMALL_PHONE, DESKTOP, login, checker, chromium };
