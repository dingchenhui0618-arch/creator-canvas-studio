# 画布数据契约 v0

> 状态：**前端演示实现的事实快照**（2026-11，`src/` 当前 HEAD）。这不是 LumoAi 的官方 Canvas 协议，未经真实服务验证；拿到画布源码后以本文的「待确认」项逐条核对。
> 相关：[运行时适配器契约](./adapter-contract.md) · [ROADMAP](./ROADMAP.md)

## 1. 事实来源

| 文件 | 它定义的形状 |
| --- | --- |
| `src/domain/types.ts` | `CanvasNodeData`、`NodeKind`、`NodeStatus`、`RunEvent`、`Artifact` |
| `src/runtime/types.ts` | `CanvasSnapshot`（`runCanvas` 的入参） |
| `src/data/mock.ts` | 4 个初始节点、3 条边的真实数据 |
| `src/pages/CanvasPage.tsx` | 版本常量、引用表、撤销栈、拖入与连线的写入逻辑 |

## 2. 文档概念 vs 代码实体

代码里**没有** `Project` 与 `CanvasVersion` 类型（全仓 grep 零命中），只有下列替代物：

| 契约概念 | 代码中的实际形态 | 位置 |
| --- | --- | --- |
| Project | 硬编码标题「春日上新 · 视觉资产画布」 | `CanvasPage.tsx:197` |
| CanvasVersion | 常量 `const version = 'v3'` | `CanvasPage.tsx:50` |
| Node | `Node<CanvasNodeData>`（@xyflow/react 12） | `mock.ts:15` |
| Edge | `Edge`（@xyflow/react） | `mock.ts:41` |
| 引用关系 | `Record<nodeId, assetId[]>` 组件 state | `CanvasPage.tsx:42` |

## 3. 字段表

**Node**（React Flow 包装，只持久化以下部分）

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | 画布内唯一；初始为 `asset-product` 等，新增为 `node-<ts>-<n>`、拖入为 `asset-<ts>-<n>`、复制为 `copy-<ts>-<n>` |
| `type` | asset / agent / output | 是 | 与 `data.kind` 重复，必须同值 |
| `position` | `{x, y}` | 是 | 画布坐标，拖动由 `onNodesChange` 更新 |
| `data` | `CanvasNodeData` | 是 | 见下表 |

**CanvasNodeData**

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `kind` | `NodeKind` | 是 | 节点类型 |
| `label` | string | 是 | 检查器「节点类型」区块标题 |
| `title` | string | 是 | 卡片标题、检查器 `h2` |
| `description` | string | 是 | 卡片副文案、检查器「描述」 |
| `status` | ready / running / success | 是 | **无 failed** |
| `meta` | string | 否 | 来源说明 |
| `icon` | image / text / bot | 否 | 仅影响图标与缩略图 |
| `accent` | string | 否 | 十六进制色 |
| `artifactId` | string | 否 | **声明但从未写入**（grep 只命中定义处），产物回填未实现 |

**Edge**：只用 `id`、`source`、`target`、`animated`（新建连线一律 `true`）。没有 handle、label、data、执行顺序语义。

## 4. 引用关系：两个 id 空间

节点的 `data.kind === 'asset'` 叫「资产节点」，但 `references` 存的是**资产库**的 `asset-1 … asset-6`，检查器用 `assets.find` 反查名称。两个 id 空间不同源，因此：

- 引用不能指向画布节点，也不能指向 `Artifact`；
- 从左侧拖入资产只创建节点，**不写引用**（`onDrop` 不触碰 `references`）；
- 只有点「+」才写引用，且加的是「第一个未引用的库资产」，用户无法选具体哪一条；
- 运行完成后只给首个 output 节点追加硬编码的 `asset-1`。

## 5. Run 绑定不可变版本

现状：`runCanvas` 收到的 `versionId` 唯一来源是模板串 `canvas-${version}` → `"canvas-v3"`；快照只投影 `id / kind / title / data` 与边的 `id / source / target`。queued 事件的 label 带上该 versionId，Dock 显示「最近一次运行 · 绑定 v3」。

**不可变性未实现**：版本是常量，无版本表、无历史、无回滚；标题旁「v3 · 已保存」是静态文案；运行期间继续编辑画布不会产生新版本，也不会阻断。

## 6. 未验证语义（必须与 LumoAi 对齐后再写进契约）

