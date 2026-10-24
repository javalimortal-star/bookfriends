const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  WARN_AFTER, PROBLEM_AFTER, ageLevel, listLocal, summarize, healthReport, checkDb, formatSize,
} = require('../src/backup/status');
const { setupCommand, downloaderLines } = require('../src/backup/setup');

const HOUR = 3600e3;
const NOW = Date.UTC(2026, 9, 24, 12);
const file = (hoursOld) => ({ name: 'bookfriends-2026-10-24.tar.gz', size: 5, mtime: NOW - hoursOld * HOUR });
const download = (hoursOld) => ({ file_name: 'bookfriends-2026-10-24.tar.gz', size: 5, ip: '203.0.113.9', created_at: NOW - hoursOld * HOUR });

test('age levels: OK under 36h, Warning up to 72h, Problem after', () => {
  assert.strictEqual(ageLevel(0), 'ok');
  assert.strictEqual(ageLevel(WARN_AFTER - 1), 'ok');
  assert.strictEqual(ageLevel(WARN_AFTER), 'warning');
  assert.strictEqual(ageLevel(PROBLEM_AFTER), 'warning');
  assert.strictEqual(ageLevel(PROBLEM_AFTER + 1), 'problem');
});

test('listLocal: only backup archives, newest first; no folder = none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-backups-'));
  try {
    for (const f of ['bookfriends-2026-10-20.tar.gz', 'bookfriends-2026-10-22.tar.gz', 'bookfriends-2026-10-23.tar.gz.part', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, f), 'x'.repeat(10));
    }
    const files = listLocal(dir);
    assert.deepStrictEqual(files.map((f) => f.name), ['bookfriends-2026-10-22.tar.gz', 'bookfriends-2026-10-20.tar.gz']);
    assert.strictEqual(files[0].size, 10);
    assert.ok(files[0].mtime > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepStrictEqual(listLocal(path.join(os.tmpdir(), 'bf-no-such-dir-' + process.pid)), []);
});

test('summarize: overall level is the worse of server and off-site copy', () => {
  const s = (files, last, tokenSet = true) => summarize({ files, lastDownload: last, tokenSet, now: NOW });
  assert.strictEqual(s([file(5)], download(3)).level, 'ok');
  assert.strictEqual(s([file(5)], download(48)).level, 'warning');
  assert.strictEqual(s([file(5)], download(100)).level, 'problem');
  assert.strictEqual(s([file(5)], null).level, 'problem', 'never downloaded');
  assert.strictEqual(s([file(50)], download(3)).level, 'warning', 'server job stopped');
  assert.strictEqual(s([], null).level, 'problem', 'token set but no backups');
  assert.strictEqual(s([file(5)], null, false).level, 'warning', 'off-site download disabled');
  assert.strictEqual(s([], null, false).level, 'none', 'dev machine: nothing set up');
  const full = s([file(5), file(29)], download(3));
  assert.strictEqual(full.local.count, 2);
  assert.strictEqual(full.offsite.last.ip, '203.0.113.9');
});

test('healthReport: coarse public states, 503 when the database fails', () => {
  const s = (files, last, tokenSet = true) => summarize({ files, lastDownload: last, tokenSet, now: NOW });
  assert.deepStrictEqual(healthReport(true, s([file(5)], download(3))),
    { status: 200, body: { ok: true, db: 'ok', backups: 'ok', offsite: 'ok' } });
  assert.deepStrictEqual(healthReport(true, s([file(50)], download(100))).body,
    { ok: true, db: 'ok', backups: 'stale', offsite: 'stale' });
  assert.deepStrictEqual(healthReport(true, s([], null)).body, { ok: true, db: 'ok', backups: 'missing', offsite: 'never' });
  assert.deepStrictEqual(healthReport(true, s([], null, false)).body, { ok: true, db: 'ok', backups: 'missing', offsite: 'disabled' });
  assert.deepStrictEqual(healthReport(false, s([file(5)], null)),
    { status: 503, body: { ok: false, db: 'error', backups: 'ok', offsite: 'unknown' } });
  const text = JSON.stringify(healthReport(true, s([file(5)], download(3))));
  assert.ok(!/bookfriends-|203\.0\.113/.test(text), 'no file names or IPs');
});

test('checkDb: SELECT 1 works on an open database, fails on a closed one', () => {
  const db = new Database(':memory:');
  assert.strictEqual(checkDb(db), true);
  db.close();
  assert.strictEqual(checkDb(db), false);
});

