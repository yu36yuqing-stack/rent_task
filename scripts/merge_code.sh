#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${SRC_DIR:-$REPO_DIR/}"
REMOTE_HOST="${REMOTE_HOST:-139.196.84.63}"
REMOTE_PORT="${REMOTE_PORT:-3333}"
REMOTE_USER="${REMOTE_USER:-mac}"
REMOTE_DIR="${REMOTE_DIR:-/Users/mac/.openclaw/workspace/rent_task/}"
REMOTE_BRANCH="${REMOTE_BRANCH:-main}"
SSH_PASS="12345"
COMMIT_MSG="${MERGE_COMMIT_MSG:-chore: sync from local $(date '+%Y-%m-%d %H:%M:%S')}"

echo "[Step 1/3] rsync 回传宿主机..."
RSYNC_CMD="rsync -az --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${SRC_DIR}' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}'"
/usr/bin/expect <<EOF
set timeout -1
spawn bash -lc "$RSYNC_CMD"
expect {
  -nocase "password:" {
    send -- "$SSH_PASS\r"
    exp_continue
  }
  eof
}
catch wait result
set code [lindex \$result 3]
exit \$code
EOF
echo "[OK] 回传完成"

echo "[Step 2/3] 宿主机提交并推送 GitHub..."
REMOTE_GIT_CMD="cd '${REMOTE_DIR}' && git add -A && if git diff --cached --quiet; then echo '\\[INFO\\] no changes to commit'; else git commit -m '${COMMIT_MSG}'; fi && git push origin ${REMOTE_BRANCH}"
/usr/bin/expect <<EOF
set timeout -1
spawn ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new ${REMOTE_USER}@${REMOTE_HOST} "${REMOTE_GIT_CMD}"
expect {
  -nocase "password:" {
    send -- "$SSH_PASS\r"
    exp_continue
  }
  eof
}
catch wait result
set code [lindex \$result 3]
exit \$code
EOF
echo "[OK] 宿主机已提交并推送"

echo "[Step 3/3] 本机对齐 GitHub(${REMOTE_BRANCH})..."
cd "$REPO_DIR"
git fetch origin
git reset --hard "origin/${REMOTE_BRANCH}"
git clean -fd

echo "[OK] 本机已对齐 origin/${REMOTE_BRANCH}"
