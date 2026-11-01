# 项目长期约定（校内课务协同系统）

## 用户要求（不可违反）
- 先审阅/验证再开发；每阶段完成后必须检验边界与框架，避免后续返工。
- 不自行补充学校未确认的制度；不擅自决定钉钉技术路线；第一版纯内网部署；R05 是 V2.3 的补充，不是替代。
- 待定规则拆为"通用默认规则 + 可调整规则"，进入设置页；未配置必须显式返回 `NOT_CONFIGURED`，不得猜默认值。
- 全部先用模拟数据；平台测试通过后，用户才提供真实作息表/课表/课后服务/工作表。
- **自 P3 起禁止执行 `git add` / `git commit`**，由用户在 GitNext 手动提交。

## 已定技术栈
- Node 24 + TypeScript 5.9 + `node:sqlite`（experimental，换库只改 `src/store/database.ts`）+ vitest + tsx。
- 规则三层：L0 硬不变量（代码断言，不进配置）、L1 校本参数（`defaultValue: null`）、L2 待决制度（`defaultEnabled: false`）。
- 审计唯一写入口 `src/store/audit-log.ts`（哈希链 + append-only 触发器）。
- 身份只由会话签发（`Principal` 品牌类型），HTTP 只读 Bearer token。

## 阶段进度
- P0/P1/P2/P3/P4/P5 完成；P6 受限完成（整体 NO-GO，仅求助可用）；P7 门禁未满足（S01/T-04/T-08）。

## 本机环境注意
- 工作目录在 HarmonyOS/OpenHarmony aarch64；`/tmp` 不支持 SQLite 加锁，临时库用 `os.tmpdir()`（`/data/storage/el2/base/cache`）。
- 部分文件上 `grep` 返回空结果，检索优先用 Read 或 `node -e` 读取。
- 后台服务用 `node --import tsx scripts/serve.ts` 启动，`npx tsx` 会多一层子进程导致 kill 不干净。
