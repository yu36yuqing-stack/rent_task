#!/bin/bash
# Telegram 通知工具
TOKEN="8458250702:AAH6jSTgyZyTTQzQMdUhs2Rwv91Neen2AFU"
CHAT_ID="6796486659"
MESSAGE="$1"
MODE="$2"
LOG_FILE="/Users/mac/.openclaw/logs/tg_notify.log"

if [ -z "$MESSAGE" ]; then
    exit 0
fi

# 优先硬编码检测到的 Clash Verge 端口
PROXY="http://127.0.0.1:7897"

# Telegram 单条 text 最大约 4096，保守分片。
MAX_LEN=3500
rest="$MESSAGE"

while [ -n "$rest" ]; do
    chunk="${rest:0:$MAX_LEN}"
    rest="${rest:$MAX_LEN}"

    if [ "$MODE" = "html" ]; then
        resp=$(curl -sS -x "$PROXY" -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
            --data-urlencode "chat_id=$CHAT_ID" \
            --data-urlencode "text=$chunk" \
            --data-urlencode "parse_mode=HTML" \
            --data-urlencode "disable_web_page_preview=true")
    else
        resp=$(curl -sS -x "$PROXY" -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
            --data-urlencode "chat_id=$CHAT_ID" \
            --data-urlencode "text=$chunk")
    fi
    code=$?

    ts=$(date '+%Y-%m-%d %H:%M:%S')
    if [ $code -ne 0 ] || ! echo "$resp" | grep -q '"ok":true'; then
        echo "$ts [FAIL] code=$code resp=$resp" >> "$LOG_FILE"
        exit 1
    else
        echo "$ts [OK] chunk_len=${#chunk}" >> "$LOG_FILE"
    fi
done
