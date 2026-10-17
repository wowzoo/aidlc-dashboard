@echo off
REM aidlc-dashboard launcher — Windows (cmd). Run it from a terminal.
REM
REM Exists to call start.ps1 with the execution policy bypassed: a fresh Windows
REM refuses to run unsigned .ps1 files, so `.\start.ps1` can fail outright where
REM this wrapper works. -Bypass applies to THIS invocation only; it changes no
REM machine setting. Use start.ps1 directly if your policy already allows it.
REM
REM usage:
REM   start.cmd
REM   start.cmd C:\path\to\workspace
REM   start.cmd --port 5000

setlocal
REM Remember where the user ran this BEFORE moving: the picker searches it first.
if not defined AIDLC_DASHBOARD_LAUNCH_DIR set "AIDLC_DASHBOARD_LAUNCH_DIR=%CD%"
cd /d "%~dp0"

REM Prefer PowerShell 7+ (pwsh) when present, else Windows PowerShell 5.1.
REM `where /q` sets ERRORLEVEL 0 on a hit.
where /q pwsh.exe
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
) else (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
)

REM Hand start.ps1's exit status back to the caller: a bare `endlocal` at the end
REM returned 0 even when start.ps1 stopped with 1 (bun missing or too old -- seen on
REM Windows 2026-10-16). %ERRORLEVEL% is expanded when this line is parsed, i.e.
REM before endlocal runs.
endlocal & exit /b %ERRORLEVEL%
