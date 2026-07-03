# Run BookFriends on a home mini PC (Windows) — fully online setup

No USB stick needed: the code comes from GitHub, books are uploaded through the
browser, and Tailscale gives the site a permanent public HTTPS address.

## 1. Install two programs

On the mini PC:

- **Node.js LTS** — https://nodejs.org (Windows installer, default options)
- **Git for Windows** — https://git-scm.com/download/win (default options)

## 2. Get the code and install

Open **Command Prompt**:

```
cd C:\
git clone https://github.com/javalimortal-star/bookfriends.git
cd bookfriends
npm install --omit=dev
```

## 3. Configure

```
copy .env.example .env
notepad .env
```

Set these values, then save:

- `OWNER_EMAIL` — your email; the account that registers with it becomes the owner
- `SESSION_SECRET` — a long random string; generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `NODE_ENV=production`

## 4. Test, then auto-start on boot

Double-click `start-bookfriends.cmd` — http://localhost:3000 should show the (empty)
bookshelf. Close the window, then open Command Prompt **as Administrator**:

```
schtasks /Create /TN "BookFriends" /TR "C:\bookfriends\start-bookfriends.cmd" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
schtasks /Run /TN "BookFriends"
```

The server now runs invisibly and starts with Windows.

## 5. Public HTTPS link (Tailscale Funnel, free)

1. Install Tailscale from https://tailscale.com/download and sign in.
2. PowerShell **as Administrator**:

   ```
   tailscale funnel --bg 3000
   ```

   The first run prints a link to enable Funnel — open it and approve.
3. `tailscale funnel status` shows your public URL, e.g.
   `https://minipc.tail1a2b3c.ts.net`. Rename the machine to `bookfriends` at
   https://login.tailscale.com → Machines for a nicer URL. The funnel persists
   across reboots.

## 6. First-time site setup

1. Open the public URL and **register immediately with your `OWNER_EMAIL`** —
   that claims the owner account.
2. Upload your EPUBs through the **Upload** button (from any computer — the
   files just need to be reachable from the browser you're using).
3. Make books public when ready; share the URL with friends.

## Updating the app

When new code lands on GitHub, on the mini PC right-click
`update-bookfriends.cmd` → **Run as administrator**. It pulls the latest code,
refreshes dependencies, and restarts the server. Your `data\` folder (books,
accounts, comments) and `.env` are never touched by updates.

## Housekeeping

- Power settings: set sleep to **Never** (display may sleep).
- Backup = copy `C:\bookfriends\data` somewhere safe now and then.
- Windows Update reboots are fine — the scheduled task and funnel come back.
