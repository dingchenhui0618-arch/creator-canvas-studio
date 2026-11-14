# 两条运行摆一起：哪里变了、慢在哪、多花了多少

v0.9.110 · 2026-11-14

## 起因

从 v0.9.103 起，每次运行会留下逐节点的内容指纹；从 v0.9.106 起，运行能在画布上只读回看；从 v0.9.107 起，运行开始时的整张画布也留了快照。单条运行已经说得清了，但「这次和上次比」仍要人肉做：打开两条运行记录，逐个节点对照输出，再自己算快了还是慢了、多花了几积分。

这一轮补的就是这段：在只读回看页点「对照上次」，把两条运行摆在一起。

## 做了什么

- **服务端只读对照**：`GET /api/runs/:id/compare` 默认找同一条画布上更早的一条已结束运行；也可以 `?with=<runId>` 点名。两条必须同属一张画布，自对照 400、跨画布 400、要对照的那条还在跑 409。不写记录、不重跑、不扣费。
- **逐节点分开算**：按节点 id 对齐，分别给出新增、这次没有、状态变了、输出变了、输入或配置改了（节点指纹变了）、耗时差。输出按完整内容算哈希，键顺序不同不算改动；首段只保留 180 字用于辨认，完整输出仍去单条运行详情看。
- **两次运行的摘要**：各自的状态、开始时间、耗时、完成节点数、实际扣费；再给总差：耗时、扣费、变了几个节点。失败退回的积分按实际花掉算，不把退回来的又算一遍。
- **画布改过要说**：两次运行的 `flowRevision` 不同时明确写「画布改过，对照按节点 id 对齐」；老运行没有指纹时写「无法判断两次是否同一版画布」，不假装一致。
- **入口**：只读回看页页头「对照上次」，在「运行结果」与「退出查看」之间。弹窗只读，关闭后不改变画布，也不产生新的运行。
- **空状态**：这是这张画布最早的一条运行时，不渲染对照表、不写「全部一致」，直接说「再跑一次之后，这里会逐节点对照两次的结果」。
- **390 宽**：两张运行卡与三格总览各占一行，对照行拆成「节点 / 上一条 / 这一条 / 变化」四段；弹窗占满可用宽度，正文内部滚动，页面不横向溢出。

## 接口

```
GET /api/runs/<runId>/compare
GET /api/runs/<runId>/compare?with=<previousRunId>
```

可对照时返回：

```json
{
  "ok": true,
  "comparable": true,
  "flowId": "flow_...",
  "current": { "id": "run_...", "status": "success", "durationMs": 612, "cost": 5, "finished": 3, "total": 3 },
  "previous": { "id": "run_...", "status": "success", "durationMs": 525, "cost": 5, "finished": 3, "total": 3 },
  "graph": { "changed": true, "unknown": false, "currentRevision": "df05440271dc79ab", "previousRevision": "b9570e8922daa24e" },
  "nodes": [
    {
      "id": "n_input", "kind": "input", "title": "输入主题",
      "previous": { "status": "success", "ms": 0, "preview": "写一句关于下班后散步的话" },
      "current": { "status": "success", "ms": 0, "preview": "写一句关于清晨散步的话" },
      "added": false, "removed": false,
      "statusChanged": false, "outputChanged": true, "revisionChanged": true,
      "msDelta": 0
    }
  ],
  "totals": {
    "added": 0, "removed": 0, "statusChanged": 0,
    "outputChanged": 3, "revisionChanged": 3, "unchanged": 0, "changed": 3,
    "durationDelta": 87, "costDelta": 0, "failedDelta": 0
  }
}
```

没有上一条时返回 `{ ok: true, comparable: false, reason, current }`，不返回空对照表。

## 本地实测

环境：本地 8946 + 假上游 8976，3 节点（输入 → LLM → 输出），零真实上游。

