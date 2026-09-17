#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cmake -S "$REPO_DIR" -B "$REPO_DIR/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DBUILD_RECORDER=OFF \
  -DCHECK_ASSETS=OFF \
  -DNO_SHADERC=ON \
  -DUSE_WIIUSE=OFF
cmake --build "$REPO_DIR/build" --target supertuxkart -j "$(sysctl -n hw.logicalcpu)"

echo "Built: $REPO_DIR/build/bin/supertuxkart.app/Contents/MacOS/supertuxkart"
