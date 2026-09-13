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
#   1. The asset filename carries the version (`aidlc-dashboard-1.7.0.zip`), so
#      `releases/latest/download/<name>` cannot be formed without first asking the
#      API which tag is latest.
#   2. `data\usage.db` is the operator's collected credit history and it lives
#      INSIDE the install dir. A naive re-install destroys it, so the new tree is
#      assembled beside the old one and `data\` is carried across.
#   3. bun is required and installs to %USERPROFILE%\.bun\bin, which a shell that
#      has not read the user profile does not have on PATH.
#
# Knobs (environment variables):
#   AIDLC_DIR       install location (default %USERPROFILE%\.aidlc-dashboard)
#   AIDLC_VERSION   pin a version instead of latest (e.g. 1.7.0)
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
function Die([string]$m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

# ---- which version ----------------------------------------------------------
if ($env:AIDLC_VERSION) {
  $tag = 'v' + ($env:AIDLC_VERSION -replace '^v', '')
} else {
  Say '▸ 최신 릴리스 확인...'
  try {
    # Invoke-RestMethod parses the JSON, so unlike install.sh there is no sed here.
    $tag = (Invoke-RestMethod -UseBasicParsing `
        -Uri "https://api.github.com/repos/$repo/releases/latest").tag_name
  } catch {
    Die "최신 릴리스를 확인할 수 없다. `$env:AIDLC_VERSION='1.7.0'` 처럼 지정해 볼 것. ($_)"
  }
  if (-not $tag) { Die '최신 릴리스에 tag_name 이 없다.' }
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
    Die "내려받기 실패: $url ($_)"
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
  $parent = Split-Path -Parent $dir
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path $dir) {
    $data = Join-Path $dir 'data'
    if (Test-Path $data) {
      Say '▸ 기존 data\ 보존 (수집한 크레딧 이력)'
      Move-Item -LiteralPath $data -Destination (Join-Path $src 'data')
    }
    $old = "$dir.old.$PID"
    Move-Item -LiteralPath $dir -Destination $old
    Move-Item -LiteralPath $src -Destination $dir
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

$bun = Find-Bun
if ($bun) {
  Say "▸ bun $(& $bun --version) ($bun)"
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
  Say "▸ bun $(& $bun --version) ($bun)"
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
Say ''
Say "  $run"
Say "  $run C:\path\to\workspace"
Say ''
Say '  읽기 전용 — 이 대시보드는 워크스페이스에 쓰지 않는다.'
