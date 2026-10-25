@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-windows.ps1" %*
set "sidecarExit=%ERRORLEVEL%"
if not "%sidecarExit%"=="0" (
  echo.
  echo Sidecar exited with code %sidecarExit%. The existing DSH installation was not changed.
  pause
)
exit /b %sidecarExit%
