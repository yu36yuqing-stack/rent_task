#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_DIR"
git fetch origin
git reset --hard origin/main
git clean -fd

echo "[OK] local repo synced to origin/main"
