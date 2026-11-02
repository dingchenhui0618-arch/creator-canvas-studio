# 运行时适配器契约 v0

> 状态：**前端演示实现的事实快照**（2026-11）。适配器是产品域与运行时之间唯一的缝；当前只有一个 mock 实现（`mode: 'mock'`），没有真实 DSH 端点、没有网络请求（`fetch` 全仓零命中）。
> 相关：[画布数据契约](./canvas-contract.md) · [ROADMAP](./ROADMAP.md)

## 1. 边界在哪

| 事实 | 证据 |
| --- | --- |
| 接口定义在 `src/runtime/types.ts:26` | `RuntimeAdapter` 共 3 个方法 + 4 个描述字段 |
| 只有两个消费者 | `src/pages/CanvasPage.tsx:5`、`src/pages/AgentEditorPage.tsx:4`，都直接 `import { dshAdapter } from '../runtime/mockAdapter'` |
| 没有 provider / registry / 工厂 | 换实现必须改 import 点，见第 5 节 |
| `capabilities` 无消费者 | 全仓除定义与赋值外零引用；设置页的能力文案是硬编码的 |

## 2. 接口

```ts
export type RuntimeAdapter = {
  id: string
  label: string
  mode: 'mock' | 'live'
  capabilities: AdapterCapability[]
  runCanvas(snapshot: CanvasSnapshot, onEvent: (event: RunEvent) => void): Promise<RunResult>
  testAgent(agent: AgentDefinition, message: string, onEvent: (event: AgentTestEvent) => void): Promise<{ reply: string }>
  cancel(): void
}
```

| 成员 | 语义 | 当前实现 |
| --- | --- | --- |
| `id` / `label` | 稳定标识与展示名 | `'dsh-adapter'` / `'DSH Adapter'` |
| `mode` | `'mock'` 表示不连真实服务 | 永远 `'mock'` |
| `capabilities` | 能力清单，`state: 'ready' \| 'planned'` | 4 条：流式、结构化 ready；外部工具、真实模型 planned |
| `runCanvas` | 整张画布跑一次，事件流 + 产物 | 排序后按节点串行发事件，见第 3 节 |
| `testAgent` | 单智能体对话试运行 | 不读画布、不读输入字段，见第 4 节 |
| `cancel` | 请求中止当前运行 | 置模块级标志，**UI 无入口，从未被调用** |

## 3. 事件模型

`RunEventType` 共 7 个值，mock 实际只发 5 个：

| type | 语义 | mock 是否发出 | 前端反应 |
| --- | --- | --- | --- |
| `queued` | 已入队，携带 `versionId` 与节点/连线数 | 是（progress 4） | 追加到 `events` |
| `started` | 运行时开始执行 | 是（10） | 同上 |
| `node-started` | 某节点开始 | 是 | 追加 + 该节点 `status='running'` |
| `streaming` | 增量输出 | **否** | 无处理分支 |
| `node-completed` | 某节点结束 | 是 | 追加 + 该节点 `status='success'` |
| `completed` | 整次运行成功 | 是（100） | Dock 切 SUCCEEDED |
| `failed` | 运行失败 | **否** | **不存在处理分支** |

时序约束（mock 保证，接入方应沿用）：`queued` 必为第一条，`completed` 必为最后一条；`node-started` 与 `node-completed` 成对且 `nodeId` 相同；`progress` 单调不减，取值 4 → 10 → 12 起每节点 +16（上限 92）→ 100。事件之间用 `await wait(420)`（排队）与 `900ms`（agent 节点）/ `520ms`（其余节点）模拟耗时。

前端只消费最近 4 条（`events.slice(-4)`），进度条取**最后一条**事件的 `progress`；Dock 里的时长 `00:00:03` 是写死的字符串，不来自 `RunResult.durationMs`。`Artifact` 只显示数量，不回填节点。

## 4. 取消与失败：三个真实缺口

1. **取消不可达**：`cancel()` 存在但没有任何按钮调用它；`cancelled` 是模块级变量，同一时刻只允许一个运行。
2. **失败被吞掉**：`runCanvas` 的 `catch` 不看错误内容，一律 `setRunStatus('idle')` 并提示「运行已取消」；真实端点返回 500 也会显示成取消。
3. **没有失败终态**：`NodeStatus` 无 `failed`，`runStatus` 只有 `idle / running / success`，失败节点无从标记。也没有超时与重试。

`testAgent` 另有两处与契约不符：步骤文案「读取引用资产 / 陶瓷杯 · 主图 / 品牌卖点与语气」是硬编码字符串，不读 `agent.inputs`；演示技能时打印的是 `agent.skills` 里的 **id**（如 `ecom-visual`）而非 `name`。

## 5. 换成真实 DSH 端点要改哪些文件

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `src/runtime/dshAdapter.ts`（新建） | 实现 `RuntimeAdapter`，把 `runCanvas` 变成 HTTP/SSE 调用 | 保持视图层不动 |
| `src/pages/CanvasPage.tsx` | 改 import（第 5 行）；拆分 `catch`（第 101–104 行）为取消 / 失败两条分支 | 现在分不清取消与失败 |
| `src/pages/AgentEditorPage.tsx` | 改 import（第 4 行）；`runTest` 补错误分支（第 122–132 行） | 现在 `finally` 外没有失败提示 |
| `src/runtime/types.ts` | 按需扩 `AdapterCapability` / 增加取消原因、超时字段 | 接口是唯一扩展点 |
| `src/pages/SettingsPage.tsx` | 替换硬编码的「支持 / 待接入 / 未配置」 | 该页不读 `capabilities` |
| `src/runtime/index.ts`（可选） | 统一导出，后续按 `mode` 选实现 | 消除两个散落的 import 点 |

**不要改**：`src/components/CanvasCard.tsx`、`src/data/mock.ts` 的初始画布、`src/domain/types.ts`（除非产物需要新字段）。视图与域模型不应该感知运行时。

## 6. 不变量

| 不变量 | 现状 | 缺口 |
| --- | --- | --- |
| 前端不持有密钥 | 无任何请求与凭据读取代码，只有界面文案声明 | 接入后必须由服务端代理；前端只拿 `runId` 与事件流 |
| Run 必须绑定 CanvasVersion | `runCanvas` 入参唯一带 `versionId`，值恒为 `canvas-v3` | 无版本存在性校验，值来自常量而非真实版本表 |
| Artifact 可被引用回画布 | `Artifact.nodeId` 已定义；`CanvasNodeData.artifactId` 声明但从不写入；引用表只认资产库 id | 引用链未闭合，产物无法被下一个节点引用 |
| 快照是值投影，不是引用 | 只投影 `id / kind / title / data` 与 `id / source / target` | 边的 handle、label、执行顺序全部丢失 |

## 7. 接入完成的最小判据

- 新适配器 `mode` 为 `'live'`，且 `CanvasPage` 不再 import mock；
- 取消按钮调用 `cancel()`，界面出现「已取消」而非「运行已取消」的兜底文案；
- `failed` 事件与 `NodeStatus` 的失败态在画布上可见；
- 运行记录来自真实 `RunResult`，`durationMs` 替代写死的 `00:00:03`；
- 密钥不出现在任何前端产物里（构建后 grep 校验）。
