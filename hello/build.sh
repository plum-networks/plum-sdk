#!/usr/bin/env bash
# Cross-compiles the service for the box (arm64) and writes ./svc.
# Pure-Go services need no cross toolchain.
set -euo pipefail
cd "$(dirname "$0")"
( cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o ../svc . )
echo "built svc ($(du -h svc | cut -f1)); next: plum-dev push"
