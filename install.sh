#!/bin/sh
# aidlc-dashboard installer — macOS / Linux.
#
#   curl -fsSL https://github.com/wowzoo/aidlc-dashboard/releases/latest/download/install.sh | sh
#
# WHY A SEPARATE SCRIPT AND NOT "download the zip and unzip it". Three things have
# to happen in order and one of them is destructive if you get it wrong:
#
#   1. The asset filename carries the version (`aidlc-dashboard-1.7.0.zip`), so
#      `releases/latest/download/<name>` cannot be formed without first asking the
#      API which tag is latest. A hand-written URL goes stale every release.
#   2. `data/usage.db` is the operator's collected credit history and it lives
#      INSIDE the install dir. A naive re-install (rm -rf + unzip) destroys it.
#      This script installs beside the old copy and carries `data/` across.
#   3. bun is required, and it installs to ~/.bun/bin which a non-interactive
#      shell does not have on PATH.
#
# POSIX sh on purpose — this is piped to `sh`, so no arrays, no [[, no `local`.
#
# Knobs (env vars):
#   AIDLC_DIR=~/.aidlc-dashboard   where to install
#   AIDLC_VERSION=1.7.0            pin a version instead of latest
#   AIDLC_NO_BUN=1                 do not install bun even if it is missing
#   AIDLC_NO_BIN=1                 do not create the ~/.local/bin launcher

set -eu

REPO="wowzoo/aidlc-dashboard"
DIR="${AIDLC_DIR:-$HOME/.aidlc-dashboard}"
VERSION="${AIDLC_VERSION:-latest}"
BIN_DIR="${AIDLC_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/aidlc-dashboard"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---- prerequisites ----------------------------------------------------------
# curl and unzip only. `tar` cannot read a zip portably and jq is not assumed —
# the one JSON field this needs is pulled with sed.
command -v curl >/dev/null 2>&1 || die "curl 이 필요하다."
command -v unzip >/dev/null 2>&1 || die "unzip 이 필요하다."

# ---- which version ----------------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  say "▸ 최신 릴리스 확인..."
  # `tag_name` is the only field wanted, so grep+sed beats requiring jq. The API
  # is asked rather than guessed because the asset name embeds the version.
  TAG=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  [ -n "${TAG:-}" ] || die "최신 릴리스를 확인할 수 없다. AIDLC_VERSION=1.7.0 처럼 지정해 볼 것."
else
  TAG="v${VERSION#v}"
fi
VER="${TAG#v}"
ASSET="aidlc-dashboard-$VER.zip"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"

say "▸ $TAG ($ASSET)"

# ---- download ---------------------------------------------------------------
TMP=$(mktemp -d) || die "임시 디렉터리를 만들 수 없다."
# Clean up on any exit, including the failure paths below.
trap 'rm -rf "$TMP"' EXIT INT TERM

curl -fsSL -o "$TMP/$ASSET" "$URL" || die "내려받기 실패: $URL"
[ -s "$TMP/$ASSET" ] || die "내려받은 파일이 비어 있다: $URL"

unzip -q "$TMP/$ASSET" -d "$TMP/x" || die "압축을 풀 수 없다 ($ASSET)."
# The archive carries one top-level dir. Verify the shape rather than trusting it:
# a wrong layout should fail here, not halfway through the move below.
SRC="$TMP/x/aidlc-dashboard"
[ -f "$SRC/src/server.ts" ] || die "아카이브 구조가 예상과 다르다 (src/server.ts 없음)."
[ -f "$SRC/start.sh" ] || die "아카이브 구조가 예상과 다르다 (start.sh 없음)."

# ---- install ----------------------------------------------------------------
# Swap, not overwrite: the new tree is assembled complete, then put in place. A
# failure above leaves the existing install untouched.
mkdir -p "$(dirname "$DIR")"
if [ -e "$DIR" ]; then
  # `data/` is the collected credit history (SQLite). It is written INTO the
  # install dir at runtime, so it has to survive an upgrade — this is the one
  # thing a re-install must not throw away.
  if [ -d "$DIR/data" ]; then
    say "▸ 기존 data/ 보존 (수집한 크레딧 이력)"
    mv "$DIR/data" "$SRC/data"
  fi
  OLD="$DIR.old.$$"
  mv "$DIR" "$OLD"
  mv "$SRC" "$DIR"
  rm -rf "$OLD"
  say "▸ 갱신: $DIR"
else
  mv "$SRC" "$DIR"
  say "▸ 설치: $DIR"
fi
chmod +x "$DIR/start.sh" 2>/dev/null || true

# ---- bun --------------------------------------------------------------------
# Probed the same way start.sh probes it: PATH, then the documented locations a
# shell that has not read the user profile would miss.
find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  for c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

if BUN=$(find_bun); then
  say "▸ bun $("$BUN" --version) ($BUN)"
elif [ "${AIDLC_NO_BUN:-}" = "1" ]; then
  say "▸ bun 이 없다 — AIDLC_NO_BUN=1 이라 설치를 건너뛴다."
  say "  직접 설치: curl -fsSL https://bun.sh/install | bash"
else
  # Said out loud before doing it: this fetches and runs a THIRD-PARTY installer,
  # which is not something to slip in silently even inside a `curl | sh`.
  say "▸ bun 이 없다. 공식 설치 스크립트를 실행한다 (https://bun.sh/install)"
  say "  건너뛰려면 AIDLC_NO_BUN=1 로 다시 실행할 것."
  curl -fsSL https://bun.sh/install | bash || die "bun 설치 실패. 직접 설치 후 다시 실행할 것."
  BUN=$(find_bun) || die "bun 을 설치했지만 찾을 수 없다. 터미널을 새로 열고 다시 실행할 것."
  say "▸ bun $("$BUN" --version) ($BUN)"
fi

# ---- launcher ---------------------------------------------------------------
# A WRAPPER, not a symlink. `start.sh` does `cd "$(dirname "$BASH_SOURCE")"`, so a
# symlink in ~/.local/bin would make it cd into ~/.local/bin and fail to find src/.
#
# `RUN` is what the closing hint tells the user to type, and it is decided HERE
# rather than at the end: printing "add this to PATH" and then telling them to type
# the bare name is two instructions that contradict each other.
RUN="$DIR/start.sh"
if [ "${AIDLC_NO_BIN:-}" != "1" ]; then
  if mkdir -p "$BIN_DIR" 2>/dev/null; then
    cat > "$BIN" <<EOF
#!/bin/sh
exec "$DIR/start.sh" "\$@"
EOF
    chmod +x "$BIN"
    say "▸ 실행기: $BIN"
    case ":$PATH:" in
      *":$BIN_DIR:"*) RUN="aidlc-dashboard" ;;
      *) say "  ⚠ $BIN_DIR 이 PATH 에 없다. 셸 설정에 추가하면 이름만으로 실행할 수 있다." ;;
    esac
  else
    say "▸ $BIN_DIR 를 만들 수 없어 실행기를 건너뛴다."
  fi
fi

# ---- done -------------------------------------------------------------------
say ""
say "설치 완료 — v$VER"
say ""
say "  $RUN"
say "  $RUN ~/path/to/workspace"
say ""
say "  읽기 전용 — 이 대시보드는 워크스페이스에 쓰지 않는다."
