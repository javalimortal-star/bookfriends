@echo off
cd /d %~dp0
echo Updating BookFriends...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; schtasks /End /TN BookFriends 2>$null | Out-Null; git pull; npm install --omit=dev; schtasks /Run /TN BookFriends; Write-Host ''; Write-Host 'Update complete.'; Read-Host 'Press Enter to close'"
