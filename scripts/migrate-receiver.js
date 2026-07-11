// One-shot upload receiver for the mini PC -> Oracle VM data migration.
// Runs on the VM behind Caddy (handle /migrate-upload -> 127.0.0.1:9977);
// it is not part of the web app and is torn down after the migration.
//
// Usage: MIGRATE_TOKEN=<secret> [MIGRATE_OUT=./migrate-upload.tar] [PORT=9977] \
//          node scripts/migrate-receiver.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.MIGRATE_TOKEN;
if (!TOKEN) {
  console.error('Set MIGRATE_TOKEN before starting the receiver.');
  process.exit(1);
}
const OUT = path.resolve(process.env.MIGRATE_OUT || 'migrate-upload.tar');
const PORT = Number(process.env.PORT || 9977);
const MAX_BYTES = 3 * 1024 * 1024 * 1024;

function tokenOk(candidate) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  const reply = (code, msg) => {
    res.writeHead(code, { 'Content-Type': 'text/plain' });
    res.end(msg + '\n');
  };
  if (req.method !== 'PUT' || req.url !== '/migrate-upload') return reply(404, 'not found');
  if (!tokenOk(req.headers['x-migrate-token'])) return reply(401, 'bad token');

  const tmp = OUT + '.part';
  const out = fs.createWriteStream(tmp);
  let bytes = 0;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_BYTES) {
      req.destroy();
      out.destroy();
      fs.rmSync(tmp, { force: true });
    }
  });
  req.on('error', () => {
    out.destroy();
    fs.rmSync(tmp, { force: true });
  });
  out.on('error', (err) => reply(500, 'write failed: ' + err.message));
  out.on('finish', () => {
    fs.renameSync(tmp, OUT);
    console.log(new Date().toISOString() + ' received ' + bytes + ' bytes -> ' + OUT);
    reply(200, 'RECEIVED ' + bytes + ' bytes');
  });
  req.pipe(out);
});

// Uploads can take many minutes on home upstream; never time the body out.
server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  console.log('migrate receiver listening on 127.0.0.1:' + PORT + ' -> ' + OUT);
});
