@echo off
echo ================================================================
echo   Spotify Buddy - Starting with localtunnel
echo ================================================================
echo.

REM Check if localtunnel is installed
where lt >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [!] localtunnel not found. Installing...
    npm install -g localtunnel
    echo.
)

echo [1/2] Starting Spotify Bridge...
start "Spotify Bridge" cmd /k "cd spotify-bridge && node start.js"
timeout /t 3 >nul

echo [2/2] Starting localtunnel...
echo.
echo ----------------------------------------------------------------
echo Your HTTPS tunnel URL will appear below.
echo Copy it to OpenPets plugin config!
echo ----------------------------------------------------------------
echo.
start "Localtunnel" cmd /k "lt --port 8765"

echo.
echo ================================================================
echo   Setup Complete!
echo ================================================================
echo.
echo Next steps:
echo   1. Copy the tunnel URL from the localtunnel window
echo   2. OpenPets -^> Plugins -^> Spotify Buddy -^> Configure
echo   3. Paste URL into "Bridge URL" field
echo   4. Click "Save Config"
echo.
echo Note: URL changes each restart. Update config when needed.
echo ================================================================
pause
