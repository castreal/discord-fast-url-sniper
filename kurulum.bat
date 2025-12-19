@echo off
title discord: c46t

echo Node.js kontrol ediliyor...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo HATA: Node.js yuklu degil! Once https://nodejs.org/ adresinden Node.js LTS surumunu indirip kurun.
    pause
    exit /b 1
)

echo Gerekli moduller yukleniyor...

if not exist package.json (
    npm init -y >nul
)

npm install ws extract-json-string >nul

if %errorlevel% equ 0 (
    echo Tum moduller basariyla yuklendi!
) else (
    echo Modul yukleme sirasinda hata olustu. Internet baglantinizi kontrol edin.
)

pause
exit
