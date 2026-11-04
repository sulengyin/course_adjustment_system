#!/usr/bin/env bash
# 自愈启动：按当前内网地址启动/重启正式与演示实例。
#
# 解决的问题：服务启动时把 IP 写死，WiFi 换一次地址，进程还在跑但没人连得上
# （docs/11 §4）。本脚本每次运行时先取当前地址，只重启"地址不对或已经挂掉"的实例。
#
# 用法：
#   bash scripts/serve-auto.sh            对齐一次（已在跑且地址正确则什么都不做）
#   bash scripts/serve-auto.sh --status   只报告，不动进程
#   bash scripts/serve-auto.sh --watch    持续看守，地址变了或进程挂了就自动重启
#
# 可覆盖的环境变量：
#   CA_IFACE        网卡名，默认 wlan0
#   CA_PROD_PORT    正式端口，默认 18089
#   CA_DEMO_PORT    演示端口，默认 18088
#   CA_PROD_DB      正式库路径
#   CA_DEMO_DB      演示库路径
#
# 退出码：0 全部就绪；1 有实例未能就绪；2 地址或前置条件不满足。

set -u

# 本机自带终端的 PATH 里没有 node 与 bash（文末 exit 127 的根因）：
# 从桌面图标或 `zsh 启动课务系统.sh` 启动时，到了拉起实例那一步会 npx not found。
# 这里补上工具链目录；幂等，且不改变已有同名目录的优先级。
for ca_dir in /data/storage/el1/bundle/libs/arm64/node/bin \
              /data/storage/el1/bundle/libs/arm64/bash/bin; do
  [ -d "$ca_dir" ] || continue
  case ":$PATH:" in
    *":$ca_dir:"*) ;;
    *) PATH="$ca_dir:$PATH" ;;
  esac
done
export PATH

# /tmp 在本机属于 root:expert、普通用户不可写。tsx 启动时要在临时目录里建一个
# unix socket（/tmp/tsx-*/<pid>.pipe），不设 TMPDIR 就会报 EACCES 起不来。
# 从桌面图标或自带终端启动时正好没有 TMPDIR，所以这里兜一个可写的缓存目录。
if [ ! -w "${TMPDIR:-/tmp}" ]; then
  TMPDIR="/data/storage/el2/base/cache"
  export TMPDIR
  mkdir -p "$TMPDIR" 2>/dev/null || true
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

IFACE="${CA_IFACE:-wlan0}"
PROD_PORT="${CA_PROD_PORT:-18089}"
DEMO_PORT="${CA_DEMO_PORT:-18088}"
PROD_DB="${CA_PROD_DB:-/data/storage/el2/base/cache/ca-production/school.sqlite}"
DEMO_DB="${CA_DEMO_DB:-/data/storage/el2/base/cache/ca-demo/demo.sqlite}"

RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "$*"; exit 2; }

# 取网卡上的 IPv4。优先 ip，退化到 ifconfig；没有地址返回空。
detect_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 addr show "$IFACE" 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')"
  fi
  if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
    # 这套系统上 ifconfig 输出是 `inet addr:192.168.11.28`，地址在第二个字段。
    ip="$(ifconfig "$IFACE" 2>/dev/null | awk '/inet addr:/{sub(/.*addr:/,"",$2); print $2; exit}')"
  fi
  printf '%s' "$ip"
}

# 只接受私有地址：服务配置校验本来就会拒绝公网与 0.0.0.0（src/server/config.ts），
# 这里提前挡一道，避免脚本把坏地址传下去后只看到一句启动失败。
is_private_ipv4() {
  case "$1" in
    10.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

# 健康 = 200 且页面里真的有挂载点。仅看端口通不够：别的程序占了端口也会回 200。
healthy() {
  local ip="$1" port="$2" body
  body="$(curl -s -m 2 "http://$ip:$port/" 2>/dev/null)" || return 1
  case "$body" in
    *'id="app"'*) return 0 ;;
    *) return 1 ;;
  esac
}

# 找出本项目所有的服务进程。用中括号避免匹配到自己这条命令。
serve_pids() {
  ps -eo pid,args 2>/dev/null | awk '/[s]cripts\/serve\.ts/ {print $1}'
}

stop_serves() {
  local pids
  pids="$(serve_pids | tr '\n' ' ')"
  [ -z "${pids// /}" ] && return 0
  log "停止旧进程：$pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  local i
  for i in $(seq 1 20); do
    [ -z "$(serve_pids)" ] && return 0
    sleep 0.5
  done
  pids="$(serve_pids | tr '\n' ' ')"
  [ -z "${pids// /}" ] || { log "强杀未退出的进程：$pids"; kill -9 $pids 2>/dev/null; }
  sleep 0.5
}

