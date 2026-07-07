@echo off
title Khoidong Chromium Portable v2.10.4
color 0B
chcp 65001 > nul

echo ======================================================================
echo          KHOI DONG HE THONG CHROMIUM PORTABLE v2.10.4
echo ======================================================================
echo.

:: Lay duong dan thu muc hien tai
set "ROOT_DIR=%~dp0"
cd /d "%ROOT_DIR%"

:: Step 1: Kiem tra Node.js
echo [*] Buoc 1: Kiem tra moi truong Node.js...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    color 0C
    echo [LOI] Khong tim thay Node.js tren may tinh cua ban!
    echo [!] Vui long tai va cai dat Node.js tu https://nodejs.org/ truoc khi chay.
    echo.
    pause
    exit /b
)
echo [OK] Node.js da duoc cai dat.
echo.

:: Step 2: Khoi chay bang launcher JS thong minh v2.10.4
echo [*] Buoc 2: Chuyen giao khoi dong cho NodeJS Launcher v2.10.4...
echo.
node launcher_v2.10.4.js

if %errorlevel% neq 0 (
    color 0C
    echo.
    echo [LOI] Co loi xay ra khi chay chuong trinh khoi dong launcher_v2.10.4.js!
    echo [!] Hay chac chan rang ban dang mo file bat nay trong thu muc chua du an.
    echo.
    pause
)
exit
