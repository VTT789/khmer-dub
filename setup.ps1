# One-time setup for YouTube Khmer Dub.
# Finds a Python 3.10+ interpreter, creates .venv, installs edge-tts + yt-dlp.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$candidates = @()
if ($env:YTDUB_PYTHON) { $candidates += $env:YTDUB_PYTHON }
$candidates += (Join-Path $env:LOCALAPPDATA "Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\python\python.exe")
$python = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $python = $c; break }
}
if (-not $python) {
  foreach ($name in @("py", "python")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $python = $cmd.Source; break }
  }
}
if (-not $python) {
  throw "No Python found. Install Python 3.10+ or set YTDUB_PYTHON to python.exe."
}
Write-Host "Using Python: $python"

$venv = Join-Path $here ".venv"
$vpy = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $vpy)) {
  # Prefer a venv that can reuse the host's pip (works when ensurepip is absent).
  & $python -m venv --system-site-packages --without-pip $venv 2>$null
  if (-not (Test-Path $vpy)) { & $python -m venv $venv }
  if (-not (Test-Path $vpy)) { throw "Could not create .venv" }
}

$tmp = Join-Path $here ".tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$env:TMP = $tmp
$env:TEMP = $tmp
$env:PYTHONPATH = (Join-Path $here "tools\tmppatch")

Write-Host "Installing edge-tts, yt-dlp, ffmpeg and Whisper (first run, ~2-3 minutes)..."
& $vpy -m pip install --disable-pip-version-check --no-input --upgrade --no-cache-dir edge-tts yt-dlp imageio-ffmpeg faster-whisper
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

Write-Host ""
Write-Host "Setup complete. Start the app with: run.cmd"
