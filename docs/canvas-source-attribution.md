# 画布模块开源调研与来源说明

日期：2026-11-03
范围：VisionQA Workbench「画布」模块（流程编排、节点执行）在交互与信息结构上的参考来源。
结论先行：**没有复制任何项目的源码**。只借鉴了「左侧节点面板 + 中间画布 + 右侧检查器」这类通用编辑器布局、节点运行状态的表达方式，以及 React Flow 官方数据模型；实现、视觉语言、节点类型和执行逻辑均为本项目原创。

## 一、调研对象与许可证（以各仓库 LICENSE 原文为准）

| 项目 | 许可证 | 前端技术栈 | 调研方式 | 借鉴内容 |
| --- | --- | --- | --- | --- |
| [Langflow](https://github.com/langflow-ai/langflow) `src/frontend/package.json` | MIT（Copyright (c) 2024 Langflow） | React + `@xyflow/react` + Vite | 读 LICENSE、package.json、界面结构 | 三栏编辑器布局、节点内联参数摘要的呈现思路 |
| [Flowise](https://github.com/FlowiseAI/Flowise) `packages/ui/package.json` | Apache-2.0；`packages/server/src/enterprise` 与企业标识文件另走商业许可 | React + `reactflow`（v11）+ Vite | 读 LICENSE.md、package.json | 节点检查器（右侧表单）的信息分组方式 |
| [n8n](https://github.com/n8n-io/n8n) `packages/frontend/editor-ui/package.json` | Sustainable Use License（fair-code）；`.ee.` 文件与非 main 分支不在授权范围 | Vue + `@vue-flow/core` | 读 LICENSE.md、package.json | 「运行后逐节点状态 + 耗时」的可视化启发；**未复制任何代码** |
| [Dify](https://github.com/langgenius/dify) `web/package.json` | 修改版 Apache-2.0（额外条件：多租户 SaaS 需商业授权、保留品牌标识） | Next.js + React + `reactflow`（v11） | 读 LICENSE、package.json | 只看了工作流编辑器的信息层级，未使用其代码 |
| [React Flow / xyflow](https://github.com/xyflow/xyflow) | MIT（Copyright (c) 2019-2025 webkid GmbH） | React 画布库（本项目使用 `@xyflow/react` 12.x） | 官方文档与类型定义 | 节点/连线数据模型、`Handle`、`MiniMap`、连接校验 API |

许可证原文核对地址：
- Langflow：<https://raw.githubusercontent.com/langflow-ai/langflow/main/LICENSE>
- Flowise：<https://raw.githubusercontent.com/FlowiseAI/Flowise/main/LICENSE.md>
- n8n：<https://raw.githubusercontent.com/n8n-io/n8n/master/LICENSE.md>
- Dify：<https://raw.githubusercontent.com/langgenius/dify/main/LICENSE>
- xyflow：<https://raw.githubusercontent.com/xyflow/xyflow/main/LICENSE>

## 二、具体借鉴了什么

1. **三栏工作区**（节点面板 / 画布 / 检查器）：Langflow、Flowise、n8n 都是类似结构，属于工作流编辑器的通用布局，不构成对某一实现的复制。本项目的栏宽、发丝线、面板留白按 `docs/design-direction-v2.md` 重新设计。
2. **节点数据模型**：`{ id, type, position, data }` 与 `{ source, target, sourceHandle, targetHandle }` 直接采用 React Flow 官方模型（MIT），没有套用 Langflow/Flowise 的扩展字段（例如它们的 `data.node`、`data.inputs` 结构）。
3. **连接校验**：禁止自环、每个输入端口只接一根线、禁止成环。规则来自工作流编辑器的通用约束（n8n 的 input 端口、Langflow 的单连接手柄都有类似限制），校验函数 `src/canvas/serialize.ts` 中的 `validateConnection` 为本项目独立实现，错误文案为中文原创。
4. **运行状态可视化**：节点在 pending / running / done / error / skipped 之间切换，并显示耗时。n8n 的执行视图是这一表达的成熟先例；本项目用「状态点 + 卡片描边 + 等宽耗时」重做，未使用其图标、颜色或 DOM 结构。
5. **拓扑执行**：先按入线计算层级，再顺序执行；条件节点用 `true`/`false` 两个 source handle 决定激活分支。该思路是 DAG 工作流引擎的通用做法，`server/flows.mjs` 中的 Kahn 实现为本项目原创。

## 三、明确没有做的事

- 没有复制 n8n 的任何代码或资源（其 Sustainable Use License 限制再分发与商用，本项目只在概念层面参考）。
- 没有引用 Flowise 的 `enterprise` 目录内容（该目录为商业许可）。
- 没有复制 Dify 的代码；Dify 的附加条款（多租户、品牌保留）不适用于「仅参考交互」的场景。
- 没有搬运 Langflow 的节点组件、图标或文案。
- 没有引入任何新的第三方运行时依赖；画布只使用项目已有的 `@xyflow/react` 与 `lucide-react`。

## 四、本模块的原创部分

- 7 种节点类型与语义：input / llm / kb / tool / condition / review / output，以及各自端口（llm 的 prompt + context、condition 的 true/false）。
- 单色视觉语言：发丝线卡片、等宽类型标签（INPUT / LLM / KB / IF / REVIEW / OUTPUT）、选中用 `--ink` 描边、无彩色辉光。
- 交互：从面板拖入或点击添加、添加时自动避让已有节点、配置项 1.2s 合并的撤销栈、Ctrl+S / Ctrl+Z / Ctrl+Shift+Z。
- 执行：服务端按拓扑序执行、条件分支跳过、NDJSON 流式回传、逐节点状态点亮、运行记录写入 `data/runs.json`。
- 检查器字段与文案、空态提示、运行抽屉的信息层级，均按 VisionQA 的产品语境重新撰写。

## 五、依赖许可

| 依赖 | 许可证 | 用途 |
| --- | --- | --- |
| `@xyflow/react` 12.x | MIT | 画布、节点、连线、缩放/小地图 |
| `lucide-react` | ISC | 线性图标 |
| `react` / `react-dom` 19 | MIT | UI 运行时 |
| `vite` 8 | MIT | 开发与构建 |
