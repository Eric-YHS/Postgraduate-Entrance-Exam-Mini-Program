param(
    [ValidateSet('student', 'teacher')]
    [string]$Page = 'student'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$wslDistro = 'Ubuntu'
$wslConfig = Join-Path $env:USERPROFILE '.wslconfig'

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'start-local-wsl.sh'))) {
    throw 'Required file start-local-wsl.sh was not found in the project folder.'
}

# Undo only the networking settings introduced by this launcher. Default WSL
# networking restores the Windows localhost forwarding that the app used before.
if (Test-Path -LiteralPath $wslConfig) {
    $lines = @(Get-Content -LiteralPath $wslConfig)
    $lines = @($lines | Where-Object {
        $_ -notmatch '^\s*networkingMode\s*=' -and
        $_ -notmatch '^\s*localhostForwarding\s*='
    })
    Set-Content -LiteralPath $wslConfig -Value ($lines -join "`r`n") -Encoding utf8
}

Write-Host 'Restarting WSL with default local networking...' -ForegroundColor Cyan
& wsl.exe --shutdown
Start-Sleep -Seconds 2

Write-Host 'Starting Yanban AI local services...' -ForegroundColor Cyan
& wsl.exe -d $wslDistro --cd "$projectRoot" -- bash ./start-local-wsl.sh
if ($LASTEXITCODE -ne 0) {
    throw "Yanban AI backend startup failed (exit code: $LASTEXITCODE)."
}

$pageFile = if ($Page -eq 'teacher') { 'teacher.html' } else { 'student.html' }
$version = (Get-Item -LiteralPath (Join-Path $projectRoot $pageFile)).LastWriteTimeUtc.Ticks
$pageUrl = 'http://127.0.0.1:4173/' + $pageFile + '?v=' + $version

Start-Process $pageUrl
Write-Host ('Local service started. Opening ' + $Page + ' page...') -ForegroundColor Green
