# 视觉评审接入说明（VisionQA × Workbench）

日期：2026-11-03 · 实现：server/review.mjs + server/routes/review.mjs + src/pages/ReviewPage.tsx

结论先行：工作台不自己发明评审口径，直接用 VisionQA 的 visual-baseline；能连上 VisionQA 插件服务就用插件的契约结果，连不上就用本地模型按同一套规则出结果，**并在返回里写清 provider，绝不把本地模型结果冒充成插件结果**。

## 一、为什么放在这三个位置

| 落点 | 用户场景 | 代码入口 |
| --- | --- | --- |
| 独立页面「视觉评审」 | 手上有一张画面，想知道能不能投 | src/pages/ReviewPage.tsx |
| 模板库「送去评审」 | 复刻完一条模板，先确认首帧能当封面 | 模板详情抽屉 → src/state/review.ts → vq:navigate |
| 画布 review 节点 | 把评审写进流程，下游引用结论 | server/flows.mjs 的 review 节点 |

## 二、契约映射

VisionQA 插件的请求是 multipart：request（JSON 信封）+ candidate（被检视图）+ references（可选参考图）+ provider。工作台这边做了最小映射：

| VisionQA v0.1 字段 | Workbench 里的来源 |
| --- | --- |
| schema_version | 固定 visual-review-v0.1 |
| request_id | 每次评审生成 vr_xxxxxxxx |
| artifact.kind / label | image + 被选中的模板标题或图片名 |
| intent | 用户在评审页的意图（默认「这张画面能不能当封面」） |
| constraints.locale | zh-CN |
| permissions.allow_network | false（评审器不上网） |
| operation.mode | review（不做重生 / 不做改写） |

返回侧只取工作台需要的四件事：verdict、observations（含维度、严重度、statement、evidence、confidence）、fixes、notAssessable，另外补 provider / ms / mode / note 四个展示字段。

## 三、证据锚点

- evidence 是相对坐标 `{x, y, w, h}`，取值 0–1，前端按百分比定位到图片元素上（.review-canvas-shot 与图片同尺寸，避免黑边导致的偏移）。
- 没有 evidence 的 observation 仍然展示，但会明确标「无锚点」，严重度自动降级为 info。
- 严重度只用 blocker / major / minor / info；只有 blocker + major 才算进 verdict=needs_review 的理由。
- 模型给不出判断时写进 notAssessable，例如「看不到动效时序」「未提供投放尺寸」。

## 四、两种 provider 与降级行为

| provider | 触发条件 | 特点 |
| --- | --- | --- |
| visionqa-plugin@<host:port> | GET {VISIONQA_SERVICE_URL}/api/health 返回 200 | 走插件自身的评审实现；fixture provider 只证明链路通，不代表准确率，note 里会写 |
| local-model:<model> | 插件服务不可达，或调用失败 | 本地视觉模型按同一份 visual-baseline 规则出 JSON，形状与插件结果一致 |
| unavailable | 两者都不可用 | 返回 verdict=needs_review + 明确说明「没有可用评审通道」，observations 为空，不伪造结论 |

实测（2026-11-03，插件服务未启动）：

| 被检视画面 | provider | 耗时 | 结果 |
| --- | --- | --- | --- |
| tpl_1f748225 首帧 | local-model:gpt-6-luna | 84.2s | pass，5 条 observation |
| tpl_7685d0b2 首帧 | local-model:gpt-6.1-sol | 72.9s | 需人工确认，7 条 observation，6 个锚点 |

## 五、怎么用

```bash
# 健康检查：看插件服务与本地模型是否可用
curl http://127.0.0.1:8787/api/review/health

# 评审一段本地抽帧（路径相对 data/）
curl -X POST http://127.0.0.1:8787/api/review -H 'Content-Type: application/json' \
  -d '{"media":"frames/tpl_7685d0b2/frame-01.jpg","intent":"这张首帧能不能当封面"}'
```

想用插件服务出结论，先把 VisionQA 仓库起在 6300（`npm run dev:local`），再把 VISIONQA_SERVICE_URL 指过去即可，前端不用改。

## 六、现在没做的

- 参考图对比（references）：接口留了位置，前端还没有 A/B 对比视图。
- 评审结果没有落盘成 artifact，运行记录里只有画布运行；把评审写进 data/reviews.json 是下一步。
- 没有做多张画面批量评审与队列。
