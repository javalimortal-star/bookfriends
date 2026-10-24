// The one-line PowerShell command on the owner's /users page that sets up the
// off-site copy on a Windows PC: it writes C:\bookfriends-backups\
// download-backup.ps1, registers the "BookFriends backup" scheduled task and
// runs the first download. It works in Windows PowerShell 5.1 (no && or ||,
// TLS 1.2 forced) and in PowerShell 7. One line because a multi-line paste
// can trigger warnings or run line by line in older consoles. Safe to run
// twice: everything is overwritten in place.

const DIR = 'C:\\bookfriends-backups';
const TASK = 'BookFriends backup';

// A single-quoted PowerShell string: only ' is special inside (written '').
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Strict RFC 3986 encoding: the token can then never contain a quote, $ or
// a non-ASCII character that PowerShell would read as a quote.
const encodeStrict = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Only a plain scheme://host[:port] from the request goes into the command.
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

// download-backup.ps1, run nightly by the task (as SYSTEM) and once by the
// setup command with -Tries 1 so a mistake shows at once instead of retrying.
function downloaderLines(origin, token) {
  const url = `${origin}/backup/download?token=${encodeStrict(token)}`;
  return [
    'param([int]$Tries = 3)',
    `# BookFriends off-site backup, written by the Users page of ${origin}`,
    `# Runs every night as the "${TASK}" scheduled task. Log: ${DIR}\\backup.log`,
    "$ErrorActionPreference = 'Stop'",
    // the progress bar makes Windows PowerShell 5.1 downloads many times slower
    "$ProgressPreference = 'SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'",
    `$dir = ${psq(DIR)}`,
    `$url = ${psq(url)}`,
    "$log = Join-Path $dir 'backup.log'",
    "function Write-Log($text) { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text); Write-Host $text }",
    "$out = Join-Path $dir ('bookfriends-' + (Get-Date -Format 'yyyy-MM-dd') + '.tar.gz')",
    "$part = $out + '.part'",
    'for ($attempt = 1; $attempt -le $Tries; $attempt++) {',
    '  try {',
    '    Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing',
    '    $size = (Get-Item -LiteralPath $part).Length',
    "    if ($size -le 0) { throw 'the downloaded file is empty' }",
    '    Move-Item -LiteralPath $part -Destination $out -Force',
    // only after a good download, so a long outage never empties the folder
    "    Get-ChildItem -LiteralPath $dir -Filter 'bookfriends-*.tar.gz' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force",
    "    Write-Log ('Backup downloaded: ' + [math]::Round($size / 1MB) + ' MB -> ' + $out)",
    '    exit 0',
    '  } catch {',
    '    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue',
    "    Write-Log ('Backup FAILED (try ' + $attempt + ' of ' + $Tries + '): ' + $_.Exception.Message)",
    // Task Scheduler's own restart setting ignores exit codes, so retry here
    '    if ($attempt -lt $Tries) { Start-Sleep -Seconds 600 }',
    '  }',
    '}',
    'exit 1',
  ];
}

function setupCommand(origin, token) {
  if (!token || !ORIGIN_RE.test(origin || '')) return null;
  const script = downloaderLines(origin, token).map(psq).join(', ');
  const steps = [
    '$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()',
    "if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Please open PowerShell as Administrator (right-click Start, then Terminal (Admin)) and paste this again.' -ForegroundColor Red; return }",
    `$dir = ${psq(DIR)}`,
    "$ps1 = Join-Path $dir 'download-backup.ps1'",
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `Set-Content -LiteralPath $ps1 -Encoding ASCII -Value @(${script})`,
    // the task name the old backup-bookfriends.cmd suggested: don't run both
    "if (Get-ScheduledTask -TaskName 'BookFriendsBackup' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName 'BookFriendsBackup' -Confirm:$false }",
    // SYSTEM by its SID: the account name is translated on non-English Windows
    "$system = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18').Translate([Security.Principal.NTAccount]).Value",
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File \"' + $ps1 + '\"')",
    "$trigger = New-ScheduledTaskTrigger -Daily -At '04:00'",
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 30) -ExecutionTimeLimit (New-TimeSpan -Hours 1)',
    '$principal = New-ScheduledTaskPrincipal -UserId $system -LogonType ServiceAccount -RunLevel Highest',
    `Register-ScheduledTask -TaskName ${psq(TASK)} -Description ${psq(`Downloads the newest BookFriends backup from ${origin} every night.`)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    `Write-Host ${psq(`Scheduled task "${TASK}" is ready: every day at 04:00.`)} -ForegroundColor Green`,
    "Write-Host 'Downloading the first backup now. This can take a few minutes...'",
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ps1 -Tries 1',
    "if ($LASTEXITCODE -eq 0) { Write-Host 'All done! Refresh the Users page: the Backups box should now say OK.' -ForegroundColor Green } else { Write-Host 'The first download did not work (the reason is above). The task still tries again every night at 04:00.' -ForegroundColor Red }",
  ];
  // & { ... } keeps the variables and 'Stop' out of the user's session, and
  // lets the admin check end everything with a plain return.
  return `& { $ErrorActionPreference = 'Stop'; try { ${steps.join('; ')} } catch { Write-Host ('Setup failed: ' + $_.Exception.Message) -ForegroundColor Red } }`;
}

module.exports = { setupCommand, downloaderLines, DIR, TASK };
