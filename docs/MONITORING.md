# Monitoring: is the site up, are the backups safe?

Two free robots watch BookFriends for you, so you don't have to check by hand:

1. **GitHub** (the "Uptime" workflow in `.github/workflows/uptime.yml`)
   - every 15 minutes it checks that https://bookfriends.com.br answers;
   - once a day (around 09:00 in Brazil) it checks that the backups are fresh.

   If a check fails, **GitHub sends you an email.** No email means all is well.
   It costs nothing: GitHub Actions is free for public repositories.
2. **The Backups box** at the top of the site's **Users** page (only you see
   it). It shows the newest backup on the server, when the mini PC last
   downloaded a copy, and a status:
   - **OK**: the mini PC has a copy less than 36 hours old.
   - **Warning**: the newest copy is 36 to 72 hours old (one or two nights
     were missed), or the off-site download is turned off.
   - **Problem**: more than 3 days without a copy, or never. A small red dot
     then appears on your round account picture (top right) on every page,
     and the account menu gets a "Backups need attention" line.

   The box explains what to check for each case, and it has the setup steps
   for the mini PC (a command you copy into PowerShell).

## The emails and what to do

The email subject says "Run failed: Uptime" and names the check:

### "Site is up" failed

The site did not answer three times in a row (30 seconds apart).

1. Open https://bookfriends.com.br yourself. If it works now, it was a short
   hiccup (a restart or an update). You can ignore the email.
2. If it doesn't open, wait 15 minutes. A new email means it's still down.
3. Still down: log in to the Oracle Cloud console → **Compute** →
   **Instances**. If the server is not "Running", press **Start** (or
   **Reboot** if it is running but the site is dead). Oracle can stop or take
   back free servers. If the server is gone, your backups on the mini PC are
   how you get everything back.
4. Or ask Claude to look at the server (`sudo systemctl status bookfriends`).

### "Backups are fresh" failed

The red message in the run says which part is old:

- **"Off-site backup is old"**: the mini PC hasn't downloaded a copy in the
  last 36 hours (or never did). Open the site's **Users** page. The Backups
  box tells you what to check (is the mini PC on? does the "BookFriends
  backup" task in Task Scheduler run? are new files appearing in
  `C:\bookfriends-backups`?). Running the setup command again fixes most
  problems. You'll get this email once a day until it's fixed.
- **"Server backup stopped"**: the server itself has not made its nightly
  backup (it runs at 03:30 UTC). Ask Claude to check the server's cron job
  (`crontab -l`) and its log `~/backup.log`.

## Run the check by hand

1. Open the repository on GitHub and click the **Actions** tab.
2. On the left, click **Uptime**.
3. Click the **Run workflow** button (right side), then the green **Run
   workflow** button.
4. After about a minute the run shows a green tick (all fine) or a red cross
   (click it, then the red job, to read why).

You can also just open https://bookfriends.com.br/healthz in a browser. It
shows something like `{"ok":true,"db":"ok","backups":"ok","offsite":"ok"}`:

| Field | Means |
| --- | --- |
| `ok` | `true` = the site and its database work |
| `db` | `ok`, or `error` if the database can't be read |
| `backups` | the server's own nightly backup: `ok`, `stale` (over 36 hours old) or `missing` |
| `offsite` | the mini PC's copy: `ok`, `stale` (over 36 hours old), `never`, or `disabled` (no `BACKUP_TOKEN` on the server) |

It never shows file names, sizes or addresses, because anyone can open it.

## GitHub turns the checks off after 60 days of quiet

In a public repository, GitHub **switches off scheduled workflows when nothing
has been pushed to the repository for 60 days**. After that the checks just
stop and no emails come, even if the site is down. GitHub may email you about
it, but don't count on that.

To switch them back on:

1. Repository → **Actions** tab → **Uptime** on the left.
2. A yellow banner says the workflow was disabled. Click **Enable workflow**.

Any new commit pushed to the repository also counts as activity and resets the
60 days. A reminder in your calendar every 50 days or so is an easy way not to
forget.

## Not getting the emails?

GitHub sends them to the email of the account that last changed the schedule
in `uptime.yml` (or that re-enabled the workflow). To check: your GitHub
profile picture → **Settings** → **Notifications** → **System** → **Actions**:
email should be on, with "Only notify for failed workflows" ticked.