test('formatSize uses the reader decimal separator', () => {
  assert.strictEqual(formatSize(213280768, 'en-GB'), '203.4 MB');
  assert.strictEqual(formatSize(213280768, 'pt-BR'), '203,4 MB');
  assert.strictEqual(formatSize(10, 'en-GB'), '1 KB');
  assert.strictEqual(formatSize(3 * 1024 ** 3, 'en-GB'), '3.00 GB');
});

// Reads PowerShell single-quoted strings ('' = one quote) out of a command and
// returns them plus the code around them, to check escaping and brackets.
function splitQuoted(src) {
  const strings = [];
  let code = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "'") { code += src[i]; continue; }
    let s = '';
    for (i++; ; i++) {
      assert.ok(i < src.length, 'unterminated string');
      if (src[i] === "'" && src[i + 1] === "'") { s += "'"; i++; } else if (src[i] === "'") break; else s += src[i];
    }
    strings.push(s);
    code += "''";
  }
  return { strings, code };
}

function assertBalanced(code, label) {
  const pairs = { ')': '(', '}': '{', ']': '[' };
  const stack = [];
  // double-quoted strings hold no brackets that matter here; drop them
  for (const ch of code.replace(/"[^"]*"/g, '""')) {
    if ('({['.includes(ch)) stack.push(ch);
    else if (pairs[ch]) assert.strictEqual(stack.pop(), pairs[ch], `unbalanced ${ch} in ${label}`);
  }
  assert.deepStrictEqual(stack, [], `unclosed brackets in ${label}`);
}

test('setup command: one Windows PowerShell 5.1 line that writes the downloader verbatim', () => {
  const token = 'abc123DEF';
  const cmd = setupCommand('https://bookfriends.com.br', token);
  assert.ok(cmd && !/[\r\n]/.test(cmd), 'one line');
  assert.ok(!/&&|\|\|/.test(cmd), 'no && or || (PowerShell 5.1)');
  assert.ok(/^[\x20-\x7e]+$/.test(cmd), 'plain ASCII');
  for (const part of ["-TaskName 'BookFriends backup'", '-StartWhenAvailable', '-RestartCount 3', '-Minutes 30', '-Hours 1',
    "-Daily -At '04:00'", "'S-1-5-18'", '-LogonType ServiceAccount', '-File $ps1 -Tries 1', "-Encoding ASCII"]) {
    assert.ok(cmd.includes(part), `has ${part}`);
  }
  const { strings, code } = splitQuoted(cmd);
  assertBalanced(code, 'setup command');
  // the @( ... ) array is the downloader script, line by line
  const lines = downloaderLines('https://bookfriends.com.br', token);
  const start = strings.indexOf(lines[0]);
  assert.ok(start > 0, 'downloader is embedded');
  assert.deepStrictEqual(strings.slice(start, start + lines.length), lines);

  const script = lines.join('\n');
  assertBalanced(splitQuoted(script).code, 'download-backup.ps1');
  assert.ok(script.includes("[Net.ServicePointManager]::SecurityProtocol = 'Tls12'"));
  assert.ok(script.includes('-UseBasicParsing'));
  assert.ok(script.includes("$url = 'https://bookfriends.com.br/backup/download?token=abc123DEF'"));
  assert.ok(/\.part'/.test(script) && script.includes('Move-Item -LiteralPath $part -Destination $out'), 'renames the .part file');
  assert.ok(script.includes('AddDays(-30)'), 'keeps 30 days');
  assert.ok(!/&&|\|\|/.test(script));
});

test('setup command: odd tokens are percent-encoded, bad origins refused', () => {
  const cmd = setupCommand('http://127.0.0.1:3171', "it's $x ‘q’ (1)!");
  const url = splitQuoted(cmd).strings.map((s) => splitQuoted(s).strings).flat().find((s) => s.includes('/backup/download'));
  assert.strictEqual(url, 'http://127.0.0.1:3171/backup/download?token=it%27s%20%24x%20%E2%80%98q%E2%80%99%20%281%29%21');
  assert.strictEqual(new URL(url).searchParams.get('token'), "it's $x ‘q’ (1)!");
  assert.strictEqual(setupCommand('https://bookfriends.com.br', ''), null);
  assert.strictEqual(setupCommand('https://evil.example/"; rm', 'x'), null);
  assert.strictEqual(setupCommand(undefined, 'x'), null);
});
