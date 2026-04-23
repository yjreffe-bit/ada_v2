$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $repoRoot "backend"
$lanIp = (
	Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
	Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
	Select-Object -First 1 -ExpandProperty IPAddress
)
if (-not $lanIp) {
	$lanIp = "<your-lan-ip>"
}

Write-Host "Starting ADA LAN stack..." -ForegroundColor Green
Write-Host "Backend:  http://0.0.0.0:8000" -ForegroundColor Yellow
Write-Host "Frontend: http://0.0.0.0:5173" -ForegroundColor Yellow
Write-Host "Open on phone: http://$lanIp:5173" -ForegroundColor Cyan
Write-Host ""

$backendCmd = "Set-Location '$backendPath'; python -m uvicorn server:app_socketio --host 0.0.0.0 --port 8000"
$frontendCmd = "Set-Location '$repoRoot'; npm run dev:mobile"

Start-Process powershell -ArgumentList "-NoExit", "-Command", $backendCmd | Out-Null
Start-Process powershell -ArgumentList "-NoExit", "-Command", $frontendCmd | Out-Null

Write-Host "Two terminal windows were launched." -ForegroundColor Green
Write-Host "Press Ctrl+C in each terminal to stop services." -ForegroundColor DarkGray
