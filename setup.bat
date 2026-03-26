@echo off
setlocal

:: Check if Node.js is installed and version is 18+
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js is not installed. Please install it from https://nodejs.org/
    pause
    exit /b
)

for /f "tokens=1,2,3 delims=." %%a in ('node -v') do (
    set node_major=%%a
)
set node_major=%node_major:~1%

if %node_major% lss 18 (
    echo.
    echo ERROR: Your Node.js version is too old ^(%node_major%^).
    echo Vite 6 requires Node.js 18.0.0 or higher.
    echo Please update Node.js at https://nodejs.org/
    echo.
    pause
    exit /b
)

echo --- BOM Viewer Setup ---
echo 1. Fixing npm registry (Taobao registry has expired)...
call npm config set registry https://registry.npmjs.org/

echo 2. Installing dependencies...
call npm install

echo 2. Starting development server...
echo The app will be available at http://localhost:3000
call npm run dev

pause
