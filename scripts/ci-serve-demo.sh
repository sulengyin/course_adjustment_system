#!/usr/bin/env bash
# 给 Playwright 用的演示实例：临时库 + 虚构种子 + 前台运行。
#
# 由 playwright.config.ts 的 webServer 拉起，测试结束时 Playwright 负责杀掉。
# 库放在临时目录，跑完即弃；不碰 ca-demo/ 也不碰正式库。
#
# 用 `node --import tsx` 而不是 `npx tsx`：后者会多一层子进程，
# 结束时被 kill 的是外层 npx，真正的服务会残留并占住端口（smoke-deploy.sh 踩过）。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

PORT="${CA_E2E_PORT:-18189}"
WORK="${CA_E2E_WORK:-/tmp/ca-e2e}"
SEED_PASSWORD="${CA_SEED_PASSWORD:-Demo!2026pass}"

# 每次从干净的库开始：上一次跑留下的改密结果会让登录用例结果不稳定。
# 用 node 删而不是 `rm -rf`：本机（鸿蒙）的 rm 走了一层包装，直接调会报 bad interpreter。
node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$WORK"
mkdir -p "$WORK"

export CA_DB_PATH="$WORK/demo.sqlite"
export CA_SEED_PASSWORD="$SEED_PASSWORD"

# seed 会给 teacher01 这类账号生成一次性随机口令，只在它的 stdout 里出现一次。
# 落一份到 $WORK/seed.log，让浏览器测试能读到初始口令（否则只能改用固定口令的建号逻辑，
# 那会把"演示账号必须有一次性口令"这条约束改掉）。
node --import tsx scripts/seed-demo.ts | tee "$WORK/seed.log"

export CA_BIND_ADDRESS=127.0.0.1
export CA_PORT="$PORT"

exec node --import tsx scripts/serve.ts
