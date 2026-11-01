#!/usr/bin/env bash
# 部署冒烟：真实进程 + 环境变量入口 + 备份恢复演练。
#
# 用法：bash scripts/smoke-deploy.sh
# 端口可用 CA_SMOKE_PORT 覆盖（默认 18080）。全部使用临时目录与虚构数据，结束即删。
#
# 为什么用 `node --import tsx` 而不是 `npx tsx`：后者会多一层子进程，
# 脚本结束时 kill 掉的是外层 npx，真正的服务进程会残留并占用端口。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${CA_SMOKE_PORT:-18080}"
WORK="$(node -e 'const fs=require("fs"),os=require("os"),p=require("path");process.stdout.write(fs.mkdtempSync(p.join(os.tmpdir(),"ca-smoke-")))')"
DB="$WORK/db/ca.sqlite"
BACKUP_DIR="$WORK/backup"
SERVER_LOG="$WORK/server.log"
mkdir -p "$WORK/db" "$BACKUP_DIR"
cd "$ROOT" || exit 1

SERVER_PIDS=""
cleanup() {
  for p in $SERVER_PIDS; do kill "$p" 2>/dev/null; done
  node -e 'require("fs").rmSync(process.argv[1], { recursive: true, force: true })' "$WORK"
}
fail() { echo "SMOKE_FAIL: $1"; exit 1; }

trap cleanup EXIT

echo "== 1. 初始化管理员（空库仅一次） =="
INIT=$(CA_DB_PATH="$DB" CA_ADMIN_LOGIN=admin CA_ADMIN_NAME=教务管理员 node --import tsx scripts/init-admin.ts 2>&1)
echo "$INIT"
PW=$(printf '%s\n' "$INIT" | sed -n 's/.*一次性初始口令：//p')
[ -n "$PW" ] || fail "未取得初始口令"
PW_JSON=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$PW")

echo "== 2. 通配地址必须拒绝启动 =="
CA_BIND_ADDRESS=0.0.0.0 CA_PORT=$PORT CA_DB_PATH="$DB" node --import tsx scripts/serve.ts > "$WORK/refuse.log" 2>&1
CODE=$?
cat "$WORK/refuse.log"
[ "$CODE" -eq 2 ] || fail "0.0.0.0 未被拒绝（exit=$CODE）"

echo "== 3. 启动内网服务 =="
CA_BIND_ADDRESS=127.0.0.1 CA_PORT=$PORT CA_DB_PATH="$DB" node --import tsx scripts/serve.ts > "$SERVER_LOG" 2>&1 &
PID=$!
SERVER_PIDS="$SERVER_PIDS $PID"
cleanup_server() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }

READY=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/healthz" > "$WORK/health.json" 2>/dev/null; then READY=1; break; fi
  sleep 0.25
done
[ "$READY" -eq 1 ] && cat "$WORK/health.json" || { cat "$SERVER_LOG"; cleanup_server; fail "服务未在 15s 内就绪"; }
echo

echo "== 4. 登录 / 首登改密门禁 / 改密后旧会话失效 =="
LOGIN=$(curl -sS -X POST -H 'content-type: application/json' \
  -d "{\"loginName\":\"admin\",\"password\":$PW_JSON,\"actingRole\":\"A\"}" \
  "http://127.0.0.1:$PORT/api/auth/login")
