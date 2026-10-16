# aidlc-dashboard installer -- Windows (PowerShell).
#
#     irm https://github.com/wowzoo/aidlc-dashboard/releases/latest/download/install.ps1 | iex
#
# `irm | iex` runs the script from MEMORY, so the execution policy that blocks an
# unsigned .ps1 on disk does not apply -- which is why the one-liner is this shape
# rather than "download it and run it".
#
# The same three things install.sh has to get right, for the same reasons:
#
#   1. The asset filename carries the version (`aidlc-dashboard-1.11.0.zip`), so
#      `releases/latest/download/<name>` cannot be formed without first resolving
#      which tag is latest.
#   2. `data\usage.db` is the operator's collected credit history and it lives
#      INSIDE the install dir. A naive re-install destroys it, so the new tree is
#      assembled beside the old one and `data\` is carried across.
#   3. bun is required and installs to %USERPROFILE%\.bun\bin, which a shell that
#      has not read the user profile does not have on PATH.
#
# Knobs (environment variables):
#   AIDLC_DIR       install location (default %USERPROFILE%\.aidlc-dashboard)
#   AIDLC_VERSION   pin a version instead of latest (e.g. 1.11.0)
#   AIDLC_NO_BUN=1  do not install bun even if it is missing
#   AIDLC_NO_BIN=1  do not create the launcher shim

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still defaults to TLS 1.0/1.1 on some builds, which
# github.com refuses. Set it explicitly rather than letting the download fail with
# a connection error that reads like a network problem.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # PowerShell 7 manages this itself and the type may be absent; not fatal.
}

# Path literals use FORWARD slashes on purpose: .NET accepts them on Windows too,
# and it is what makes this script runnable under pwsh on macOS/Linux -- which is how
# it was verified, since the author had no Windows machine.
$repo = 'wowzoo/aidlc-dashboard'
$dir = if ($env:AIDLC_DIR) { $env:AIDLC_DIR } else { Join-Path $HOME '.aidlc-dashboard' }
$binDir = if ($env:AIDLC_BIN_DIR) { $env:AIDLC_BIN_DIR } else { Join-Path $HOME '.local/bin' }
$bin = Join-Path $binDir 'aidlc-dashboard.cmd'

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
function Say([string]$m) { Write-Host $m }
# `throw`, not `exit`: under `irm | iex` the script runs in the caller's session, so
# `exit` closed the user's PowerShell window before they could read why it failed.
function Die([string]$m) { throw "$(T '\u2717 ')$m" }