| 语义 | 当前代码 | 结论 |
| --- | --- | --- |
| 连线是否表达执行依赖 | mock 按 `kind` 排序（asset 优先），**完全忽略 edges**，只在 queued 事件里上报条数 | 未知；当前按「仅引用关系」实现 |
| 节点能否单独运行 | 没有单节点运行入口，只能整张画布运行 | 未实现 |
| 自动保存协议 | 无 fetch / localStorage / indexedDB（grep 零命中），刷新即丢 | 未实现 |
| 失败态 | `RunEventType` 有 `failed`，mock 从不发出；`catch` 一律提示「运行已取消」 | 未实现 |
| 历史运行与复现 | `RunsPage` 是静态 mock 行，无运行记录存储 | 未实现 |

## 7. canvas-example.json

与 `src/data/mock.ts` 的 4 个节点、3 条边逐字段一致（`references` 是 UI 侧补充，**不属于** `CanvasSnapshot`，运行时不传）：

```json
{
  "versionId": "canvas-v3",
  "nodes": [
    { "id": "asset-product", "type": "asset", "position": { "x": 96, "y": 178 },
      "data": { "kind": "asset", "label": "参考资产", "title": "陶瓷杯 · 主图", "description": "1 张图片 · 2048 × 2048", "status": "ready", "meta": "商品素材", "icon": "image", "accent": "#c77d5a" } },
    { "id": "asset-copy", "type": "asset", "position": { "x": 96, "y": 396 },
      "data": { "kind": "asset", "label": "输入文案", "title": "品牌卖点与语气", "description": "文本 · 342 字", "status": "ready", "meta": "品牌资产", "icon": "text", "accent": "#7b88b8" } },
    { "id": "agent-layout", "type": "agent", "position": { "x": 430, "y": 258 },
      "data": { "kind": "agent", "label": "创作智能体", "title": "商品视觉编辑", "description": "整理输入资产，输出详情页视觉方向", "status": "running", "meta": "DSH Adapter · Mock", "icon": "bot", "accent": "#6b62d9" } },
    { "id": "output-board", "type": "output", "position": { "x": 788, "y": 258 },
      "data": { "kind": "output", "label": "生成资产", "title": "详情页首屏构图", "description": "等待智能体完成布局建议", "status": "success", "meta": "PNG · 1:1", "icon": "image", "accent": "#d9a952" } }
  ],
  "edges": [
    { "id": "e-product-agent", "source": "asset-product", "target": "agent-layout", "animated": true },
    { "id": "e-copy-agent", "source": "asset-copy", "target": "agent-layout", "animated": true },
    { "id": "e-agent-output", "source": "agent-layout", "target": "output-board", "animated": true }
  ]
}
```

## 8. run-events.ndjson

以下是 mock 适配器对这一张画布**实际会发**的事件序列（`id` 由 `nextId()` 生成，值随运行时间变化；`progress` 是真实计算值：起始 12，每个节点 +16，上限 92；节点顺序由「asset 优先」排序决定）：

```ndjson
{"id":"event-1","type":"queued","label":"已排队 · 绑定画布版本 canvas-v3","detail":"4 个节点 / 3 条连接","progress":4}
{"id":"event-2","type":"started","label":"运行时已开始执行","detail":"DSH Adapter · 演示模式","progress":10}
{"id":"event-3","type":"node-started","label":"陶瓷杯 · 主图 开始执行","nodeId":"asset-product","progress":12}
{"id":"event-4","type":"node-completed","label":"陶瓷杯 · 主图 已就绪","nodeId":"asset-product","progress":28}
{"id":"event-5","type":"node-started","label":"品牌卖点与语气 开始执行","nodeId":"asset-copy","progress":28}
{"id":"event-6","type":"node-completed","label":"品牌卖点与语气 已就绪","nodeId":"asset-copy","progress":44}
{"id":"event-7","type":"node-started","label":"商品视觉编辑 开始执行","nodeId":"agent-layout","progress":44}
{"id":"event-8","type":"node-completed","label":"商品视觉编辑 已就绪","nodeId":"agent-layout","progress":60}
{"id":"event-9","type":"node-started","label":"详情页首屏构图 开始执行","nodeId":"output-board","progress":60}
{"id":"event-10","type":"node-completed","label":"详情页首屏构图 已生成资产","detail":"PNG · 1:1 · 可被下一轮引用","nodeId":"output-board","progress":76}
{"id":"event-11","type":"completed","label":"运行完成 · 生成 1 个可引用资产","detail":"产物已写回画布节点","progress":100}
```

## 9. 需要 LumoAi 源码回答的问题

1. `Project` / `CanvasVersion` 的真实类型与版本列表接口是什么？
2. 连线是执行依赖还是纯视觉引用？多入边时的聚合语义如何定义？
3. 自动保存是增量 diff、整图 PUT 还是 CRDT？冲突怎么解？
4. 节点能否单跑？单跑产物如何回填 `artifactId`？
5. 失败与取消是事件还是 HTTP 状态？失败产物是否保留？
