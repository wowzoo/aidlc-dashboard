# aidlc-dashboard launcher -- Windows (PowerShell).
#
# Run from a terminal:
#
#     .\start.ps1
#     .\start.ps1 C:\path\to\workspace
#     .\start.ps1 --port 5000 --poll 0
#
# If Windows blocks this file ("running scripts is disabled on this system" -- a
# fresh install refuses unsigned .ps1), run start.cmd instead: it calls this with
# -ExecutionPolicy Bypass for that one invocation and changes no machine setting.
#
# WHY THIS EXISTS RATHER THAN JUST `bun run src/server.ts`:
#   1. bun installs to %USERPROFILE%\.bun\bin, which is on PATH only for shells
#      that have read the user profile. We probe the known locations too.
#   2. First run needs `bun install`.
#   3. The browser should open by itself, and only once the port answers.

param(
  # Everything is forwarded to the server; a bare first argument is treated as the
  # workspace path so --root can be omitted.
  #
  # (!) NOT named $Args: `$args` is a PowerShell AUTOMATIC variable (see
  # about_Automatic_Variables), so declaring a parameter by that name collides
  # with the engine's own. Also no [CmdletBinding()] here -- an advanced function
  # parses `--port` as a malformed parameter name and fails before the script body
  # runs; a plain param block passes the tokens through verbatim.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Passthru
)

# Korean text is written as \uXXXX escapes and decoded by T at run time, so this
# file stays pure ASCII. It has to: `irm | iex` under Windows PowerShell 5.1 decodes a
# response with no charset (GitHub serves release assets as application/octet-stream)
# as ISO-8859-1, and reads a BOM-less file from disk in the ANSI code page -- either
# way UTF-8 Korean arrived as mojibake. Parentheses inside a $(T '...') are escaped as
# well (\u0028 \u0029): PowerShell counts them even inside quotes when it looks for the
# end of $( ) in a double-quoted string, so an unbalanced one swallowed what followed.
# src/test/ps1-ascii.test.ts pins both. To read a message, run
# [regex]::Unescape('<the escaped text>') in any PowerShell.
function T([string]$s) { [regex]::Unescape($s) }

$ErrorActionPreference = 'Stop'

# Remember where the user ran this BEFORE moving: the picker searches it first.
# start.cmd sets it already (it moves before calling us), so only fill it when absent.
if (-not $env:AIDLC_DASHBOARD_LAUNCH_DIR) {
  $env:AIDLC_DASHBOARD_LAUNCH_DIR = (Get-Location).ProviderPath
}

# Run from the script's own directory so relative paths hold no matter where the
# script was invoked from.
Set-Location -LiteralPath $PSScriptRoot

