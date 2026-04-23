@echo off
REM ADA Standalone Server Launcher
REM Starts ADA as her own independent server on port 9001
REM ====================================================

echo.
echo   ╔════════════════════════════════════════╗
echo   ║    ADA STANDALONE SERVER LAUNCHER      ║
echo   ║    Running on port 9001                ║
echo   ║    Creator: jeff                       ║
echo   ╚════════════════════════════════════════╝
echo.

cd /d "%~dp0"

REM Check if virtual environment exists
if not exist ".venv\Scripts\activate.bat" (
    echo ERROR: Virtual environment not found!
    echo Please run setup in the backend directory first
    pause
    exit /b 1
)

REM Activate virtual environment
call .venv\Scripts\activate.bat

REM Set port
set ADA_STANDALONE_PORT=9001

REM Start ADA standalone server
echo Starting ADA Standalone Server...
echo.
python ada_standalone_server.py

pause
