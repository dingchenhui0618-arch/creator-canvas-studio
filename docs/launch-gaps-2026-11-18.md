# 上线缺口待办（2026-11-18，按用户要求先放着）

状态：**未完成**。用户明确「D1-D5 先放着」；本轮只做 P2（去上游名、作品流、9:16、术语）。

| # | 缺口 | 现状（2026-11-18 实测） | 谁补 |
| --- | --- | --- | --- |
| D1 | 收款 | `server/routes/billing.mjs` 下单 `channel=internal` 直接 paid，无支付通道；商户号未开 | 用户给商户号，我接 |
| D2 | 价格与积分单价 | `plans.json` 三档 ¥30/100/300（300/1000/3000 积分）；`usage-prices.json` 全 0；`quota.json` 月限 0 | 用户定数 |
| D3 | 自助注册 | `/api/auth/config` → registrationEnabled=false，只能管理员建号 | 用户拍板，我改配置 |
| D4 | 站点公示 | `/api/app` 六项全空（icp / operator / address / creditCode / supportEmail / complaint），complete=false | 用户给 6 项 |
| D5 | 合规动作 | 生成式 AI 备案 / 内容审核未做（代码里的 AI 标识已上线） | 用户办备案，我接审核 |
| P1 | 告警通道 | 无 `alert-channel.json`，故障只落盘；14 条告警 11 条未确认 | 用户给 webhook |
| P1 | 异地备份 | `backup-status.json` 的 `offsite: null` | 用户给目的地 |
| P1 | 生产形态 | 6677 跑 vite dev、2GB 内存 6 服务、未压测 | 我 |
| P1 | 未验功能 | 参考图出图、参考素材生视频、1:1 视频、480p、10 次真实复刻 | 需用户授权真实调用 |

下一步顺序（用户点头后）：支付 → 注册/公示 → 上线底座（告警/构建产物/压测）→ 真调补证 → 灰度。
