#!/usr/bin/env sh
# Thin POSIX shell wrapper for the OpenCode Harness installer.
# Forwards all arguments unchanged; performs no Git operations and no dependency installs.
# Usage: sh scripts/setup/setup.sh --target <dir> --capabilities memory,learning,agents --dry-run
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLER="$SCRIPT_DIR/../../installer/bootstrap/install.mjs"

if [ ! -f "$INSTALLER" ]; then
  echo "Installer not found: $INSTALLER" >&2
  exit 1
fi

exec node "$INSTALLER" "$@"
