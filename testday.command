#!/usr/bin/env bash
#
# Launches testday.
#
# Named `.command` so it can be double-clicked in Finder, which is how it gets
# started on a test day. It also runs perfectly well from a terminal:
#
#   ./testday.command            build and run the app
#   ./testday.command --dev      hot reload, for working on it
#   ./testday.command --check    typecheck and tests, launch nothing
#
# Everything it needs is local. It installs npm dependencies on first run and
# then never touches the network again, and the app itself makes no network
# requests at all.
#
# The one rule this script exists to enforce: it must fail with a sentence
# somebody can act on, not a stack trace. It runs on the morning of a test,
# possibly by whoever is nearest the laptop.

set -euo pipefail

# A double-clicked .command starts in the home directory, so the script has to
# find its own location rather than trusting the working directory.
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/testday"

BOLD=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
OFF=$'\033[0m'

# Double-clicked from Finder, the window can close before a message is read.
# Anything fatal pauses first.
INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1

die() {
  printf '\n%s%sCannot start testday%s\n\n  %s\n\n' "$BOLD" "$RED" "$OFF" "$1" >&2
  if [ "$INTERACTIVE" = "1" ]; then
    printf '%sPress return to close.%s' "$DIM" "$OFF" >&2
    read -r _ || true
  fi
  exit 1
}

step() { printf '%s%s%s\n' "$DIM" "$1" "$OFF"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$1"; }

MODE="run"
case "${1:-}" in
  --dev)   MODE="dev" ;;
  --check) MODE="check" ;;
  --help|-h)
    sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "") ;;
  *) die "Unknown option '$1'. Try --dev, --check or --help." ;;
esac

printf '\n%stestday%s %s%s%s\n\n' "$BOLD" "$OFF" "$DIM" "$ROOT" "$OFF"

# --- prerequisites ----------------------------------------------------------

[ -d "$APP" ] || die "No testday/ directory next to this script. It should sit at the root of the repository."

command -v node >/dev/null 2>&1 || die \
  "Node.js is not installed, or not on this shell's PATH.
  Install it from https://nodejs.org and run this again."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $(node -v) is too old. Electron needs 20 or newer."
fi
ok "Node $(node -v)"

# --- dependencies -----------------------------------------------------------

cd "$APP"

# Reinstall when the lock file is newer than what was installed, so a pull that
# changes dependencies does not produce a confusing failure later.
NEEDS_INSTALL=0
if [ ! -d node_modules ]; then
  NEEDS_INSTALL=1
elif [ package-lock.json -nt node_modules ]; then
  NEEDS_INSTALL=1
fi

if [ "$NEEDS_INSTALL" = "1" ]; then
  step "Installing dependencies (first run, or they have changed). This needs the network once."
  npm install --no-audit --no-fund || die \
    "npm install failed.
  If this machine is offline, connect once and run it again. Nothing after this step needs a network."
  touch node_modules
  ok "Dependencies installed"
else
  ok "Dependencies up to date"
fi

# The FIT verification is a development check, not something a test day needs.
# Its absence is worth one line, and never worth blocking a launch over.
if ! python3 -c 'import fitdecode' >/dev/null 2>&1; then
  warn "fitdecode is not installed, so 'npm test' will fail the FIT check."
  printf '  %sFix with: python3 -m pip install -r tools/requirements.txt%s\n' "$DIM" "$OFF"
fi

# --- go ---------------------------------------------------------------------

case "$MODE" in
  check)
    step "Typechecking…"
    npm run --silent typecheck || die "Typecheck failed. The output above says where."
    ok "Typecheck clean"
    step "Running tests…"
    npm test || die "Tests failed. The output above says which."
    ok "All tests passed"
    ;;

  dev)
    step "Starting with hot reload. Edits to src/ appear immediately."
    printf '  %sStop with Ctrl-C.%s\n\n' "$DIM" "$OFF"
    exec npm run electron:dev
    ;;

  run)
    # Built rather than hot-reloaded: on a test day the app should be the same
    # every time it starts, and a typecheck failure should stop it here rather
    # than surface as a blank window with an athlete already warming up.
    step "Building…"
    npm run --silent electron:build >/dev/null 2>&1 || {
      npm run electron:build || true
      die "The build failed. The output above says why. Try --check for the full detail."
    }
    ok "Built"
    printf '\n%sStarting testday. Close the window to quit.%s\n\n' "$BOLD" "$OFF"
    exec npx electron .
    ;;
esac
