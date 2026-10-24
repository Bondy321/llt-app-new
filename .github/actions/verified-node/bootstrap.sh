#!/usr/bin/env bash
set -euo pipefail

# Reviewed official release hashes, not hashes downloaded alongside executable code.
# https://nodejs.org/dist/v22.23.4/SHASUMS256.txt
# https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
case "${LLT_NODE_VERSION:-}" in
  22.23.4) digest=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;;
  24.22.1) digest=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 ;;
  *) echo '::error::Unreviewed Node version requested'; exit 1 ;;
esac
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
[[ "${NODE_TLS_REJECT_UNAUTHORIZED:-1}" != 0 ]]
: "${RUNNER_TEMP:?}" "${GITHUB_PATH:?}"
toolchain_dir=$(mktemp -d "$RUNNER_TEMP/llt-node.XXXXXXXX")
archive="node-v${LLT_NODE_VERSION}-linux-x64.tar.xz"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error \
  --location --connect-timeout 20 --max-time 180 --retry 3 \
  "https://nodejs.org/dist/v${LLT_NODE_VERSION}/$archive" -o "$toolchain_dir/$archive"
printf '%s  %s\n' "$digest" "$toolchain_dir/$archive" | sha256sum --check --strict -
tar --extract --xz --file "$toolchain_dir/$archive" --directory "$toolchain_dir" \
  --no-same-owner --no-same-permissions
node_bin="$toolchain_dir/node-v${LLT_NODE_VERSION}-linux-x64/bin"
[[ "$("$node_bin/node" --version)" == "v$LLT_NODE_VERSION" ]]
printf '%s\n' "$node_bin" >> "$GITHUB_PATH"
echo "::notice::Using checksum-verified Node $LLT_NODE_VERSION under RUNNER_TEMP. No JavaScript action runtime is used or modified."
# The next workflow step runs the unchanged repository certificate-trust guard
# before any npm install, Firebase emulator, EAS command or application script.
