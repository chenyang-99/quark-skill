#!/usr/bin/env bash
set -euo pipefail
umask 077

QUARK_ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUARK_SKILL_DIR="${QUARK_SKILL_DIR:-$HOME/.agents/skills/quarkclouddrive}"

case "${1:---help}" in
  login|search|browse|download|get-user-info|summary|qa|resolve-agent|help|--help|--version|-h|-V) ;;
  *) printf '%s\n' 'This wrapper supports authentication and reading operations only.' >&2; exit 2 ;;
esac

if [ ! -f "$QUARK_SKILL_DIR/scripts/quark-drive.cjs" ]; then
  printf '%s\n' 'Official CLI is missing. Run scripts/bootstrap.sh in the cloud first.' >&2
  exit 1
fi

exec node --require "$QUARK_ADAPTER_DIR/env-proxy.cjs" \
  "$QUARK_SKILL_DIR/scripts/quark-drive.cjs" "$@"
