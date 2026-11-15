@echo off
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"

if not exist "%PY%" (
  echo [setup] first run - preparing Python environment...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%setup.ps1"
  if errorlevel 1 goto :fail
)

"%PY%" "%HERE%app\server.py" --port 8765 --open
goto :eof

:fail
echo.
echo Setup failed. Check the messages above.
pause
