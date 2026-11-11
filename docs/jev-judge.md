# 判断层：Jev 给评审结论再判一次

视觉评审现在有两层：视觉模型回答「画面哪里有问题」，判断模型（TypeSafe / Jev）回答
「这份结论站不站得住」。这份文档说明为什么要第二层、它问哪几个问题、怎么在后台接一把 Key，
以及判断层缺席 / 失败时会发生什么。

适用代码：`server/judge.mjs`（判断调用与答案映射）、`server/review.mjs`（评审后挂判断）、
`server/keyvault.mjs` 的「判断」能力、评审页的「判断模型 · Jev」区块。

## 一、为什么单独一层

- **口径不同**：视觉模型说的是「哪里有问题」，判断模型说的是「结论与证据一致吗、建议能落地吗」。
  把两者塞进一句话，出了问题分不清是谁的判断。
- **不改结论**：判断层只加依据，**绝不覆盖** `verdict`。两者不一致时以视觉证据为准，再人工确认。
- **不新增故障点**：没配 Key、Key 挂了、上游超时，评审照常出结论，只是少一块依据。

## 二、问哪四个问题

一次请求问完（同一份 `state`，四个问题互相看不见）：

| 问题 | 类型 | 在问什么 | 界面显示 |
| --- | --- | --- | --- |
| `evidence_consistent` | noul | 每条问题是否真有画面依据，而不是套话 | 结论有画面依据 78% |
| `verdict_supported` | choice | 结论与问题严重度是否一致（偏严 / 偏松） | 结论与问题一致：一致 / 偏严 / 偏松 |
| `actionable` | noul | 修正建议是否具体到能直接动手 | 建议可直接执行 91% |
| `publish_risk` | score | 放到真实渠道前，问题的紧迫程度（0 可发 / 1 小修 / 2 必须先解决） | 发布前风险：小修后可以发布 |

发给判断模型的 `state` 只含评审结构（意图、结论、问题清单含是否有像素锚点、建议、无法判断项），
不含图片本身，也不含对话原文。

## 三、怎么接一把 Key

判断模型走**平台 Key 池**，和出图 / 出视频同一套规则（能力 → 优先级 → 权重 → 故障回退）：

1. 后台「模型 Key」→ 渠道选「TypeSafe（Jev 判断）」，接口地址 `https://api.typesafe.ai/v1`；
2. API Key 粘贴 TypeSafe 的 Key；
3. 模型填 `jev-latest`（没填则按 `jev-latest` 发）；
4. **能力勾「判断」**（别名 judgment / jev / typesafe / 判断 也会归到这一项）。

保存即生效。判断层用 `resolveKeyCandidates({ capability: 'judge' })` 选 Key，
最多试 2 把，失败记到那把 Key 的健康度并进路由日志（后台「最近路由」里能力显示「判断」）。

接口契约（TypeSafe System One）：

```http
POST {baseUrl}/systemone
Authorization: Bearer <平台 Key>
Content-Type: application/json

{"model":"jev-latest","state":{"intent":"…","verdict":"needs_review","problems":[…],"fixes":[…]},"questions":{…}}
```

响应里 `answers` 的键就是问题名；平台把 `noul` / `choice` / `score` 映射成
`evidenceConsistent` / `verdictSupport` / `actionable` / `publishRisk`，连同 `usage` 一起挂在评审结果的 `judge` 字段上。

## 四、三种状态

| status | 什么情况 | 界面 | 评审 |
| --- | --- | --- | --- |
| `ok` | 判断模型正常返回 | 四个判断并排显示，附模型名与耗时 | 照常 |
| `disabled` | 池里没有「判断」能力的 Key | 虚线框写「判断模型还没接入」 | 照常 |
| `failed` | 连不上 / 4xx / 5xx / 返回不是 JSON / 没有答案 | 虚线框写「这次没跑通」，原因在后台路由日志 | 照常 |

`GET /api/review/health` 也返回判断层状态：

```json
{"service":false,"model":true,"judge":{"configured":true,"provider":"typesafe","model":"jev-test"}}
```