TOKEN=$(printf '%s' "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { cleanup_server; fail "登录未返回 token"; }
echo "登录成功（token 不打印）"

GATE=$(curl -sS -o "$WORK/gate.json" -w '%{http_code}' -H "authorization: Bearer $TOKEN" \
  "http://127.0.0.1:$PORT/api/timetable/me?termId=T&from=2026-09-01&to=2026-09-07")
echo "首登访问课表: $GATE $(cat "$WORK/gate.json")"
[ "$GATE" = "403" ] || { cleanup_server; fail "首登未改密未被拦截"; }

NEWPW='Admin!Pass2026x'
NEWPW_JSON=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$NEWPW")
CH=$(curl -sS -o "$WORK/ch.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
  -d "{\"oldPassword\":$PW_JSON,\"newPassword\":$NEWPW_JSON}" "http://127.0.0.1:$PORT/api/me/password")
echo "改密: $CH"
[ "$CH" = "200" ] || { cleanup_server; fail "改密失败"; }

OLD=$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/me")
echo "改密后旧 token: $OLD"
[ "$OLD" = "401" ] || { cleanup_server; fail "旧 token 未失效"; }

LOGIN2=$(curl -sS -X POST -H 'content-type: application/json' \
  -d "{\"loginName\":\"admin\",\"password\":$NEWPW_JSON,\"actingRole\":\"A\"}" \
  "http://127.0.0.1:$PORT/api/auth/login")
TOKEN2=$(printf '%s' "$LOGIN2" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN2" ] || { cleanup_server; fail "二次登录失败"; }

echo "== 5. 畸形输入必须 400，不落到 500 =="
BAD1=$(curl -sS -o "$WORK/bad1.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "authorization: Bearer $TOKEN2" \
  -d '{"termId":"T","items":"nope","idempotencyKey":"K1"}' "http://127.0.0.1:$PORT/api/changes")
echo "items 非数组: $BAD1 $(cat "$WORK/bad1.json")"
[ "$BAD1" = "400" ] || { cleanup_server; fail "畸形 items 未返回 400"; }

BAD2=$(curl -sS -o "$WORK/bad2.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "authorization: Bearer $TOKEN2" \
  -d '{"decision":"maybe"}' "http://127.0.0.1:$PORT/api/changes/any/decisions")
echo "未知 decision: $BAD2 $(cat "$WORK/bad2.json")"
[ "$BAD2" = "400" ] || { cleanup_server; fail "未知 decision 未返回 400"; }

BAD3=$(curl -sS -o "$WORK/bad3.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H "authorization: Bearer $TOKEN2" \
  -d '{"termId":"T","items":[]}' "http://127.0.0.1:$PORT/api/changes")
echo "缺幂等键: $BAD3 $(cat "$WORK/bad3.json")"
[ "$BAD3" = "400" ] || { cleanup_server; fail "缺幂等键未返回 400"; }

cleanup_server

echo "== 6. 端口冲突必须明确失败 =="
CA_BIND_ADDRESS=127.0.0.1 CA_PORT=$PORT CA_DB_PATH="$DB" node --import tsx scripts/serve.ts > "$WORK/hold.log" 2>&1 &
HOLD=$!
SERVER_PIDS="$SERVER_PIDS $HOLD"
HOLD_READY=0
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/healthz" > /dev/null 2>&1; then HOLD_READY=1; break; fi
  sleep 0.25
done
[ "$HOLD_READY" -eq 1 ] || { kill "$HOLD" 2>/dev/null; fail "占位实例未启动"; }
CA_BIND_ADDRESS=127.0.0.1 CA_PORT=$PORT CA_DB_PATH="$DB" node --import tsx scripts/serve.ts > "$WORK/conflict.log" 2>&1
CODE=$?
kill "$HOLD" 2>/dev/null
wait "$HOLD" 2>/dev/null
echo "第二个实例: exit=$CODE $(tail -1 "$WORK/conflict.log")"
[ "$CODE" -eq 3 ] || fail "端口冲突未以明确错误退出（exit=$CODE）"

echo "== 7. 备份 / 校验 / 恢复 / 对账 =="
CA_DB_PATH="$DB" CA_BACKUP_DIR="$WORK/db" node --import tsx scripts/backup.ts > "$WORK/backup-refuse.log" 2>&1
CODE=$?
echo "备份目录含活库: exit=$CODE"
[ "$CODE" -eq 2 ] || fail "备份目录保护未生效"

CA_DB_PATH="$DB" CA_BACKUP_DIR="$BACKUP_DIR" node --import tsx scripts/backup.ts > "$WORK/backup.log" 2>&1
CODE=$?
cat "$WORK/backup.log"
[ "$CODE" -eq 0 ] || fail "备份失败"

CA_BACKUP_DIR="$BACKUP_DIR" CA_DB_PATH="$WORK/restored.sqlite" node --import tsx scripts/restore.ts > "$WORK/restore.log" 2>&1
CODE=$?
cat "$WORK/restore.log"
[ "$CODE" -eq 0 ] || fail "恢复失败"

CA_BACKUP_DIR="$BACKUP_DIR" CA_DB_PATH="$WORK/restored.sqlite" node --import tsx scripts/restore.ts > "$WORK/restore-again.log" 2>&1
CODE=$?
echo "重复恢复未声明覆盖: exit=$CODE $(cat "$WORK/restore-again.log")"
[ "$CODE" -eq 1 ] || fail "重复恢复未被拒绝"

echo "== 8. 文件权限与日志脱敏 =="
stat -c '%a %n' "$BACKUP_DIR"/*.sqlite "$WORK/restored.sqlite" 2>/dev/null || stat -f '%Lp %N' "$BACKUP_DIR"/*.sqlite "$WORK/restored.sqlite"
echo "server.log 行数: $(wc -l < "$SERVER_LOG")"
for PAT in "$PW" "$NEWPW" '13800138000' '"password"' 'oldPassword' 'newPassword'; do
  grep -qF -- "$PAT" "$SERVER_LOG" && fail "日志泄漏：$PAT"
done
echo "日志未含口令/手机号/口令字段（路径 /api/me/password 不计）"

echo "SMOKE_OK"
