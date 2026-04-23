# ADA Standalone Server Launcher (PowerShell)
# Starts ADA as her own independent server on port 9001
# ====================================================

Write-Host ""
Write-Host "╔════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║    ADA STANDALONE SERVER LAUNCHER      ║" -ForegroundColor Cyan
Write-Host "║    Running on port 9001                ║" -ForegroundColor Cyan
Write-Host "║    Creator: jeff                       ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Set working directory to backend
Set-Location -Path $PSScriptRoot

# Check if virtual environment exists
if (-not (Test-Path ".venv\Scripts\Activate.ps1")) {
    Write-Host "ERROR: Virtual environment not found!" -ForegroundColor Red
    Write-Host "Please run setup in the backend directory first" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# Activate virtual environment
& ".venv\Scripts\Activate.ps1"

# Set port
$env:ADA_STANDALONE_PORT = 9001
$env:ADA_STANDALONE_HOST = "127.0.0.1"

Write-Host "Starting ADA Standalone Server..." -ForegroundColor Green
Write-Host "Server will be available at: http://127.0.0.1:9001" -ForegroundColor Yellow
Write-Host "" 

# Start ADA standalone server
python ada_standalone_server.py