## 五、验证情况（2026-11-11，内部测试环境）

用假视觉上游 + 假 TypeSafe 上游跑通整条链路（生产 Key 池没动，生产仍有余额问题）：

- `/api/review/health` 返回 `judge.configured: true`、`model: jev-test`；
- 一次真实评审（`POST /api/review`）返回 `judge.status: ok`：
  依据 78%、结论一致、建议可执行 91%、发布前风险 1.3（小修后可以发布），`usage` 412/26 token；
- 发给判断层的请求确实只有四个问题，`state.problems` 3 条、`state.fixes` 2 条；
- 路由日志两条：判断 23 ms 成功、视觉 32 ms 成功；截图见
  [评审页判断区块](screenshot-review-judge-2026-11-11.png)；
- 自检用的临时 Key、临时管理员账号与假上游跑完即删（内部实例 Key 池回到 0 把）。

**还没验证**：真实 TypeSafe 账号（没有 Key，登录注册需要业务方提供）；Jev 的图像能力
（TypeSafe 的图像危险区需要 `jev-preview` 与 `TypeSafe-Danger-Zone-Images` 头，当前判断只看评审文本，
不看图片本身）；按次成本与配额。
## 六、两种判断器与地区限制实测（2026-11-11 第二十四批）

### 6.1 为什么加第二种

TypeSafe 官方接口在**生产服务器（腾讯云上海）出口被地区拒绝**——`GET /v1/models` 与
`POST /v1/systemone` 都回 `451 {"title":"Typesafe is not available in your region."}`。
也就是说，即使拿到 Key，判断层在生产也调不通。同一台机器上的 Node 直接请求同样 451，
而家用宽带的开发机是 `403 Must supply an API key`（可达），所以不是域名或路径问题，是出口地区。

判断层的价值在「四个结构化判断」，不在某一家供应商。于是判断器支持两种协议，按 Key 自动选：

| Key 的渠道 / baseUrl | 协议 | 请求 |
| --- | --- | --- |
| 渠道选「TypeSafe（Jev 判断）」，或 baseUrl 域名是 typesafe.ai | systemone | `POST {baseUrl}/v1/systemone`（baseUrl 少写 `/v1` 会自动补） |
| 其它（DeepSeek / 百炼 / 中转） | chat | `POST {baseUrl}/v1/chat/completions`，要求按固定 JSON 回同样四个判断 |

两条协议共用同一套解析与展示：`evidenceConsistent` / `verdictSupport` / `actionable` / `publishRisk`，
界面上看不出来源差异，只多一个「对话形态 / TypeSafe 形态」的说法。

### 6.2 后台「测试 Key」真跑一次判断

勾了「判断」的 Key，点「测试」不会只探 `/models`，而是拿一小段样例评审真调一次判断（`judgeSelfCheck`），
结果显示在 Key 那一行的状态列：

- 通过：`判断自检通过（对话形态，风险 1/2）`
- 失败：`判断自检失败：判断模型在当前网络不可用：上游按地区拒绝（HTTP 451）。换一条出口，或改用国内可用的判断模型`

只声明判断能力的 Key，「测通」以判断调通为准；同时声明对话 / 视觉的 Key，主结果仍看对话探测。

### 6.3 线上实测（生产 https://visionqa.wavisionai.cn）

| 用例 | Key | 结果 |
| --- | --- | --- |
| 对话形态判断器 | 本机回环 stub（OpenAI 兼容，仅验收用） | `判断自检通过（对话形态，风险 1/2）`，四项判断全部回填：依据 0.74 / 结论偏严 / 可执行 0.61 / 风险 1 |
| TypeSafe 官方 | baseUrl `https://api.typesafe.ai/v1` | 凭证探测与判断自检都是 `接口在当前网络不可用（上游按地区拒绝，HTTP 451）` |

验完把两把临时 Key 删掉、回环进程杀掉，池里仍是两把真 Key，路由日志归零。

### 6.4 顺带修掉的两个真实坑

