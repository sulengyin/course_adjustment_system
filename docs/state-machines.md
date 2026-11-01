# 状态机（四条独立）

> 核心要求：四条状态机**互不蕴含**。任何一条达到"完成"都不代表另一条完成。
> 下述状态名为契约用语，实现时可映射为枚举，但不得合并。

---

## 1. 调课方案（Change Case）

```
DRAFT ──提交──> PENDING_CONFIRMATION ──全部确认+冲突通过──> APPLYING ──事务成功──> EFFECTIVE
  │                     │                                        │
  │                     ├──有人拒绝──────────────────────────> REJECTED
  │                     ├──方案版本变更──> 旧确认 STALE（回 PENDING）
  │                     └──冲突未解──> BLOCKED_CONFLICT ──人工处理──> PENDING
  │
  └──本人撤回──> WITHDRAWN（仅未生效）
```

| 状态 | 含义 | 允许的下一步 |
|---|---|---|
| `DRAFT` | 尚未提交 | 提交、删除草稿 |
| `PENDING_CONFIRMATION` | 等待必要确认者逐一确认 | 确认、拒绝、改案、撤回 |
| `BLOCKED_CONFLICT` | 存在未解决冲突 | 人工处理（不得自动择一） |
| `APPLYING` | 事务提交中 | 成功 → `EFFECTIVE`；失败 → 回 `PENDING_CONFIRMATION`，不得部分生效 |
| `EFFECTIVE` | 正式生效 | **不可删除**；只能新建恢复/调整方案 |
| `REJECTED` | 有人明确拒绝 | 只能新建方案 |
| `WITHDRAWN` | 生效前撤回 | 只能新建方案 |

**禁止迁移**：`EFFECTIVE → DRAFT`、`EFFECTIVE → （删除）`、`PENDING_CONFIRMATION → EFFECTIVE`（跳过冲突复核）、`BLOCKED_CONFLICT → EFFECTIVE`（无人工处置记录）。

---

## 2. 确认（Confirmation）

```
NOT_REQUESTED ──方案提交──> PENDING ──本人接受──> ACCEPTED(rev=N)
                               │
                               ├──本人拒绝──> DECLINED
                               ├──方案改版──> STALE（旧rev作废）
                               └──超过截止（仅补确认场景）──> OVERDUE_PENDING_VERIFICATION
```

| 状态 | 含义 | 注意 |
|---|---|---|
| `PENDING` | 已通知，未答复 | 沉默不是任何结论 |
| `ACCEPTED` | 针对 `revision=N` 的本人确认 | 版本变更即失效 |
| `DECLINED` | 本人拒绝 | 本次方案不得生效 |
| `STALE` | 持有旧版本确认 | 必须重新确认 |
| `OVERDUE_PENDING_VERIFICATION` | 逾期待核验 | 不自动同意/拒绝 |

**禁止迁移**：`PENDING → ACCEPTED`（无本人动作）、`STALE → ACCEPTED`（不重新确认）、`OVERDUE → DECLINED`（自动推定拒绝）。

---

## 3. 应急协调（Coordination）

> **P6 受限实现说明**：门禁未关闭，只落地 `REQUESTED` 与"求助事实"。
> `NOTIFIED` / `OWNED` / `AMBIGUOUS` / `CLOSURE_SUBMITTED` / `CLOSED` 的入口全部返回
> `NOT_CONFIGURED`（附阻断项编号），不得由系统自动推进。

```
REQUESTED ──送达──> NOTIFIED
   │                   │
   │                   ├──无人明确承接──> NO_OWNER（需求仍在）
   │                   ├──有人有效接单──> OWNED
   │                   └──主责明确拒绝──> ESCALATED（立即升级代理）
   │
OWNED ──显式移交──> OWNED(新负责人，留痕)
OWNED ──提交结案──> CLOSURE_SUBMITTED ──授权人确认──> CLOSED
                                              │
                                              └──授课事实未核验──> TEACHING_PENDING（仍待办）
```

| 状态 | 含义 | 注意 |
|---|---|---|
| `NO_OWNER` | 已请求，无人承接 | 不得显示"已有人协调" |
| `OWNED` | 有唯一当前协调负责人 | 口头登记只能显示"暂有人协调/待追认" |
| `AMBIGUOUS` | 口头与在线来源冲突 | 保留双方来源，待裁定（O2-1） |
| `CLOSURE_SUBMITTED` | 已提交结案 | 未经确认不算结案 |
| `CLOSED` | 结案完成 | **不代表已上课** |
| `TEACHING_PENDING` | 授课事实未核验 | 与 `CLOSED` 可并存 |

**禁止迁移**：`NO_OWNER → OWNED`（无接单事件）、`AMBIGUOUS → OWNED`（自动按时间定序）、`CLOSED → COMPLETED`（结案不等于完成）。

---

## 4. 执行事实（Execution）

```
SCHEDULED ──授权人显式登记──> EXECUTED_REGISTERED ──核验──> VERIFIED
    │                              │
    │                              └──有异议──> DISPUTED
    └──未登记──> NOT_EXECUTED（保持）
```

| 状态 | 含义 | 注意 |
|---|---|---|
| `SCHEDULED` | 已安排 | 不得显示"已完成" |
| `EXECUTED_REGISTERED` | 已登记执行 | 未经核验不等于事实确认 |
| `VERIFIED` | 已核验 | 争议裁决权未定（D04） |
| `DISPUTED` | 有争议 | 保留双方证据，不覆盖 |

**禁止迁移**：`SCHEDULED → VERIFIED`（无登记）、`SCHEDULED → EXECUTED_REGISTERED`（系统自动推断）、恢复方案改写 `VERIFIED`。

---

## 5. 纠错（Correction）

```
REPORTED ──判定责任是否变化──┬─否─> FACTUAL_CANDIDATE ──白名单命中──> APPLIED（留前后值）
                             └─是─> REQUIRES_NEW_PROPOSAL（转调课方案）
```

| 状态 | 含义 | 注意 |
|---|---|---|
| `FACTUAL_CANDIDATE` | 识别为资料性纠错 | 白名单未配置时**不得放行** |
| `REQUIRES_NEW_PROPOSAL` | 改变责任 | 必须走新方案 + 必要确认 |

**禁止迁移**：`REQUIRES_NEW_PROPOSAL → APPLIED`（绕过确认）。

---

## 6. 四机关系（不得串联）

| 组合 | 允许 | 说明 |
|---|---|---|
| 方案 `EFFECTIVE` + 执行 `NOT_EXECUTED` | ✅ | 已定好但还没上 |
| 协调 `CLOSED` + 执行 `NOT_EXECUTED` | ✅ | 结案不等于上过课 |
| 执行 `VERIFIED` + 确认 `PENDING` | ✅ | 事实上过课，但确认缺失，需补 |
| 协调 `CLOSED` → 自动 执行 `VERIFIED` | ❌ | 违规 |
| 方案 `EFFECTIVE` → 自动 确认 `ACCEPTED` | ❌ | 违规 |
