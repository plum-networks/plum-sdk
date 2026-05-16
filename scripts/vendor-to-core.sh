#!/usr/bin/env bash
# src/plum-sdk.js 를 plum-box-core 의 embed FS 경로로 복사.
# core 의 web/static/apps/runtime/plum-sdk.js 는 commit 되어 있으며
# go binary 에 embed 됨. cross-repo 라 자동 호출은 안 함 — SDK 수정 후
# 개발자가 명시적으로 이 스크립트 실행.

set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
SRC="$HERE/src/plum-sdk.js"
DEST_DIR="$HERE/../plum-box-core/web/static/apps/runtime"
DEST="$DEST_DIR/plum-sdk.js"

if [ ! -f "$SRC" ]; then
  echo "error: $SRC not found" >&2
  exit 1
fi

if [ ! -d "$HERE/../plum-box-core" ]; then
  echo "error: plum-box-core repo not at $HERE/../plum-box-core" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
echo "vendored $(stat -c%s "$SRC") bytes → $DEST"
