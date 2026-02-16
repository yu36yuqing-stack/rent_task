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

echo "[Step 1/5] rsync 回传宿主机（排除本地DB和运行日志）..."
RSYNC_CMD="rsync -az --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' --exclude '*.db' --exclude 'log/' --exclude '*.log' -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${SRC_DIR}' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}'"
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

echo "[Step 2/5] 宿主机提交并推送 GitHub..."
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

echo "[Step 3/5] 重启宿主机 H5 服务并做健康检查..."
REMOTE_H5_CMD="cd '${REMOTE_DIR}' && pkill -f 'h5/local_h5_server.js' || true; lsof -tiTCP:8080 -sTCP:LISTEN | xargs -I{} kill -9 {} || true; nohup /usr/local/bin/node '${REMOTE_DIR}h5/local_h5_server.js' > log/h5_local_server.log 2>&1 & sleep 2; curl -fsS http://127.0.0.1:8080/api/ping"
/usr/bin/expect <<EOF
set timeout -1
spawn ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new ${REMOTE_USER}@${REMOTE_HOST} "${REMOTE_H5_CMD}"
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
echo "[OK] 宿主机 H5 已重启并通过 /api/ping 健康检查"

echo "[Step 4/5] 本机对齐 GitHub(${REMOTE_BRANCH})..."
cd "$REPO_DIR"
git fetch origin
git reset --hard "origin/${REMOTE_BRANCH}"
git clean -fd

echo "[Step 5/5] 从宿主机回拉DB和运行日志到本机..."
PULL_DB_CMD="rsync -az -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}database/' '${REPO_DIR}/database/' --include '*/' --include '*.db' --exclude '*'"
/usr/bin/expect <<EOF
set timeout -1
spawn bash -lc "$PULL_DB_CMD"
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

PULL_LOG_CMD="rsync -az -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}log/' '${REPO_DIR}/log/'"
/usr/bin/expect <<EOF
set timeout -1
spawn bash -lc "$PULL_LOG_CMD"
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

echo "[OK] 本机已对齐 origin/${REMOTE_BRANCH}，并同步宿主机DB+日志"
