@echo off
setlocal
cd /d %~dp0

echo ==================================================
echo  BookFriends: send this PC's data to the new server
echo  (books, accounts, comments -^> bookfriends.com.br)
echo ==================================================
echo.

where tar >nul 2>&1
if errorlevel 1 (
  echo ERROR: tar.exe not found on this Windows. Nothing was changed.
  pause
  exit /b 1
)
where curl.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: curl.exe not found on this Windows. Nothing was changed.
  pause
  exit /b 1
)

set "TOKEN=%~1"
if "%TOKEN%"=="" set /p TOKEN=Paste the migration code and press Enter:
if "%TOKEN%"=="" (
  echo No code given. Nothing was changed.
  pause
  exit /b 1
)

echo.
echo [1/3] Stopping the local BookFriends site...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; schtasks /End /TN BookFriends 2>$null | Out-Null"

echo [2/3] Packing your books, accounts and comments...
if exist bookfriends-migrate.tar del bookfriends-migrate.tar
tar -cf bookfriends-migrate.tar -C data .
if errorlevel 1 goto fail

echo [3/3] Uploading to bookfriends.com.br - this can take several minutes,
echo        leave the window open until it says SUCCESS or FAILED...
curl.exe -f -sS --connect-timeout 30 -T bookfriends-migrate.tar -H "X-Migrate-Token: %TOKEN%" https://bookfriends.com.br/migrate-upload
if errorlevel 1 goto fail

del bookfriends-migrate.tar
echo.
echo ==================================================
echo  SUCCESS! Your data was sent to the new server.
echo  The old site on this PC was left STOPPED on purpose,
echo  so everyone now uses https://bookfriends.com.br
echo  (to turn the old one back on: schtasks /Run /TN BookFriends)
echo ==================================================
pause
exit /b 0

:fail
echo.
echo ==================================================
echo  FAILED - the upload did NOT complete.
echo  Restarting the old site so nothing is lost...
echo ==================================================
schtasks /Run /TN BookFriends
pause
exit /b 1