| 检查 | 读数 |
| --- | --- |
| 画布 | `flow_19b8f646`，3 节点 / 2 连线 |
| 两次运行 | `run_100dead9` → 改输入 → `run_f95b7e89`；都 success，各扣 5 积分 |
| 余额 | 100 → 95 → 90（账本两条 flow_run，各 −5） |
| 假上游 | 共 2 次（每轮 1 次 LLM） |
| 对照接口 | `previous=run_100dead9`；`outputChanged=3`、`revisionChanged=3`、`changed=3`、`unchanged=0` |
| 总差 | 耗时 +87ms；扣费差额 0；3 / 3 个节点变了 |
| 画布 | 两次 `flowRevision` 不同：`df05440271dc79ab` / `b9570e8922daa24e` |
| 1440 弹窗 | 960 宽，top 161 / bottom 839，视口 1440×1000；页面 `scrollWidth 1440 = clientWidth 1440` |
| 1440 内容 | 3 行节点；每行「输出变了」「输入或配置改了」；LLM 行 `+87ms`；两段输出首段并排 |
| 只读 | 弹窗打开期间画布 PATCH 0、再次运行 POST 0、`resume-plan` 0；`/compare` 只有 GET |
| 390 弹窗 | left 8 / right 382 / width 374，top 8 / bottom 836；行宽 338 ≤ 弹窗 374；`scrollWidth 390 = clientWidth 390` |
| 390 布局 | 对照行单列（`grid-template-columns: 314px`），正文可滚动 |
| 最早一条运行 | 不渲染对照表；写「这是这张画布上最早的一条运行；再跑一次之后，这里会逐节点对照两次的结果」 |
| 空状态宽度 | 弹窗收窄到 620，不再留一大片空白 |

![两条运行摆一起：上一条 / 这一条、耗时、扣费、逐节点变化与输出首段](docs/run-compare-2026-11-14.png)

![390 宽的对照表：每行拆成节点、上一条、这一条与变化，正文内部滚动](docs/run-compare-390-2026-11-14.png)

![最早的一条运行：如实说没得对照，不写「全部一致」](docs/run-compare-alone-2026-11-14.png)

## 踩到的坑

1. **测试里的 pathname 带了查询串。** 路由正则按 `/compare` 结尾匹配，而 mock 把 `?with=...` 一起传进第四个参数，`with` 用例全落 404。真实服务传的是 `url.pathname`；测试 helper 改成传 `url.pathname` 才和线上一致。
2. **`runFlow` 跑的是传进去的那份 nodes。** 测试里 `updateFlow` 后仍用旧的 `flow` 对象跑第二次，两条运行的内容其实一样，`graph.changed` 还是 false。改完必须重新 `getFlow`。
3. **`finishedNodes` 可能是旧记录里的空值。** 直接 `!== undefined` 会把 `null` 当成 0；改成「有限数字才用，否则按节点结果数」。
4. **按钮比节点晚一拍。** 只读页先铺画布，运行记录后到；E2E 只等「3 个节点」就点「对照上次」，按钮还是 disabled。要等按钮 `disabled === false`。
5. **390 的滚动位置不能拿 `offsetTop`。** `.rc-table` 的 `offsetTop` 不是相对滚动容器的；按 `getBoundingClientRect` 两边相减再加当前 `scrollTop`，截图才从表头开始。
6. **空状态沿用 960 宽太虚。** 只有一张运行卡时，大半个弹窗是空白；非对照状态收窄到 620，并给宽度一个 260ms 过渡。
7. **`"output"` 这个字符串会误伤断言。** 节点 `kind` 本来就有 `"output"`；查「完整输出没被搬过来」要查 `"output":`，不能只查 `"output"`。
8. **effect 里同步 setState 会多一轮渲染。** 首屏 loading 交给 `useState` 初值；只有点「重新读取」时在点击回调里切回加载态，lint 回到 0 error / 15 warning。

## 发现但没做

- 没有「挑两条运行对照」的选择器；当前只对照同一条画布更早的那一条。
- 不能跨画布版本对照（分版后的旧版画布有自己的 flowId，节点 id 可能相同也可能不同）。
- 正在跑 / 排队中的记录不参与对照；要等它结束。
- 不做逐字差异、不做差异导出，也不把两次的完整输出并排铺开。
- 旧运行没有画布快照与节点指纹时，只能比状态、耗时与输出；不补写快照。
- 还没做分享链接与真实评审回归。

## 回退与验证

- 回退：`bash /opt/visionqa/ops/rollback.sh --to 1` → v0.9.109；`--to 2` → v0.9.108。
- 不改已有 JSON schema：对照是现算的只读响应，不新增落盘字段；旧前端忽略接口，只读回看页照旧。
- 验证：`npm test`（923/923）、`npx oxlint`（0 error / 15 warning）、`npx tsc -b`、`npm run build`；本地 E2E `.tmp-qa/r120-e2e.mjs`（假上游 8976，零真实调用）。

## 生产实况

（部署后补）
