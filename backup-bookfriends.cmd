@echo off
rem Nightly BookFriends off-site backup download (see README "Backups").
rem 1) Replace YOUR_TOKEN_HERE with the BACKUP_TOKEN from the server .env.
rem 2) Schedule daily, e.g. (admin prompt):
rem    schtasks /Create /TN BookFriendsBackup /TR "C:\bookfriends-backups\backup-bookfriends.cmd" /SC DAILY /ST 04:00 /RU SYSTEM
set "TOKEN=YOUR_TOKEN_HERE"
set "DEST=C:\bookfriends-backups"
if not exist "%DEST%" mkdir "%DEST%"
for /f %%i in ('powershell -NoProfile -Command Get-Date -Format yyyy-MM-dd') do set "STAMP=%%i"
curl.exe -fsS --retry 3 "https://bookfriends.com.br/backup/download?token=%TOKEN%" -o "%DEST%\bookfriends-%STAMP%.tar.gz"
if errorlevel 1 exit /b 1
rem Keep 30 days of downloads.
forfiles /P "%DEST%" /M bookfriends-*.tar.gz /D -30 /C "cmd /c del @path" >nul 2>&1
exit /b 0
