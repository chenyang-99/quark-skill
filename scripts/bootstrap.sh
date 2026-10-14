#!/usr/bin/env bash
set -euo pipefail
umask 077

QUARK_ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUARK_SKILL_DIR="${QUARK_SKILL_DIR:-$HOME/.agents/skills/quarkclouddrive}"
QUARK_PACKAGE_URL='https://pdds.quark.cn/download/stfile/fflliomikfgjfhnhk/quarkclouddrive-1.0.24.zip'
QUARK_PACKAGE_SHA='a4847bb6e4d6bafb21eb28ba0d9b34b643b6ba5aed44d1a25c86c7f5ba3efb8a'
QUARK_EXPECTED_VERSION='1.0.24-29460f9'

command -v node >/dev/null
command -v python3 >/dev/null
command -v curl >/dev/null
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<24||(a===24&&b<5)){console.error("Use Node.js >= 24.5 for this cloud adapter.");process.exit(1)}'

QUARK_CURRENT_VERSION=''
if [ -f "$QUARK_SKILL_DIR/scripts/quark-drive.cjs" ]; then
  QUARK_CURRENT_VERSION="$(node "$QUARK_SKILL_DIR/scripts/quark-drive.cjs" --version 2>/dev/null || true)"
fi
if [ "$QUARK_CURRENT_VERSION" != "$QUARK_EXPECTED_VERSION" ]; then
  QUARK_DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/quark-install.XXXXXX")"
  trap 'rm -rf "$QUARK_DOWNLOAD_DIR"' EXIT
  QUARK_BUNDLED_PACKAGE="$QUARK_ADAPTER_DIR/../vendor/quarkclouddrive-1.0.24.zip"
  if [ -f "$QUARK_BUNDLED_PACKAGE" ]; then
    cp "$QUARK_BUNDLED_PACKAGE" "$QUARK_DOWNLOAD_DIR/package.zip"
  else
    curl -fsSL --retry 3 --retry-all-errors --retry-delay 2 \
      --connect-timeout 15 --max-time 60 \
      "$QUARK_PACKAGE_URL" -o "$QUARK_DOWNLOAD_DIR/package.zip"
  fi
  python3 - "$QUARK_DOWNLOAD_DIR/package.zip" "$QUARK_PACKAGE_SHA" "$QUARK_SKILL_DIR" <<'PY'
from pathlib import Path, PurePosixPath
import hashlib, shutil, stat, sys, zipfile
archive, expected, destination = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Official package integrity check failed.')
staging = archive.parent / 'unpacked'
with zipfile.ZipFile(archive) as package:
    for item in package.infolist():
        name = PurePosixPath(item.filename)
        mode = item.external_attr >> 16
        if name.is_absolute() or '..' in name.parts or stat.S_ISLNK(mode):
            raise SystemExit('Unexpected package path.')
        if not name.parts or name.parts[0] not in {'scripts', 'references', 'SKILL.md'}:
            raise SystemExit('Unexpected package entry.')
    package.extractall(staging)
if not (staging / 'scripts/quark-drive.cjs').is_file():
    raise SystemExit('Official CLI entry is missing.')
destination.mkdir(parents=True, exist_ok=True, mode=0o700)
for name in ('scripts', 'references'):
    shutil.copytree(staging / name, destination / name, dirs_exist_ok=True)
shutil.copy2(staging / 'SKILL.md', destination / 'SKILL.md')
print('Verified official Quark runtime installed (1.0.24).')
PY
fi

QUARK_INSTALLED_VERSION="$(bash "$QUARK_ADAPTER_DIR/quark.sh" --version)"
if [ "$QUARK_INSTALLED_VERSION" != "$QUARK_EXPECTED_VERSION" ]; then
  printf '%s\n' 'Official runtime version verification failed.' >&2
  exit 1
fi
printf '%s\n' "$QUARK_INSTALLED_VERSION"