# ---- which version ----------------------------------------------------------
if ($env:AIDLC_VERSION) {
  $tag = 'v' + ($env:AIDLC_VERSION -replace '^v', '')
} else {
  Say (T '\u25b8 \ucd5c\uc2e0 \ub9b4\ub9ac\uc2a4 \ud655\uc778...')
  # RESOLVED FROM THE REDIRECT, NOT THE API -- same reason as install.sh:
  # `github.com/<repo>/releases/latest` redirects to `/releases/tag/<tag>`, while
  # `api.github.com` is rate-limited to 60 requests/hour per IP for unauthenticated
  # callers, which a shared corporate NAT spends on the user's behalf. Only the
  # default path would break, and only for a reason the user cannot see.
  #
  # The final URL is read differently on the two PowerShell generations: 5.1 gives
  # an HttpWebResponse (`ResponseUri`), 7 gives an HttpResponseMessage
  # (`RequestMessage.RequestUri`). Both are tried rather than assuming one.
  $tag = $null
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/latest"
    $final = $null
    if ($resp.BaseResponse.PSObject.Properties['ResponseUri']) {
      $final = [string]$resp.BaseResponse.ResponseUri
    }
    if (-not $final -and $resp.BaseResponse.PSObject.Properties['RequestMessage']) {
      $final = [string]$resp.BaseResponse.RequestMessage.RequestUri
    }
    if ($final -match '/releases/tag/([^/]+)$') { $tag = $Matches[1] }
    # Last resort within the same response: the tag also appears in the page body.
    if (-not $tag -and $resp.Content -match '/releases/tag/([^"''<>\s]+)') { $tag = $Matches[1] }
  } catch {
    # Fall through to the API below -- the two fail for different reasons.
  }
  if (-not $tag) {
    try {
      $tag = (Invoke-RestMethod -UseBasicParsing `
          -Uri "https://api.github.com/repos/$repo/releases/latest").tag_name
    } catch {
      # Reported by the shared message below, which names the way out.
    }
  }
  if (-not $tag) {
    Die @"
$(T '\ucd5c\uc2e0 \ub9b4\ub9ac\uc2a4\ub97c \ud655\uc778\ud560 \uc218 \uc5c6\ub2e4 \u0028\ub124\ud2b8\uc6cc\ud06c, GitHub API \ud55c\ub3c4, \ub610\ub294 \uc800\uc7a5\uc18c\uc5d0 \uc811\uadfc\ud560 \uc218 \uc5c6\uc74c \u2014 \ube44\uacf5\uac1c \uc800\uc7a5\uc18c\ub294 \uc775\uba85 \uc694\uccad\uc5d0 404 \ub97c \uc900\ub2e4\u0029.')
$(T '  \ubc84\uc804\uc744 \uc9c0\uc815\ud558\uba74 \uc774 \uc870\ud68c\ub97c \uac74\ub108\ub6f4\ub2e4:')
    `$env:AIDLC_VERSION='1.11.0'; irm <install.ps1 URL> | iex
"@
  }
}
$ver = $tag -replace '^v', ''
$asset = "aidlc-dashboard-$ver.zip"
$url = "https://github.com/$repo/releases/download/$tag/$asset"
Say "$(T '\u25b8 ')$tag ($asset)"

# ---- download ---------------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zip = Join-Path $tmp $asset
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  } catch {
    Die "$(T '\ub0b4\ub824\ubc1b\uae30 \uc2e4\ud328: ')$url$(T ' \u2014 \ubc84\uc804\uc774 \uc5c6\uac70\ub098 \uc800\uc7a5\uc18c\uc5d0 \uc811\uadfc\ud560 \uc218 \uc5c6\ub2e4 \u0028')$_)"
  }
  if (-not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
    Die "$(T '\ub0b4\ub824\ubc1b\uc740 \ud30c\uc77c\uc774 \ube44\uc5b4 \uc788\ub2e4: ')$url"
  }

  $x = Join-Path $tmp 'x'
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
  } catch {
    Die "$(T '\uc555\ucd95\uc744 \ud480 \uc218 \uc5c6\ub2e4 \u0028')$asset): $_"
  }

  # The archive carries one top-level dir. Verify the shape rather than trusting
  # it: a wrong layout should fail here, not halfway through the swap below.
  $src = Join-Path $x 'aidlc-dashboard'
  if (-not (Test-Path (Join-Path $src 'src/server.ts'))) {
    Die (T '\uc544\uce74\uc774\ube0c \uad6c\uc870\uac00 \uc608\uc0c1\uacfc \ub2e4\ub974\ub2e4 (src/server.ts \uc5c6\uc74c).')
  }
  if (-not (Test-Path (Join-Path $src 'start.cmd'))) {
    Die (T '\uc544\uce74\uc774\ube0c \uad6c\uc870\uac00 \uc608\uc0c1\uacfc \ub2e4\ub974\ub2e4 (start.cmd \uc5c6\uc74c).')
  }

  # ---- install --------------------------------------------------------------
  # Swap, not overwrite: the new tree is complete before it is put in place, so a
  # failure above leaves the existing install untouched.
  #
  # `data\` never passes through $tmp -- the same defect install.sh had, reproduced
  # there: it moved into the new tree first, the next move failed, and `finally`
  # deleted $tmp with the credit history in it. Old tree aside, new tree in place,
  # THEN `data\` crosses; every failure leaves it on disk and says where.
  $parent = Split-Path -Parent $dir
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path $dir) {
    $old = "$dir.old.$PID"
    try {
      Move-Item -LiteralPath $dir -Destination $old
    } catch {
      Die "$(T '\uae30\uc874 \uc124\uce58\ub97c \uc62e\uae38 \uc218 \uc5c6\ub2e4: ')$dir$(T ' \u2014 \uc544\ubb34\uac83\ub3c4 \ubc14\uafb8\uc9c0 \uc54a\uc558\ub2e4. \u0028')$_)"
    }
    try {
      Move-Item -LiteralPath $src -Destination $dir
    } catch {
      try {
        Move-Item -LiteralPath $old -Destination $dir
      } catch {
        Die "$(T '\uc0c8 \uc124\uce58\ub97c \ub193\uc9c0 \ubabb\ud588\uace0 \ub418\ub3cc\ub9ac\uc9c0\ub3c4 \ubabb\ud588\ub2e4 \u2014 \uae30\uc874 \uc124\uce58\ub294 ')$old$(T ' \uc5d0 \uadf8\ub300\ub85c \uc788\ub2e4. \u0028')$_)"
      }
      Die "$(T '\uc0c8 \uc124\uce58\ub97c \ub193\uc744 \uc218 \uc5c6\ub2e4: ')$dir$(T ' \u2014 \uae30\uc874 \uc124\uce58\ub97c \ub418\ub3cc\ub838\ub2e4. \u0028')$_)"
    }
    $data = Join-Path $old 'data'
    if (Test-Path $data) {
      Say (T '\u25b8 \uae30\uc874 data\\ \ubcf4\uc874 (\uc218\uc9d1\ud55c \ud06c\ub808\ub527 \uc774\ub825)')
      try {
        Move-Item -LiteralPath $data -Destination (Join-Path $dir 'data')
      } catch {
        Die "$(T 'data\\ \ub97c \uc62e\uae30\uc9c0 \ubabb\ud588\ub2e4 \u2014 \uc218\uc9d1\ud55c \uc774\ub825\uc740 ')$data$(T ' \uc5d0 \uadf8\ub300\ub85c \uc788\ub2e4. \uc9c1\uc811 ')$(Join-Path $dir 'data')$(T ' \ub85c \uc62e\uae38 \uac83. \u0028')$_)"
      }
    }
    Remove-Item -LiteralPath $old -Recurse -Force
    Say "$(T '\u25b8 \uac31\uc2e0: ')$dir"
  } else {
    Move-Item -LiteralPath $src -Destination $dir
    Say "$(T '\u25b8 \uc124\uce58: ')$dir"
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- bun --------------------------------------------------------------------
# Probed the same way start.ps1 probes it: PATH, then the documented location a
# shell that has not read the user profile would miss.
function Find-Bun {
  $onPath = Get-Command bun -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  $c = Join-Path $HOME '.bun/bin/bun.exe'
  if (Test-Path $c) { return $c }
  return $null
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

# Prints the version line and returns the version when it is too old (else $null):
# start.ps1 refuses to run on it, so the closing message has to say so. Returned
# rather than assigned to an outer variable -- under `irm | iex` there is no script
# scope of our own to assign into. Not upgraded here -- that is the user's bun,
# possibly shared with other projects.
function Report-Bun {
  # A --version that fails is "unknown", whatever it printed.
  $v = ''
  try {
    $out = @(& $bun --version)
    if ($LASTEXITCODE -eq 0 -and $out.Count -gt 0) { $v = ([string]$out[0]).Trim() }
  } catch { }
  Say "$(T '\u25b8 bun ')$(if ($v) { $v } else { '?' }) ($bun)"
  $ok = Test-BunVersion $v
  if ($ok -eq $false) {
    Say "$(T '  \u26a0 bun ')$v$(T ' \uc740 \ub108\ubb34 \uc624\ub798\ub410\ub2e4 \u2014 ')$minBun$(T ' \uc774\uc0c1\uc774 \ud544\uc694\ud558\ub2e4. \uc5c5\uadf8\ub808\uc774\ub4dc: & ''')$bun' upgrade (scoop: scoop update bun, winget: winget upgrade Oven-sh.Bun)"
    return $v
  }
  if ($null -eq $ok) {
    Say "$(T '  \u26a0 bun \ubc84\uc804\uc744 \uc77d\uc9c0 \ubabb\ud588\ub2e4 \u2014 ')$minBun$(T ' \uc774\uc0c1\uc778\uc9c0 \ud655\uc778\ud558\uc9c0 \ubabb\ud588\ub2e4.')"
  }
  return $null
}

$bunOld = $null

$bun = Find-Bun
if ($bun) {
  $bunOld = Report-Bun
} elseif ($env:AIDLC_NO_BUN -eq '1') {
  Say (T '\u25b8 bun \uc774 \uc5c6\ub2e4 \u2014 AIDLC_NO_BUN=1 \uc774\ub77c \uc124\uce58\ub97c \uac74\ub108\ub6f4\ub2e4.')
  Say (T '  \uc9c1\uc811 \uc124\uce58: irm bun.sh/install.ps1 | iex')
} else {
  # Said out loud before doing it: this fetches and runs a THIRD-PARTY installer,
  # which is not something to slip in silently even inside an `irm | iex`.
  Say (T '\u25b8 bun \uc774 \uc5c6\ub2e4. \uacf5\uc2dd \uc124\uce58 \uc2a4\ud06c\ub9bd\ud2b8\ub97c \uc2e4\ud589\ud55c\ub2e4 (https://bun.sh/install.ps1)')
  Say (T '  \uac74\ub108\ub6f0\ub824\uba74 $env:AIDLC_NO_BUN=1 \ub85c \ub2e4\uc2dc \uc2e4\ud589\ud560 \uac83.')
  try {
    Invoke-RestMethod -UseBasicParsing -Uri 'https://bun.sh/install.ps1' | Invoke-Expression
  } catch {
    Die "$(T 'bun \uc124\uce58 \uc2e4\ud328: ')$_$(T '  \uc9c1\uc811 \uc124\uce58 \ud6c4 \ub2e4\uc2dc \uc2e4\ud589\ud560 \uac83.')"
  }
  $bun = Find-Bun
  if (-not $bun) { Die (T 'bun \uc744 \uc124\uce58\ud588\uc9c0\ub9cc \ucc3e\uc744 \uc218 \uc5c6\ub2e4. \ud130\ubbf8\ub110\uc744 \uc0c8\ub85c \uc5f4\uace0 \ub2e4\uc2dc \uc2e4\ud589\ud560 \uac83.') }
  $bunOld = Report-Bun
}

# ---- user PATH (Windows) -----------------------------------------------------
# The shim is useless until its folder is on PATH, and on Windows it almost never is:
# `aidlc-dashboard` failed with CommandNotFound on a fresh machine (2026-10-16). So the
# folder is added to the USER Path (HKCU, no elevation) -- announced first, skipped
# with AIDLC_NO_PATH=1 -- the way bun's and scoop's installers do it.
#
# Through the registry, not [Environment]::SetEnvironmentVariable: that one reads the
# value EXPANDED, so writing it back would bake `%USERPROFILE%`-style entries into
# literals. The raw value is read with DoNotExpandEnvironmentNames and written back
# with the kind it had.

# $raw with $entry appended, or $null when an entry already names the same folder
# (compared expanded, case-insensitive, trailing slash ignored).
function Join-PathEntry([string]$raw, [string]$entry) {
  $norm = { param($p) [Environment]::ExpandEnvironmentVariables($p).Trim().TrimEnd('\', '/') }
  $want = & $norm $entry
  $parts = @($raw -split ';' | Where-Object { $_ -and $_.Trim() })
  foreach ($p in $parts) { if ((& $norm $p) -ieq $want) { return $null } }
  return (@($parts) + $entry) -join ';'
}

# Tell running programs the environment changed, so a terminal opened from Explorer
# sees the new Path without signing out. Best effort: a failure costs only that.
function Publish-Env {
  try {
    if (-not ('AidlcDashboard.NativeMethods' -as [type])) {
      Add-Type -Namespace AidlcDashboard -Name NativeMethods -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    }
    $result = [UIntPtr]::Zero
    [void][AidlcDashboard.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
  }
}

# The machine Path, raw. Read-only (no elevation needed to read HKLM); '' when absent.
function Get-MachinePathRaw {
  try {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
    if (-not $key) { return '' }
    try { return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Close() }
  } catch {
    # Unreadable is treated as "not there": the user Path is then made to hold it,
    # which at worst duplicates a machine entry -- harmless, unlike a missing one.
    return ''
  }
}

# Add $entry to the user Path (if absent) and to this session. Returns $true when it
# wrote the registry, $false when the user Path already had it.
function Add-UserPath([string]$entry) {
  $wrote = $false
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { throw 'HKCU\Environment could not be opened for writing' }
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $new = Join-PathEntry $raw $entry
    if ($null -ne $new) {
      $key.SetValue('Path', $new, $kind)
      $wrote = $true
      Publish-Env
    }
  } finally {
    $key.Close()
  }
  # `irm | iex` runs in the caller's session, so this reaches the user's own window.
  if ($null -ne (Join-PathEntry $env:Path $entry)) { $env:Path = "$env:Path;$entry" }
  return $wrote
}

# ---- launcher ---------------------------------------------------------------
# A .cmd SHIM calling start.cmd by absolute path. start.cmd does `cd /d "%~dp0"`,
# so it lands in the install dir no matter where the shim sits -- the same reason
# install.sh writes a wrapper instead of a symlink.
#
# `$run` is what the closing hint tells the user to type, decided HERE: printing
# "add this to PATH" and then telling them to type the bare name is two
# instructions that contradict each other.
$run = Join-Path $dir 'start.cmd'
if ($env:AIDLC_NO_BIN -ne '1') {
  try {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    # ASCII: a .cmd read by cmd.exe should not carry a UTF-8 BOM.
    $shim = "@echo off`r`n`"$(Join-Path $dir 'start.cmd')`" %*`r`n"
    [IO.File]::WriteAllText($bin, $shim, [Text.Encoding]::ASCII)
    Say "$(T '\u25b8 \uc2e4\ud589\uae30: ')$bin"
    $onPath = ($env:PATH -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $binDir.TrimEnd('\')) })
    # On Windows the question is whether NEW terminals will find it, so it is answered
    # from the registry, not from this session: a session can carry the folder from a
    # one-off `$env:Path +=` or a stale inherited environment while the user Path lacks
    # it -- then the shim worked here and nowhere else (seen 2026-10-16). The machine
    # Path counts as present; otherwise the user Path is made to hold it.
    $winPath = $env:OS -eq 'Windows_NT' -and $env:AIDLC_NO_PATH -ne '1'
    if ($winPath -and $null -eq (Join-PathEntry (Get-MachinePathRaw) $binDir)) {
      if (-not $onPath) { $env:Path = "$env:Path;$binDir" }
      $run = 'aidlc-dashboard'
    } elseif ($winPath) {
      Say "$(T '\u25b8 \uc0ac\uc6a9\uc790 PATH \ud655\uc778: ')$binDir$(T ' \u0028\uac74\ub108\ub6f0\ub824\uba74 AIDLC_NO_PATH=1\u0029')"
      try {
        $wrote = Add-UserPath $binDir
        $run = 'aidlc-dashboard'
        if ($wrote) {
          Say (T '  \ucd94\uac00\ud588\ub2e4. \uc0c8\ub85c \uc5ec\ub294 \ud130\ubbf8\ub110\uc5d0\uc11c\ub3c4 aidlc-dashboard \ub85c \uc2e4\ud589\ub418\uace0, \uc774 \ucc3d\uc5d0\ub294 \uc774\ubbf8 \uc801\uc6a9\ud588\ub2e4.')
        } else {
          Say (T '  \uc774\ubbf8 \uc0ac\uc6a9\uc790 PATH \uc5d0 \uc788\ub2e4 \u2014 \uc774 \ucc3d\uc5d0\ub3c4 \uc801\uc6a9\ud588\ub2e4.')
        }
      } catch {
        Say "$(T '  \u26a0 PATH \uc5d0 \ucd94\uac00\ud558\uc9c0 \ubabb\ud588\ub2e4 \u2014 \uc9c1\uc811 \ucd94\uac00\ud560 \uac83: ')$binDir$(T ' \u0028')$_$(T '\u0029')"
      }
    } elseif ($onPath) {
      $run = 'aidlc-dashboard'
    } else {
      Say "$(T '  \u26a0 ')$binDir$(T ' \uc774 PATH \uc5d0 \uc5c6\ub2e4. \uc178 \uc124\uc815\uc5d0 \ucd94\uac00\ud558\uba74 \uc774\ub984\ub9cc\uc73c\ub85c \uc2e4\ud589\ud560 \uc218 \uc788\ub2e4.')"
    }
  } catch {
    Say "$(T '\u25b8 ')$binDir$(T ' \uc5d0 \uc2e4\ud589\uae30\ub97c \ub9cc\ub4e4 \uc218 \uc5c6\uc5b4 \uac74\ub108\ub6f4\ub2e4: ')$_"
  }
}

# ---- done -------------------------------------------------------------------
Say ''
Say "$(T '\uc124\uce58 \uc644\ub8cc \u2014 v')$ver"
if ($bunOld) {
  # Repeated at the end because it is the one thing standing between this install and
  # a working launch: start.ps1 stops on this bun.
  Say ''
  Say "$(T '  \u26a0 \uba3c\uc800 bun \uc744 ')$minBun$(T ' \uc774\uc0c1\uc73c\ub85c \uc62c\ub9b4 \uac83 \u0028\uc9c0\uae08 ')$bunOld): & '$bun' upgrade (scoop: scoop update bun, winget: winget upgrade Oven-sh.Bun)"
}
Say ''
Say "  $run"
Say "  $run C:\path\to\workspace"
Say ''
Say (T '  \uc77d\uae30 \uc804\uc6a9 \u2014 \uc774 \ub300\uc2dc\ubcf4\ub4dc\ub294 \uc6cc\ud06c\uc2a4\ud398\uc774\uc2a4\uc5d0 \uc4f0\uc9c0 \uc54a\ub294\ub2e4.')
