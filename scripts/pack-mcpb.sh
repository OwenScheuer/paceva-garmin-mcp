#!/bin/sh
# Build paceva-garmin.mcpb, the one-click Claude Desktop extension.
set -eu
cd "$(dirname "$0")/.."
npm run build
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R dist manifest.json icon.png package.json package-lock.json "$stage/"
(cd "$stage" && npm ci --omit=dev --ignore-scripts --silent)
npx -y @anthropic-ai/mcpb@2.1.2 pack "$stage" paceva-garmin.mcpb
