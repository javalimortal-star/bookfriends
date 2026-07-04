@echo off
cd /d %~dp0
echo Updating BookFriends (stop, pull, install, restart)...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; schtasks /End /TN BookFriends 2>$null | Out-Null; git pull; npm install --omit=dev; schtasks /Run /TN BookFriends; Write-Host 'Update complete.'" ^& pause
