#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${SRC_DIR:-$ROOT_DIR/}"
REMOTE_HOST="${REMOTE_HOST:-139.196.84.63}"
REMOTE_PORT="${REMOTE_PORT:-3333}"
REMOTE_USER="${REMOTE_USER:-mac}"
REMOTE_DIR="${REMOTE_DIR:-/Users/mac/.openclaw/workspace/rent_task/}"
SSH_PASS="${REMOTE_SSH_PASS:-}"

if [[ -z "$SSH_PASS" ]]; then
  echo "[ERR] REMOTE_SSH_PASS 未设置"
  echo "示例: REMOTE_SSH_PASS='***' bash scripts/sync_remote_password.sh"
  exit 1
fi

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

echo "[OK] rsync 覆盖同步完成"

LOCAL_SUMS="$(cd "$ROOT_DIR" && shasum database/user_blacklist_db.js report/report_rent_status.js rent_robot_main.js)"

echo "[INFO] 本地关键文件哈希:"
echo "$LOCAL_SUMS"

REMOTE_CMD="cd '${REMOTE_DIR}' && shasum database/user_blacklist_db.js report/report_rent_status.js rent_robot_main.js"
REMOTE_SUMS="$(/usr/bin/expect <<EOF
set timeout -1
spawn ssh -p ${REMOTE_PORT} -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new ${REMOTE_USER}@${REMOTE_HOST} "${REMOTE_CMD}"
expect {
  -nocase "password:" {
    send -- "$SSH_PASS\r"
    exp_continue
  }
  eof
}
catch wait result
set code [lindex \$result 3]
if {\$code != 0} {
  exit \$code
}
EOF
)"

echo "[INFO] 远端关键文件哈希:"
echo "$REMOTE_SUMS"

LOCAL_ONLY="$(echo "$LOCAL_SUMS" | tr -d '\r' | awk '{print $1, $2}')"
REMOTE_ONLY="$(echo "$REMOTE_SUMS" | tr -d '\r' | grep -E '^[0-9a-f]{40}[[:space:]]' | awk '{print $1, $2}')"

if [[ "$LOCAL_ONLY" == "$REMOTE_ONLY" ]]; then
  echo "[OK] 哈希一致，远端已与本地同步"
else
  echo "[ERR] 哈希不一致，请重试同步"
  exit 2
fi
