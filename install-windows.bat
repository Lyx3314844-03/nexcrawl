@echo off
REM ============================================
REM NexCrawl / OmniCrawl Windows Installer
REM ============================================

echo.
echo ========================================
echo   NexCrawl Windows Installation Script
echo ========================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not installed.
    echo Please install Node.js (v20 or higher) from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

REM Check Node.js version
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo [INFO] Node.js version: %NODE_VERSION%

REM Check npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm is not installed.
    pause
    exit /b 1
)

echo.
echo [INFO] Installing dependencies...
call npm install

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [INFO] Installation completed successfully!
echo.
echo ========================================
echo   Next Steps:
echo ========================================
echo.
echo 1. Start the server:
echo    npm start
echo.
echo 2. Open dashboard:
echo    http://127.0.0.1:3100/dashboard
echo.
echo 3. Run demo workflow:
echo    npm run run:demo
echo.
echo 4. View CLI options:
echo    node src/cli.js --help
echo.
echo Documentation: https://github.com/Lyx3314844-03/nexcrawl
echo.
pause
