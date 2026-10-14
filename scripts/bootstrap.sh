#!/usr/bin/env bash
set -euo pipefail
umask 077

QUARK_ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUARK_SKILL_DIR="${QUARK_SKILL_DIR:-$HOME/.agents/skills/quarkclouddrive}"
QUARK_UPSTREAM_COMMIT=cba49a7e703d32607b1376375e3214fd8c63788f

command -v node >/dev/null
command -v curl >/dev/null
command -v unzip >/dev/null
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<24||(a===24&&b<5)){console.error("Use Node.js >= 24.5 for this cloud adapter.");process.exit(1)}'

# The official installer uses a sibling named temp; do not let it remove an
# unrelated existing directory.
if [ -e "$(dirname "$QUARK_SKILL_DIR")/temp" ]; then
  printf '%s\n' 'A sibling temp directory already exists; move it before installing.' >&2
  exit 1
fi

mkdir -p "$QUARK_SKILL_DIR"
if [ -f "$QUARK_SKILL_DIR/scripts/install.sh" ]; then
  bash "$QUARK_SKILL_DIR/scripts/install.sh"
else
  curl -fsSL --connect-timeout 15 --max-time 60 \
    "https://raw.githubusercontent.com/quark-clouddrive/quarkclouddrive_offical/$QUARK_UPSTREAM_COMMIT/skills/quarkclouddrive/install.sh" \
    -o "$QUARK_SKILL_DIR/install.sh"
  bash "$QUARK_SKILL_DIR/install.sh"
fi

bash "$QUARK_ADAPTER_DIR/quark.sh" --version
