# 画布运行的钱与记录（v0.9.59，2026-11-13）

A1 在 v0.9.48 修的是「一键复刻」那条线：任务落库、按账本幂等退款、SIGTERM 先收尾。当时文档里留了一句「仍留一半：流程运行（/api/flows/:id/run）还在用进程内回调退款」。这一轮把这半补上。

## 修之前的三个缺口

| 缺口 | 后果 |
| --- | --- |
| 运行记录只在跑完才写（`server/flows.mjs` 的 `saveRun(run)` 在循环之后） | 进程被杀，这次运行在 `runs.json` 里根本不存在；用户只看到积分少了 2，查不到是哪次运行 |
| 退款挂在路由的闭包里（`beginRunCharge` 返回的 `refund()`） | 进程一退出闭包就没了，已扣的积分留在平台账上 |
| 扣费 `ref` = 画布名（`flow.name`） | 同名画布的多次运行共用一个 ref，无法判断「这条扣费是哪次运行」，退款也只能靠人记得 |

## 改法

1. **运行 id 先定、记录先落盘、再扣费**：路由生成 `run_xxxxxxxx`，`startFlowRun()` 先写一条 `status: running` 的记录，然后才 `charge(user.id, 'flow_run', { ref: runId, meta: { label: flow.name } })`。扣费失败（并发闸门 / 积分不足）就把占位记录撤掉，不留空单。
2. **扣费与退款同一个 ref = 运行 id**：账本、运行记录、退款三处能对上；画布名进账本的说明列（`label`），不再当单据号。
3. **三条退款路径共用一个函数**：`refundRunCredits(run)` 用 `outstandingCharge(user, 'flow_run', run.id)` 算净额，重复调用算出 0：
   - 节点失败 / 运行出错：`runFlow` 收尾时退；
   - 启动恢复：`recoverInterruptedRuns()` 把 `running` 标成 `interrupted` 后退；
   - 停机收尾：`interruptRunningRuns()` 先标中断 + 退款，再让进程退出（`SIGTERM` / `SIGINT` 都走这条）。
4. **新增终态 `interrupted`**：运行记录页、画布运行抽屉、后台运行记录都显示「已中断」，与「失败」分开——重启打断不是运行出错。运行记录页第三格在出现中断时写「本页未完成」，不把两种状态混成一个「失败」数字。
5. `saveRun` 改成按 id 覆盖：一次运行开始、结束各写一次，列表里仍然只有一条。

## 生产实测（v0.9.59）

| 验证 | 结果 |
| --- | --- |
| 真实跑一次会失败的画布（评审节点没配图，不进上游、不花钱） | `POST /api/flows/flow_bc6c3870/run` → `run_aee67613`，`status=error`、`credits.refunded=true`；账本 `flow_run -2 ref=run_aee67613` + `flow_run-refund +2 ref=run_aee67613`，余额 9950 → 9950 |
| 重启对账演练（造一条 `running` 记录 + 对应扣费，然后 `systemctl restart visionqa`） | 停机日志 `shutdown runsInterrupted:0`；启动日志 `runs.recovered {"recovered":1,"refunded":1}`；该运行 `status=interrupted`、`credits.refunded=true`，余额 9948 → 9950，退款流水 ref 同为运行 id |
| 再重启一次 | 没有第二条退款流水，余额不变（幂等） |
| health / version | `/api/version` 0.9.59、health `{ok:true, redfox:true, vision:true, llm:true, templates:26}` |

演练造的那条运行记录（`run_6e780de3`，名字「恢复演练 · 中断」）留在生产运行记录里当证据，扣 2 与退 2 相抵、账本净额 0；对应的空画布已删除。截图见 [docs/screenshot-runs-interrupted-2026-11-13.png](screenshot-runs-interrupted-2026-11-13.png)。

## 测试

`test/flow-run-recovery.test.mjs` 6 条（本地临时数据目录 + 本地假上游，不花上游额度）：

1. 运行一开始就落盘，扣完费马上断电也查得到这条单；
2. 重启恢复：标 `interrupted`、按账本退回、退款 ref 与扣费一致；
3. 正常跑完的运行不被恢复逻辑碰、不退款、列表里只有一条；
4. 节点失败：运行标失败、按账本退回、只退一次；
5. 走真实路由：扣费单据 ref = 运行 id（不是画布名），退款同 ref；
6. 停机收尾：在跑的运行标中断 + 退款，上游返回后也不会把终态改回成功，且只退一次。

`npm test` **528/528**（+6），oxlint 0 error / 6 warning，`tsc -b` 干净，构建通过。

## 边界（没做的）

- **平台侧的退款不等于上游没收费**：运行在调用上游的途中被重启，上游可能已经计了这次 token；平台按账本把用户的积分退回，这部分成本由平台吸收。要精确到「上游到底收没收费」得拉上游账单对账（A8 的账本目前是估算口径）。
- **没有节点级续跑**：中断后只能重新跑整条流程，已完成的节点不缓存。
- **旧流水保留画布名 ref**：v0.9.59 之前的 `flow_run` 行 ref 仍是画布名，程序不去改写历史；新记录一律用运行 id。
- 出图 / 出视频的异步任务中断退款仍走原任务台账那套（v0.9.48 的 `replicate_jobs`），不在本轮范围。

## 回滚

`ops/rollback.sh` 回 v0.9.58。本轮没有数据迁移：`runs.json` 只是多了 `interrupted` 终态与 `aborted` 字段，旧版本读到时按未知状态显示，不会崩。