function Find-Bun {
  # PATH first (a terminal run), then the documented install locations.
  $onPath = Get-Command bun -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $candidates = @(
    (Join-Path $env:USERPROFILE '.bun\bin\bun.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'),
    'C:\Program Files\bun\bun.exe'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

$bun = Find-Bun
if (-not $bun) {
  Write-Host ''
  Write-Host (T '\u2717 bun \uc744 \ucc3e\uc9c0 \ubabb\ud588\ub2e4.') -ForegroundColor Red
  Write-Host ''
  Write-Host (T 'AI-DLC \ub294 bun \uc774 \ud544\uc218\ub2e4. PowerShell \uc5d0\uc11c \uc124\uce58:')
  Write-Host '    powershell -c "irm bun.sh/install.ps1 | iex"' -ForegroundColor Cyan
  Write-Host ''
  Write-Host (T '\uc124\uce58 \ud6c4 \ud130\ubbf8\ub110\uc744 \uc0c8\ub85c \uc5f4\uace0 \ub2e4\uc2dc \uc2e4\ud589\ud55c\ub2e4.')
  Write-Host ''
  # No Read-Host: exiting non-zero is enough for a terminal run, and prompting
  # would block a caller that just wants the exit status.
  exit 1
}

# package.json's `engines.bun` floor -- src/test/bun-floor.test.ts pins this copy to it.
$minBun = [version]'1.4.0'

# $true = at least $minBun, $false = older, $null = not a version. Only the leading
# X.Y.Z counts, so a canary of a later release (`1.4.3-canary.1+abc`) reads as that
# release -- but a prerelease of exactly $minBun (`1.4.0-canary.1`) is below it, as
# semver orders it. The same rule as start.sh / install.sh / src/version.ts.
function Test-BunVersion([string]$v) {
  if (-not ($v -match '^v?(\d+)\.(\d+)\.(\d+)(-)?')) { return $null }
  $pre = [bool]$Matches[4]
  # [version] throws on a component past Int32 -- that is "not a version", not a crash.
  try { $have = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" } catch { return $null }
  if ($have -ne $minBun) { return ($have -gt $minBun) }
  return (-not $pre)
}

# A too-old bun fails later and obscurely, so stop here and say how to fix it.
# First line only, and never fatal to read: an odd bun is "unknown", not a crash.
# A --version that fails is "unknown", whatever it printed.
$bunVersion = ''
try {
  $out = @(& $bun --version)
  if ($LASTEXITCODE -eq 0 -and $out.Count -gt 0) { $bunVersion = ([string]$out[0]).Trim() }
} catch { }
Write-Host "> bun $(if ($bunVersion) { $bunVersion } else { '?' }) ($bun)"
$bunOk = Test-BunVersion $bunVersion
if ($bunOk -eq $false) {
  Write-Host ''
  Write-Host "$(T '\u2717 bun ')$bunVersion$(T ' \uc740 \ub108\ubb34 \uc624\ub798\ub410\ub2e4 \u2014 ')$minBun$(T ' \uc774\uc0c1\uc774 \ud544\uc694\ud558\ub2e4.')" -ForegroundColor Red
  Write-Host ''
  Write-Host "    & '$bun' upgrade" -ForegroundColor Cyan
  Write-Host (T '    (scoop \uc73c\ub85c \uc124\uce58\ud588\ub2e4\uba74 scoop update bun, winget \uc774\uba74 winget upgrade Oven-sh.Bun)')
  Write-Host ''
  Write-Host (T '\uc5c5\uadf8\ub808\uc774\ub4dc \ud6c4 \ub2e4\uc2dc \uc2e4\ud589\ud55c\ub2e4.')
  Write-Host ''
  exit 1
} elseif ($null -eq $bunOk) {
  # Unknown is not "too old": say so and carry on rather than blocking a bun whose
  # version string this script simply cannot read.
  Write-Host "$(T '  \u26a0 bun \ubc84\uc804\uc744 \uc77d\uc9c0 \ubabb\ud588\ub2e4 \u2014 ')$minBun$(T ' \uc774\uc0c1\uc778\uc9c0 \ud655\uc778\ud558\uc9c0 \uc54a\uace0 \uacc4\uc18d\ud55c\ub2e4.')" -ForegroundColor Yellow
}

# ---- dependencies -----------------------------------------------------------
if (-not (Test-Path -LiteralPath 'node_modules')) {
  Write-Host (T '> \uc758\uc874\uc131 \uc124\uce58 (\ucd5c\ucd08 1\ud68c)...')
  & $bun install
  if ($LASTEXITCODE -ne 0) { throw (T 'bun install \uc2e4\ud328') }
}

# ---- arguments --------------------------------------------------------------
$serverArgs = @()
$rest = @($Passthru | Where-Object { $_ -ne $null -and $_ -ne '' })

# A bare first argument is the workspace path.
if ($rest.Count -gt 0 -and -not $rest[0].StartsWith('-')) {
  $serverArgs += '--root'
  $serverArgs += $rest[0]
  $rest = @($rest | Select-Object -Skip 1)
}
$serverArgs += $rest

# Read the port back out so the browser opens the right URL.
$port = 4321
for ($i = 0; $i -lt $serverArgs.Count; $i++) {
  if ($serverArgs[$i] -eq '--port' -and ($i + 1) -lt $serverArgs.Count) {
    $port = $serverArgs[$i + 1]
  }
}
$url = "http://127.0.0.1:$port"

# ---- open the browser once the port answers ---------------------------------
# A background job, because the server has to start before there is anything to
# open. Polling beats a fixed sleep -- a cold start is fast, a big audit log is not.
#
# 127.0.0.1, NOT localhost -- for the probe and the browser alike. The server binds
# 127.0.0.1 only, and `localhost` resolves to ::1 first; Windows answers a refused
# connect after ~2s of SYN retries, so under Windows PowerShell 5.1 every 1s probe of
# localhost timed out before it fell back to IPv4 and the browser never opened
# (measured 2026-10-16: 40 of 40 probes failed, while 127.0.0.1 answered on the
# first). One address for both also means the browser lands on the socket the probe
# saw, not on whatever else may hold [::1]:$port.
$opener = Start-Job -ScriptBlock {
  param($u)
  for ($n = 0; $n -lt 40; $n++) {   # ~10s ceiling
    try {
      Invoke-WebRequest -Uri "$u/healthz" -TimeoutSec 1 -UseBasicParsing | Out-Null
      Start-Process $u
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
} -ArgumentList $url

Write-Host "> $url$(T '  \u0028Ctrl+C \ub85c \uc885\ub8cc\u0029')"
Write-Host ''

try {
  & $bun run src/server.ts @serverArgs
} finally {
  # Do not leave the poller behind if the server exits early.
  Remove-Job -Job $opener -Force -ErrorAction SilentlyContinue
}

# Pass the server's exit status on. `powershell -File` ends with 0 when the script
# runs off its end, whatever the last native command returned, so without this a
# server that died (port in use, bad --root) left start.cmd reporting success
# (measured 2026-10-17).
exit $LASTEXITCODE
