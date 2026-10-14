# aidlc-dashboard installer — Windows (PowerShell).
#
#     irm https://github.com/wowzoo/aidlc-dashboard/releases/latest/download/install.ps1 | iex
#
# `irm | iex` runs the script from MEMORY, so the execution policy that blocks an
# unsigned .ps1 on disk does not apply — which is why the one-liner is this shape
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
# and it is what makes this script runnable under pwsh on macOS/Linux — which is how
# it was verified, since the author had no Windows machine.
$repo = 'wowzoo/aidlc-dashboard'
$dir = if ($env:AIDLC_DIR) { $env:AIDLC_DIR } else { Join-Path $HOME '.aidlc-dashboard' }
$binDir = if ($env:AIDLC_BIN_DIR) { $env:AIDLC_BIN_DIR } else { Join-Path $HOME '.local/bin' }
$bin = Join-Path $binDir 'aidlc-dashboard.cmd'

function Say([string]$m) { Write-Host $m }
# `throw`, not `exit`: under `irm | iex` the script runs in the caller's session, so
# `exit` closed the user's PowerShell window before they could read why it failed.
function Die([string]$m) { throw "✗ $m" }

# ---- which version ----------------------------------------------------------
if ($env:AIDLC_VERSION) {
  $tag = 'v' + ($env:AIDLC_VERSION -replace '^v', '')
} else {
  Say '▸ 최신 릴리스 확인...'
  # RESOLVED FROM THE REDIRECT, NOT THE API — same reason as install.sh:
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
    # Fall through to the API below — the two fail for different reasons.
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
최신 릴리스를 확인할 수 없다 (네트워크, GitHub API 한도, 또는 저장소에 접근할 수 없음 — 비공개 저장소는 익명 요청에 404 를 준다).
  버전을 지정하면 이 조회를 건너뛴다:
    `$env:AIDLC_VERSION='1.11.0'; irm <install.ps1 URL> | iex
"@
  }
}
$ver = $tag -replace '^v', ''
$asset = "aidlc-dashboard-$ver.zip"
$url = "https://github.com/$repo/releases/download/$tag/$asset"
Say "▸ $tag ($asset)"

# ---- download ---------------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zip = Join-Path $tmp $asset
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
  } catch {
    Die "내려받기 실패: $url — 버전이 없거나 저장소에 접근할 수 없다 ($_)"
  }
  if (-not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
    Die "내려받은 파일이 비어 있다: $url"
  }

  $x = Join-Path $tmp 'x'
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
  } catch {
    Die "압축을 풀 수 없다 ($asset): $_"
  }

  # The archive carries one top-level dir. Verify the shape rather than trusting
  # it: a wrong layout should fail here, not halfway through the swap below.
  $src = Join-Path $x 'aidlc-dashboard'
  if (-not (Test-Path (Join-Path $src 'src/server.ts'))) {
    Die '아카이브 구조가 예상과 다르다 (src/server.ts 없음).'
  }
  if (-not (Test-Path (Join-Path $src 'start.cmd'))) {
    Die '아카이브 구조가 예상과 다르다 (start.cmd 없음).'
  }

  # ---- install --------------------------------------------------------------
  # Swap, not overwrite: the new tree is complete before it is put in place, so a
  # failure above leaves the existing install untouched.
  #
  # `data\` never passes through $tmp — the same defect install.sh had, reproduced
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
      Die "기존 설치를 옮길 수 없다: $dir — 아무것도 바꾸지 않았다. ($_)"
    }
    try {
      Move-Item -LiteralPath $src -Destination $dir
    } catch {
      try {
        Move-Item -LiteralPath $old -Destination $dir
      } catch {
        Die "새 설치를 놓지 못했고 되돌리지도 못했다 — 기존 설치는 $old 에 그대로 있다. ($_)"
      }
      Die "새 설치를 놓을 수 없다: $dir — 기존 설치를 되돌렸다. ($_)"
    }
    $data = Join-Path $old 'data'
    if (Test-Path $data) {
      Say '▸ 기존 data\ 보존 (수집한 크레딧 이력)'
      try {
        Move-Item -LiteralPath $data -Destination (Join-Path $dir 'data')
      } catch {
        Die "data\ 를 옮기지 못했다 — 수집한 이력은 $data 에 그대로 있다. 직접 $(Join-Path $dir 'data') 로 옮길 것. ($_)"
      }
    }
    Remove-Item -LiteralPath $old -Recurse -Force
    Say "▸ 갱신: $dir"
  } else {
    Move-Item -LiteralPath $src -Destination $dir
    Say "▸ 설치: $dir"
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

# package.json's `engines.bun` floor — src/test/bun-floor.test.ts pins this copy to it.
$minBun = [version]'1.4.0'

# $true = at least $minBun, $false = older, $null = not a version. Only the leading
# X.Y.Z counts, so a canary of a later release (`1.4.3-canary.1+abc`) reads as that
# release — but a prerelease of exactly $minBun (`1.4.0-canary.1`) is below it, as
# semver orders it. The same rule as start.sh / install.sh / src/version.ts.
function Test-BunVersion([string]$v) {
  if (-not ($v -match '^v?(\d+)\.(\d+)\.(\d+)(-)?')) { return $null }
  $pre = [bool]$Matches[4]
  # [version] throws on a component past Int32 — that is "not a version", not a crash.
  try { $have = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" } catch { return $null }
  if ($have -ne $minBun) { return ($have -gt $minBun) }
  return (-not $pre)
}

# Prints the version line and returns the version when it is too old (else $null):
# start.ps1 refuses to run on it, so the closing message has to say so. Returned
# rather than assigned to an outer variable — under `irm | iex` there is no script
# scope of our own to assign into. Not upgraded here — that is the user's bun,
# possibly shared with other projects.
function Report-Bun {
  # A --version that fails is "unknown", whatever it printed.
  $v = ''
  try {
    $out = @(& $bun --version)
    if ($LASTEXITCODE -eq 0 -and $out.Count -gt 0) { $v = ([string]$out[0]).Trim() }
  } catch { }
  Say "▸ bun $(if ($v) { $v } else { '?' }) ($bun)"
  $ok = Test-BunVersion $v
  if ($ok -eq $false) {
    Say "  ⚠ bun $v 은 너무 오래됐다 — $minBun 이상이 필요하다. 업그레이드: & '$bun' upgrade (scoop: scoop update bun, winget: winget upgrade Oven-sh.Bun)"
    return $v
  }
  if ($null -eq $ok) {
    Say "  ⚠ bun 버전을 읽지 못했다 — $minBun 이상인지 확인하지 못했다."
  }
  return $null
}

$bunOld = $null

$bun = Find-Bun
if ($bun) {
  $bunOld = Report-Bun
} elseif ($env:AIDLC_NO_BUN -eq '1') {
  Say '▸ bun 이 없다 — AIDLC_NO_BUN=1 이라 설치를 건너뛴다.'
  Say '  직접 설치: irm bun.sh/install.ps1 | iex'
} else {
  # Said out loud before doing it: this fetches and runs a THIRD-PARTY installer,
  # which is not something to slip in silently even inside an `irm | iex`.
  Say '▸ bun 이 없다. 공식 설치 스크립트를 실행한다 (https://bun.sh/install.ps1)'
  Say '  건너뛰려면 $env:AIDLC_NO_BUN=1 로 다시 실행할 것.'
  try {
    Invoke-RestMethod -UseBasicParsing -Uri 'https://bun.sh/install.ps1' | Invoke-Expression
  } catch {
    Die "bun 설치 실패: $_  직접 설치 후 다시 실행할 것."
  }
  $bun = Find-Bun
  if (-not $bun) { Die 'bun 을 설치했지만 찾을 수 없다. 터미널을 새로 열고 다시 실행할 것.' }
  $bunOld = Report-Bun
}

# ---- launcher ---------------------------------------------------------------
# A .cmd SHIM calling start.cmd by absolute path. start.cmd does `cd /d "%~dp0"`,
# so it lands in the install dir no matter where the shim sits — the same reason
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
    Say "▸ 실행기: $bin"
    $onPath = ($env:PATH -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $binDir.TrimEnd('\')) })
    if ($onPath) {
      $run = 'aidlc-dashboard'
    } else {
      Say "  ⚠ $binDir 이 PATH 에 없다. 셸 설정에 추가하면 이름만으로 실행할 수 있다."
    }
  } catch {
    Say "▸ $binDir 에 실행기를 만들 수 없어 건너뛴다: $_"
  }
}

# ---- done -------------------------------------------------------------------
Say ''
Say "설치 완료 — v$ver"
if ($bunOld) {
  # Repeated at the end because it is the one thing standing between this install and
  # a working launch: start.ps1 stops on this bun.
  Say ''
  Say "  ⚠ 먼저 bun 을 $minBun 이상으로 올릴 것 (지금 $bunOld): & '$bun' upgrade (scoop: scoop update bun, winget: winget upgrade Oven-sh.Bun)"
}
Say ''
Say "  $run"
Say "  $run C:\path\to\workspace"
Say ''
Say '  읽기 전용 — 이 대시보드는 워크스페이스에 쓰지 않는다.'
