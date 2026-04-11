#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${SRC_DIR:-$REPO_DIR/}"
REMOTE_HOST="${REMOTE_HOST:-139.196.84.63}"
REMOTE_PORT="${REMOTE_PORT:-3333}"
REMOTE_USER="${REMOTE_USER:-mac}"
REMOTE_DIR="${REMOTE_DIR:-/Users/mac/.openclaw/workspace/rent_task/}"
SSH_PASS="${REMOTE_SSH_PASS:-12345}"
WAIT_SEC="${WAIT_SEC:-45}"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/usr/local/bin/node}"

if [[ -z "$SSH_PASS" ]]; then
  echo "[ERR] REMOTE_SSH_PASS 未设置"
  exit 1
fi

run_expect() {
  local command="$1"
  /usr/bin/expect <<EOF
set timeout -1
spawn bash -lc "$command"
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
}

echo "[Step 1/4] rsync 新代码到宿主机（排除本地DB和日志）..."
RSYNC_CMD="rsync -az --delete --exclude '.git' --exclude 'node_modules' --exclude '.DS_Store' --exclude '*.db' --exclude 'log/' --exclude 'coverage/' --exclude '*.log' -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${SRC_DIR}' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}'"
run_expect "$RSYNC_CMD"
echo "[OK] 宿主机代码已更新"

echo "[Step 2/4] 宿主机执行 runtime 库迁移并切换进程..."
REMOTE_CMD=$(cat <<'EOF'
set -euo pipefail
cd "__REMOTE_DIR__"
NODE_BIN="__REMOTE_NODE_BIN__"

mkdir -p backup log
STAMP="$(date '+%Y%m%d_%H%M%S')"
cp database/rent_robot.db "backup/rent_robot.db.${STAMP}.bak"
if [[ -f database/rent_robot_runtime.db ]]; then
  cp database/rent_robot_runtime.db "backup/rent_robot_runtime.db.${STAMP}.bak"
fi

echo "[Remote] init sqlite..."
"${NODE_BIN}" database/init_sqlite.js

echo "[Remote] migrate runtime db..."
"${NODE_BIN}" scripts/migrate_runtime_db.js

echo "[Remote] restart by killing processes and letting supervisor auto-start..."
pkill -f 'h5/local_h5_server.js' || true
pkill -f 'rent_robot_main.js' || true
pkill -f 'order/order_worker.js' || true
pkill -f 'stats/order_stats_worker.js' || true
lsof -tiTCP:8080 -sTCP:LISTEN | xargs -I{} kill -9 {} || true

sleep __WAIT_SEC__

echo "[Remote] process snapshot:"
ps aux | egrep 'rent_robot_main|order_worker|order_stats_worker|local_h5_server' | grep -v grep || true

echo "[Remote] ping check:"
curl -fsS http://127.0.0.1:8080/api/ping

echo "[Remote] runtime db counts:"
sqlite3 -header -csv database/rent_robot_runtime.db "SELECT COUNT(*) AS total FROM user_session; SELECT '---'; SELECT COUNT(*) AS total FROM order_sync_state; SELECT '---'; SELECT COUNT(*) AS total FROM order_stats_job_state; SELECT '---'; SELECT COUNT(*) AS total FROM lock_db;"

echo "[Remote] recent runtime lock rows:"
sqlite3 -header -csv database/rent_robot_runtime.db "SELECT lock_key, lease_until, modify_date, desc FROM lock_db ORDER BY modify_date DESC LIMIT 10;"

echo "[Remote] recent log errors:"
rg -n "SQLITE_BUSY|database is locked|no such table|Error:" log/*.log || true
EOF
)
REMOTE_CMD="${REMOTE_CMD//__REMOTE_DIR__/${REMOTE_DIR}}"
REMOTE_CMD="${REMOTE_CMD//__WAIT_SEC__/${WAIT_SEC}}"
REMOTE_CMD="${REMOTE_CMD//__REMOTE_NODE_BIN__/${REMOTE_NODE_BIN}}"
TMP_REMOTE_SCRIPT="$(mktemp)"
trap 'rm -f "$TMP_REMOTE_SCRIPT"' EXIT
printf '%s\n' "$REMOTE_CMD" > "$TMP_REMOTE_SCRIPT"
REMOTE_EXEC_CMD="ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new ${REMOTE_USER}@${REMOTE_HOST} 'bash -s' < '$TMP_REMOTE_SCRIPT'"
run_expect "$REMOTE_EXEC_CMD"
echo "[OK] 宿主机迁移与切换完成"

echo "[Step 3/4] 从宿主机回拉 DB 和日志..."
PULL_DB_CMD="rsync -az -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}database/' '${REPO_DIR}/database/' --include '*/' --include '*.db' --exclude '*'"
run_expect "$PULL_DB_CMD"

PULL_LOG_CMD="rsync -az -e 'ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new' '${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}log/' '${REPO_DIR}/log/'"
run_expect "$PULL_LOG_CMD"
echo "[OK] 本地已同步生产 DB 和日志"

echo "[Step 4/4] 本地结果摘要..."
sqlite3 -header -csv "${REPO_DIR}/database/rent_robot_runtime.db" "SELECT COUNT(*) AS total FROM user_session; SELECT '---'; SELECT COUNT(*) AS total FROM order_sync_state; SELECT '---'; SELECT COUNT(*) AS total FROM order_stats_job_state; SELECT '---'; SELECT COUNT(*) AS total FROM lock_db;"
echo "[OK] runtime 库切换脚本执行完成"
