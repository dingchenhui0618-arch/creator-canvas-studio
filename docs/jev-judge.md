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
