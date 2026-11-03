# ROADMAP

> 事实基线：2026-11 的 `src/` 当前 HEAD。M1 只列**真实存在**的能力；凡界面上看起来有、但代码没接的，都写在「未实现」里。
> 相关：[画布数据契约](./canvas-contract.md) · [运行时适配器契约](./adapter-contract.md)

## M1.5 · 已完成：检索 → 一键复刻 → 模板库

| 能力 | 位置 | 现在能做什么 | 事实边界 |
| --- | --- | --- | --- |
| 爆款雷达 | `src/pages/RadarPage.tsx` | 平台/关键词/时间范围检索，卡片展示互动数据，悬停「一键复刻」 | 未配 `REDFOX_API_KEY` 时是示例数据（界面黄条说明） |
| 一键复刻 | `src/components/ReplicateModal.tsx` | 来源选择、5 步进度、实时日志、完成摘要、失败重试 | 平台链接解析要红狐 Key，无 Key 时用 mp4 直链 |
| 拆帧流水线 | `server/media.mjs`、`frames.mjs` | ffprobe 探测 + 场景切镜 + 均匀补帧 + ffmpeg 抽帧 | 上限 18 帧 / 160 MB |
| 逐帧分析 | `server/vision.mjs` | 严格 JSON 的脚本结构、分镜表、爆款分析；模型降级链 | 只听不到声音，无配音视频给「建议口播」 |
| 模板库 | `src/pages/TemplateLibraryPage.tsx`、`server/templates.mjs` | 按内容类型/关键词检索、详情抽屉、复制脚本、复用计数、删除 | 单机 JSON 存储，无账号隔离 |
| API | `server/index.mjs` | `/api/search`、`/api/replicate`、`/api/jobs/:id`、`/api/templates`、`/media/frames`、`/api/cover` | 任务状态在内存，重启丢失 |

**M1.5 验收标准**：`npm run build` 与 `npm run lint` 通过；用一条公开测试视频能跑完整条链路，模板库里能看到脚本结构、分镜表、原视频链接；按内容类型筛选能命中；截图见 `docs/screenshot-radar.png`、`screenshot-replicate.png`、`screenshot-templates.png`、`screenshot-template-detail.png`。

## M1 · 已完成：前端框架（演示数据）

| 能力 | 位置 | 现在能做什么 |
| --- | --- | --- |
| 七个页面 | `src/App.tsx` | 导航 6 个入口（工作台、智能体、资产画布、资产库、运行记录、设置）+ 不在导航里的智能体编辑器，用 `activePage` 状态切换，无路由库 |
| 资产画布 | `src/pages/CanvasPage.tsx` | 从资产栏拖入资产（`application/x-asset`）、添加三类节点、连线、选中、属性/引用两个页签、复制、删除（连带边）、撤销/重做（最多 10 步）、适应画布、小地图 |
| 运行 Dock | 同上 | 点「运行画布」走 mock 适配器，展示 5 类事件与进度条，显示产物数量 |
| 智能体编辑器 | `src/pages/AgentEditorPage.tsx` | 5 步配置（基本信息、系统提示词、技能、工具、输入输出）、就绪检查 5 项、技能/工具开关、输入输出字段增删改、试运行对话、发布时版本号 +0.1 |
| 资产库 | `src/pages/AssetsPage.tsx` | 6 条 mock 资产、搜索、图片/文本/视频筛选、「引用」只弹 toast |
| 运行记录 / 设置 / 工作台 | `src/pages/RunsPage.tsx`、`src/pages/SettingsPage.tsx`、`src/pages/OverviewPage.tsx` | 静态展示，无真实数据源 |

**M1 验收标准（已满足）**：`npm run build` 通过；画布可拖、可连、可撤销，刷新后回到初始 4 节点；运行画布能完整走完 11 条事件；编辑器 5 项检查全过时「发布版本」可点。仓库 `docs/` 下已有渲染截图（如 `screenshot-canvas.png`、`screenshot-agent-editor.png`）作为视觉基线。

**明确未实现**（不要在对外材料里算进 M1）：

| 能力 | 缺口 |
| --- | --- |
| 真实模型调用 | 无 `fetch`，适配器 `mode` 恒为 `'mock'` |
| 持久化 / 自动保存 | 无 localStorage / indexedDB，刷新即丢 |
| 失败态与取消 | `RunEventType.failed` 从不发出，无取消按钮 |
| 上传、导出 | 「上传资产」「导出」按钮无 handler |
| 账号、多人协作、计费 | 完全不存在 |
| 底部搜索框、⌘K | 只有展示用的 `kbd`，无快捷键绑定 |

## M2 · 拿到画布源码之后

| 工作流 | 交付物 | 验收标准 |
| --- | --- | --- |
| 协议映射 | 真实 `CanvasVersion` / `Node` / `Edge` 与 `CanvasSnapshot` 的双向映射，差异表 | 用真实 schema 反序列化 `canvas-contract.md` 的示例得到等价图；往返映射字段无损；`references` 的 id 空间统一 |
| 真实保存 | 自动保存协议接入，版本号真实递增 | 刷新不丢；两个标签页先后编辑会出现版本冲突提示而非静默覆盖；运行期间编辑不会污染已发起的 Run |
| 真实运行 | `src/runtime/dshAdapter.ts`，`mode: 'live'` | 取消按钮调用 `cancel()` 并显示「已取消」；`failed` 节点在画布上可见；`Artifact` 回填 `artifactId` 后可被下一节点引用；构建产物中检索不到密钥 |

前置：`canvas-contract.md` 第 9 节的五个问题必须有答案，否则只能继续按「连线=引用、版本=常量」的假设实现。M2 期间允许画布视图组件零改动——只替换适配器与映射层；一旦需要改 `CanvasCard`，说明协议映射设计错了。

## M3 · 之后

| 方向 | 为什么后置 | 前置依赖 | 初版验收标准 |
| --- | --- | --- | --- |
| 智能体发布与复用 | 现在「发布」只改本地状态，没有目录、没有消费方 | M2 的真实运行与版本表 | 已发布版本可被其他画布按 `agentId + version` 引用，且旧版本固定不变 |
| 团队与权限 | 工作区切换器、成员头像都是静态装饰 | 账号体系与持久化 | 成员角色可区分、资产可按工作区隔离 |
| 计费 | 无用量数据，先做会凭空造指标 | 真实运行记录 | 每个 `RunResult` 落一条可审计用量，额度用尽时 `runCanvas` 直接拒绝 |

## 风险

1. **mock 语义漂移**：现在的节点串行与事件时序是演示产物，真实运行时可能是并行 DAG，事件顺序契约要重写而非沿用。
2. **双 id 空间**：引用表存资产库 id、节点 id 是另一套，M2 统一前任何「引用」功能都是假的。
3. **无持久化的迁移成本**：当前状态全在组件内，接入保存时需要先抽出全局 store，这一步最容易低估工时。
