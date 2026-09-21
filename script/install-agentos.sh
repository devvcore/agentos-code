#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
command -v bun >/dev/null 2>&1 || { echo "Install Bun 1.3.14 first: https://bun.sh" >&2; exit 1; }
cd "$root"
bun install --frozen-lockfile --ignore-scripts
cd packages/opencode
OPENCODE_CHANNEL=agentos OPENCODE_VERSION=${AGENTOS_CODE_VERSION:-0.2.0} bun run script/build.ts --agentos --single --skip-install --skip-embed-web-ui
platform=$(bun -e 'process.stdout.write(process.platform + "-" + process.arch)')
source="dist/agentos-code-$platform/bin/agentos-code"
[ -f "$source" ] || { echo "No native binary was produced for $platform." >&2; exit 1; }
destination=${AGENTOS_CODE_INSTALL_DIR:-"$HOME/.local/bin"}
mkdir -p "$destination"
install -m 755 "$source" "$destination/omnicode"
ln -sf omnicode "$destination/agentos-code"
"$destination/omnicode" --version
printf 'Installed %s/omnicode\nRun omnicode in your project; sign-in opens automatically.\n' "$destination"
