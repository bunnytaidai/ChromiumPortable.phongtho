@echo off
title Tat du an Chromium Portable v2.10.4
color 0C
chcp 65001 > nul

echo ======================================================================
echo          DANG TAT TOAN BO DU AN CHROMIUM PORTABLE v2.10.4
echo ======================================================================
echo.

:: 1. Tat cac may chu Node.js dang chay tren cong 5000 va 5001 bang PowerShell
echo [*] Dang giai phong cong ket noi 5000 va 5001...
powershell -Command "$pids = (Get-NetTCPConnection -LocalPort 5000 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique; foreach ($p in $pids) { if ($p -gt 0) { echo \"[*] Dang tat PID $p tren cong 5000...\"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }"
powershell -Command "$pids = (Get-NetTCPConnection -LocalPort 5001 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique; foreach ($p in $pids) { if ($p -gt 0) { echo \"[*] Dang tat PID $p tren cong 5001...\"; Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }"

:: 2. Tat cac tien trinh node.exe con lai de bao dam sach se
echo [*] Dang tat cac tien trinh Node.js chay ngam...
taskkill /f /im node.exe >nul 2>&1

:: 3. Tat cac trinh duyet Chromium duoc mo boi du an
echo [*] Dang giai phong cac trinh duyet Chromium chay ngam...
taskkill /f /im chrome.exe >nul 2>&1

:: 4. Tat cac tien trinh MCP Server chay ngam
echo [*] Dang tat cac tien trinh MCP Server...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*chrome-devtools-mcp*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo.
echo ======================================================================
echo [OK] Da tat sach toan bo cac dich vu va giai phong bo nho RAM!
echo ======================================================================
echo.
ping 127.0.0.1 -n 4 > nul
exit
