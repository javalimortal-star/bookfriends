# BookFriends

Share EPUB books with your friends: a responsive website with a Wuxiaworld-style dark
reader, per-paragraph comments (badge + slide-out panel), end-of-chapter comment
sections, replies and like/dislike votes. Includes light/sepia themes, a font options
panel, and EPUB download for Send-to-Kindle.

> **About this project:** built end-to-end with AI (Claude Code) — requirements were
> crystallized through a Socratic deep-interview, the plan was consensus-reviewed by
> architect/critic agents, and the implementation went through automated QA plus
> independent security and code review passes.

- **Only the owner uploads books** — everyone else registers to read public books and comment.
- Each book is **public** (anyone visiting the shelf can read it) or **private** (owner only).
- Public books are readable without an account; commenting requires login.

## Run locally

```sh
cp .env.example .env   # set OWNER_EMAIL + SESSION_SECRET
npm install
npm start              # http://localhost:3000
```

Register with the exact `OWNER_EMAIL` address to get the owner account, then use
**Upload** to add an `.epub`. New books start private; use **Make public** on the shelf
to share them.

## Tests & lint

```sh
npm test    # EPUB pipeline tests against pg345-images-3.epub (Dracula)
npm run lint
```

## Deploy — Fly.io (recommended)

Data (SQLite DB + extracted book images) lives on a mounted volume at `/data`, so it
survives deploys.

```sh
fly launch --no-deploy          # reuses fly.toml; pick an app name
fly volumes create data --size 1
fly secrets set OWNER_EMAIL=you@example.com SESSION_SECRET=$(openssl rand -hex 32)
fly deploy
```

Open `https://<app>.fly.dev`, register with the owner email, upload, share the URL.

## Deploy — any $5 VPS

```sh
# on the server
git clone <this repo> && cd bookfriends
cp .env.example .env            # set OWNER_EMAIL, SESSION_SECRET, NODE_ENV=production
npm ci --omit=dev
node server.js                  # or run under systemd
```

Put [Caddy](https://caddyserver.com) in front for automatic HTTPS:

```
example.com {
    reverse_proxy localhost:3000
}
```

## Google login (optional)

The login/register pages show a **Continue with Google** button when Google OAuth
credentials are configured; without them the button is hidden and email/password
login works as usual.

1. Go to https://console.cloud.google.com and create (or pick) a project.
2. **APIs & Services → OAuth consent screen** → External → fill in the app name
   and your email → publish the app (the basic email/profile scopes need no
   Google verification).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Web application** → under **Authorized redirect URIs** add
   your site's callback, e.g. `https://your-site.example/auth/google/callback`
   (also add `http://localhost:3000/auth/google/callback` for local testing).
4. Add both values to `.env` and restart the server:

   ```
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=xxxxxxxx
   ```

Google accounts are matched to site accounts by email (a Google sign-in with the
same address logs into the existing account), and the Google profile name becomes
the initial display name.

## Backups

`scripts/backup.js` writes a SQLite-safe snapshot of the database (via
`better-sqlite3`'s backup API — never raw-copy a live WAL database) plus the
extracted book media to `backups/bookfriends-YYYY-MM-DD.tar.gz`, keeping the
newest 7. Schedule it nightly on the server:

```cron
30 3 * * * cd /path/to/bookfriends && /usr/bin/node scripts/backup.js >> ~/backup.log 2>&1
```

Off-site copy: set `BACKUP_TOKEN` in `.env` and another machine can download the
newest archive from `/backup/download?token=...` over HTTPS.
`backup-bookfriends.cmd` does exactly that as a Windows Scheduled Task and keeps
30 days of downloads.

Restore: stop the server, then extract into a fresh data dir:
`tar -xzf bookfriends-YYYY-MM-DD.tar.gz -C data`.

## Security notes

- **Register the owner account immediately after deploying.** The first registration
  using `OWNER_EMAIL` becomes the owner — until you register, anyone who guesses that
  email could claim it. If registration ever says your owner email is taken, someone
  squatted it: wipe `DATA_DIR` (or delete that user row) and register again.
- Login, registration, password changes and comment posting are rate-limited per
  IP (`src/rate-limit.js`); successful logins don't count against the limit.
- Known accepted trade-offs for a friends-scale site: registration reveals whether
  an email exists, and there is no upload decompression-bomb guard (uploads are
  owner-only).

## Architecture

Single Node process: Express + EJS server-rendered pages, `better-sqlite3` (WAL) for
data and sessions, vanilla-JS progressive enhancement for the reader. EPUBs are parsed
at upload (NCX table of contents → chapters, fragment-anchor slicing, sanitized HTML,
stable `data-p` paragraph anchors); book images are re-served through access-checked
`/media` routes so private books stay private. Everything mutable lives in `DATA_DIR`.
