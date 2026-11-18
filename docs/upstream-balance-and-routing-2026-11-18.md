# 上游余额与统一路由（2026-11-18）

后台「模型与上游」这一轮的改动：**按渠道显示上游余额、低于阈值标红**，以及**把 60 多个模型收成「一条能力一条主路由」**。

## 一、为什么余额不能直接读

先做的是只读探测（不生成、不花钱），结论和预想的不一样：

| 平台 | `/v1/models` | 余额接口 | 结论 |
| --- | --- | --- | --- |
| GeteAPI | 200（Key 有效） | `/v1/dashboard/billing/subscription` 回 200，但 `hard_limit_usd: 100000000`；`credit_grants` 404 | **中转 Key 读不到余额**，那是 New API 的占位值 |
| SeeAPI / CGCM | 200（Key 有效） | `/v1/dashboard/*`、`/api/balance`、`/api/user/balance` 全 404 | 没有余额接口 |

中间踩过一个坑值得记下来：直接拿 `model-keys.json` 里的 `apiKey` 去请求会 401，因为**文件里存的是密文**（`.model-keys.secret` 解密），不是 Key 失效。解密后两条通道都是 200。`keyMaterial(id)` 返回的是对象（`{id,name,provider,baseUrl,apiKey,...}`），不是字符串。

所以要拿真实余额只有一条路：**GeteAPI 账号的访问令牌**，打 `/api/user/self` 拿 `quota`，除以 `/api/status` 的 `quota_per_unit`（本站 500000）换成金额。

## 二、功能形状

`server/upstream-balance.mjs`（配置落 `DATA_DIR/upstream-balance.json`，0600）：

- 两条渠道写死在一个常量里，界面永远都列出来：
  - `geteapi`（kind=`newapi`）：用访问令牌自动读；New API 的用户接口要 `New-Api-User` 请求头，所以也支持填用户 ID（可选，401 时再填）。
  - `seeapi`（kind=`manual`）：没有余额接口，只能手动登记。
- 三态：`low`（低于阈值）/ `ok` / `unknown`（没核对过、没令牌、上游读失败）。
- 令牌是凭证：接口只回 `hasToken` 与 `••••后四位`，明文只落数据目录；令牌留空 = 沿用旧的，`clearToken=true` 才真的清掉。
- 缓存 10 分钟（`BALANCE_TTL_MS`）：开页面顺手刷一次，失败只记错误不抛，界面看到的是「上次核对失败 + 原因」。

路由（`server/routes/admin.mjs`）：

```
GET  /api/admin/upstream-balance          读余额表（顺手刷新超过 10 分钟的自动渠道）
PUT  /api/admin/upstream-balance/channel  保存令牌 / 用户 ID / 阈值 / 手动金额
POST /api/admin/upstream-balance/check    真打一次上游账号接口，结果落盘再回话
```

三个动作都记审计（`upstream.balance.save` / `upstream.balance.check`），删除与写入都带操作人。

## 三、统一路由

`server/model-routes.mjs` 是唯一真源，四条能力：

| 能力 | 主路由 | 平台 | 上游单价 |
| --- | --- | --- | --- |
| 文本 | `deepseek-flash`（环境变量） | DeepSeek | — |
| 视觉 | `deepseek-flash`（环境变量） | DeepSeek | — |
| 出图 | `gpt-image-2` | GeteAPI | $0.048 / 次（分组 default ×0.8） |
| 出视频 | `seedance-2.0` | SeeAPI / CGCM | ¥0.4851 / 秒（480p 4 秒档，整段 ¥1.9404） |

- 模型目录每行带 `route: primary | reference`，后台表格多一列「路由」：主路由绿标，其余中性标「仅参考」。
- 汇总按目录现算：`routeSummary(rows)` 给出 `primaryCount` 与 `referenceCount`，不写死数字（当前实测 57 个仅参考）。
- 文本与视觉的型号来自环境变量（`LLM_MODEL` / `VISION_MODEL`），改型号不用改代码。
- **没有动的**：出图 / 出视频代码里原本就各自只认一个型号（`server/routes/media-gen.mjs` 的 `IMAGE_MODEL` / `VIDEO_MODEL`），所以这次是把后台与管理口径对齐，不是把线上切到别的模型。

## 四、验收

- `test/upstream-balance.test.mjs` 8 条：quota 换算、三态阈值、令牌只回末四位、令牌留空沿用 / clearToken 清掉、手动登记的来源与时间、New API 真读一遍（带 `New-Api-User` 头、quota 10,000,000 → ¥20）、401 说人话、没有余额接口的渠道不做假自动核对。
- `test/model-routes.test.mjs` 3 条：四条能力各一条主路由、同能力其它模型一律仅参考、汇总按目录现算。
- 真实渲染：`docs/upstream-balance-1440.png`（整页）、`docs/upstream-balance-card-1440.png`（余额表，GeteAPI 标红 / SeeAPI 正常）、`docs/upstream-balance-390.png`（390 无横向溢出）。截图来自本机临时实例（临时 DATA_DIR + 管理员账号 + 同一份 dist），样例余额是写入的，不是真余额。

## 五、真实配置与真实余额（2026-11-18 14:31）

授权后在你已登录的浏览器里走完整条路，踩了三个坑，都写进代码或文档了：

1. **`New-Api-User` 是必需的**：只带 `Authorization: Bearer <access token>` 打 `/api/user/self` 会 401（实测）；带上账号 id 才 200。所以界面里「New API 用户 ID」不是可选项的摆设，401 时要填。
2. **`/api/user/token` 每调一次就重签**：第一次拿到的令牌被我第二次调用冲掉，服务端核对直接 401。教训：生成一次就用，别为了「确认一下」再调。
3. **货币符号回的是 `¤`**（通用货币符），不是 `¥`。已加 `currencySymbol()` 归一：`¤` 与空串按 `¥` 显示，别的符号照用。

真实结果（生产，`GET /api/admin/upstream-balance`）：

```json
{ "id": "geteapi", "amount": 19.6377, "used": 0.5623, "currency": "¥", "state": "low", "source": "auto", "threshold": 20 }
```

`19.6377` 就是面板上的 ¥19.64（quota 9,818,858 ÷ 500,000），**低于 ¥20 阈值所以标红**。SeeAPI 仍是「未核对」，等对账单手动登记。生产截图：`docs/upstream-balance-live-1440.png`（真实生产、真实余额，不是样例数据）。

令牌与临时管理员会话都已清理：令牌只落在 `/var/lib/visionqa/upstream-balance.json`（0600、visionqa:visionqa），临时会话用 `destroySession` 撤销，本机临时文件已删。

## 六、边界

- **还没有真实余额数字**：GeteAPI 控制台需要账号登录才能生成访问令牌，这一步等用户配合一次。在那之前界面显示「未核对」，手动登记的渠道照常可用。
- `New-Api-User` 是否必需取决于站点版本：代码里是可选项，401 时界面会提示去填用户 ID。
- SeeAPI / CGCM 永远只能手动登记，别把它当成实时数。
- 余额是「账号余额」，不是「这个 Key 的剩余额度」；一个账号多把 Key 共用同一份余额。