start_one() {
  local name="$1" port="$2" db="$3" logfile="$RUN_DIR/$name.log"
  [ -f "$db" ] || die "库不存在：$db（首次部署请先运行初始化脚本）"
  log "启动 $name：$IP:$port 库=$db"
  # nohup + 重定向：关掉终端窗口服务也不受影响（docs/11 §3 第 1 条）。
  nohup env CA_BIND_ADDRESS="$IP" CA_PORT="$port" CA_DB_PATH="$db" \
    npx tsx scripts/serve.ts >>"$logfile" 2>&1 &
}

wait_ready() {
  local name="$1" port="$2" logfile="$RUN_DIR/$name.log" i
  for i in $(seq 1 40); do
    if healthy "$IP" "$port"; then
      log "$name 就绪：http://$IP:$port"
      return 0
    fi
    sleep 0.5
  done
  log "$name 未能就绪，日志末尾："
  tail -n 20 "$logfile" 2>/dev/null | sed 's/^/    /'
  return 1
}

ensure() {
  local name="$1" port="$2" db="$3"
  if healthy "$IP" "$port"; then
    log "$name 已就绪：http://$IP:$port（不动）"
    return 0
  fi
  start_one "$name" "$port" "$db"
  wait_ready "$name" "$port"
}

show_status() {
  local state="未就绪"
  healthy "$IP" "$PROD_PORT" && state="就绪"
  log "正式 $IP:$PROD_PORT → $state"
  state="未就绪"
  healthy "$IP" "$DEMO_PORT" && state="就绪"
  log "演示 $IP:$DEMO_PORT → $state"
}

MODE="once"
case "${1:-}" in
  "" ) MODE="once" ;;
  --status) MODE="status" ;;
  --watch) MODE="watch" ;;
  -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "未知参数：$1（可用 --status / --watch）" ;;
esac

IP="$(detect_ip)"
[ -n "$IP" ] || die "网卡 $IFACE 上没有 IPv4 地址（没连上 WiFi？）"
is_private_ipv4 "$IP" || die "地址 $IP 不是私有地址，拒绝绑定（配置校验也会拒绝）"
log "当前地址 $IFACE = $IP"

if [ "$MODE" = "status" ]; then
  show_status
  exit 0
fi

if [ "$MODE" = "once" ]; then
  # 地址变了之后旧进程还绑着旧地址：先看两个端口是否都真的通，
  # 只要有一个不通，就整体停掉重来，避免新旧两套进程抢同一个库。
  if ! healthy "$IP" "$PROD_PORT" || ! healthy "$IP" "$DEMO_PORT"; then
    stop_serves
  fi
  ok=0
  ensure "prod" "$PROD_PORT" "$PROD_DB" || ok=1
  ensure "demo" "$DEMO_PORT" "$DEMO_DB" || ok=1
  [ "$ok" -eq 0 ] && log "全部就绪" || die "有实例未能就绪，见上方日志"
  exit 0
fi

# watch：每 20 秒核对一次，地址变了或实例掉了就拉起。
log "看守模式启动（每 20 秒核对一次，Ctrl-C 退出）"
LAST_IP="$IP"
while :; do
  NOW_IP="$(detect_ip)"
  if [ -z "$NOW_IP" ]; then
    log "网卡 $IFACE 暂时没有地址，等待重连"
  elif [ "$NOW_IP" != "$LAST_IP" ]; then
    log "地址变化：$LAST_IP → $NOW_IP，重启全部实例"
    IP="$NOW_IP"
    LAST_IP="$NOW_IP"
    stop_serves
    ensure "prod" "$PROD_PORT" "$PROD_DB" || true
    ensure "demo" "$DEMO_PORT" "$DEMO_DB" || true
  else
    if ! healthy "$IP" "$PROD_PORT"; then
      log "正式实例无响应，重启"
      start_one "prod" "$PROD_PORT" "$PROD_DB"
      wait_ready "prod" "$PROD_PORT" || true
    fi
    if ! healthy "$IP" "$DEMO_PORT"; then
      log "演示实例无响应，重启"
      start_one "demo" "$DEMO_PORT" "$DEMO_DB"
      wait_ready "demo" "$DEMO_PORT" || true
    fi
  fi
  sleep 20
done
