@echo off
setlocal

set NSSM="C:\tools\nssm\win64\nssm.exe"
set SERVICE=HelpDeskBot
set LOGFILE=C:\bots\HelpD\logs\stdout.log

echo ===============================
echo 1. Останавливаю службу %SERVICE%...
echo ===============================
%NSSM% stop %SERVICE%

echo.
echo Жду 10 секунд, чтобы Chrome успел корректно закрыться...
timeout /t 10 /nobreak >nul

echo.
echo ===============================
echo 2. Проверяю зависшие процессы (только сессия служб, ваш личный браузер не трогаю)...
echo ===============================
taskkill /F /FI "IMAGENAME eq node.exe" /FI "SESSION eq 0" 2>nul
taskkill /F /FI "IMAGENAME eq chrome.exe" /FI "SESSION eq 0" 2>nul

echo.
echo ===============================
echo 3. Запускаю службу %SERVICE%...
echo ===============================
%NSSM% start %SERVICE%

echo.
echo Жду 15 секунд, чтобы WhatsApp-клиент успел подняться...
timeout /t 15 /nobreak >nul

echo.
echo ===============================
echo 4. Статус и последние строки лога:
echo ===============================
curl -s http://localhost:3000/admin/bot-status
echo.
echo.
powershell -command "Get-Content '%LOGFILE%' -Tail 15"

endlocal