- **连接复用**：上游（经 CDN）回 4xx 后会掐连接，复用同一条连接的下一次 `fetch` 直接抛 `fetch failed`，
  管理员只看到一句查不出原因的报错。判断请求与凭证探测都改成**网络层失败重试一次**，
  现在同一次点「测试」能稳定拿到 451 与原因。
- **报错说人话**：不再把上游 JSON 原样塞进表格。451 / 401 / 402 / 404 / 429 各自一句话，
  状态列允许换行最多三行（完整内容悬停可看），不再被省略号吃掉原因。

### 6.5 还没验证

真实 TypeSafe 账号的四个判断质量（生产出口 451，需要一条境外出口或代理）；
真实国内判断模型（DeepSeek 余额仍是 0，补上后把它的能力勾上「判断」即可直接用）。
## 七、真实判断模型的质量实测（2026-11-11 第二十五批）

前两批只证明「链路通」，这一节回答的是「判断准不准」。

### 7.1 怎么测的

- 判断器：真实模型 `gpt-5.6-luna`（本机 OpenCodex，OpenAI 兼容），能力只勾「判断」；
- 视觉评审：同一个真实模型按 visual-baseline 评审一张真实的画布截图（公网地址，仓库 `docs/screenshot-canvas.png`）；
- 位置：**本地验收实例**（独立 `DATA_DIR`），生产 Key 池没动，也没额外花上游额度；
- 一次完整 `POST /api/review`：视觉结论 74.7 秒，判断层 12.1 秒、1385 token。

### 7.2 真实结果

| 项 | 结果 |
| --- | --- |
| 视觉结论 | `needs_review`，7 条问题（3 主要 / 2 次要 / 2 信息） |
| 结论有画面依据 | 45% |
| 结论与问题一致 | 一致（0.95） |
| 建议可直接执行 | 90% |
| 发布前风险 | 2（必须先解决问题再发布） |

截图：[评审页判断区块](screenshot-review-judge-real-model-2026-11-11.png)。

### 7.3 区分力：三份受控样本

| 样本 | 内容 | 依据 | 一致性 | 可执行 | 风险 |
| --- | --- | --- | --- | --- | --- |
| A | 点名元素 + 对比度数值 + 精确锚点 | 0.95 | supported | 0.80 | 2 |
| B | 套话、无锚点 | 0.05 | supported | 0.02 | 2 |
| C | 结论 pass 但有 blocker | 0.10–0.20 | too_lenient（0.98） | 0.85 | 2 |

同一内容重复跑波动约 ±0.15（推理型模型 + 温度 0 仍非确定性）。结论：判断器在核对证据（B 被压到 0.05），
也会抓结论与问题不一致（C 判偏松），可以采信方向，不要把个位数百分比当判决。

### 7.4 真实模型暴露的三个接口问题（已修）

1. **json 模式**：严格实现要求启用 `response_format: json_object` 时输入里出现 "json" 字样，
   实测直接 400（`Response input messages must contain the word 'json' …`）。现在命中这类 400 会
   **去掉 json 模式重发一次**，解析层本来就能从带围栏 / 带前缀的回复里挖 JSON。
2. **5xx 抖动**：本机 OpenCodex 实测三次里两次 502。现在 5xx **隔 800ms 重发一次**。
3. **超时**：12 秒会把正常的推理型判断模型判成失败（单次 12–25 秒），改成 30 秒。

### 7.5 判断层给出的真问题：我们的评审太虚

真实那次的「依据 45%」是判断器对**评审提示词**的批评：问题描述停在维度层（「缺少第一视觉落点」），
锚点框的是整块画布，证据推不出这句话。判断层没装错，是上游的评审结论不够可核对。
下一批该做：评审提示词收紧到「每条问题必须点名元素 + 数值 / 区域，做不到就降级成信息」，然后复测依据分。

### 7.6 仍然没验证

- 真实 TypeSafe 账号（生产出口 451，需要境外出口或代理）；
- DeepSeek 当判断器（余额 0）；
- Jev 的图像能力（当前判断只看评审文本，不看图片本身）；
- 判断层的按次成本与配额。
