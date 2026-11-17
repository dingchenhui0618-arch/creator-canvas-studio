# 告警外推链路自检：能推、会签名、失败会排队、能补发（2026-11-17）

结论先行：**告警外推的代码是通的**，失败会进队列、通道能热改、请求带 HMAC 签名、手动重试能补发。但**生产至今没有配通道**（`/var/lib/visionqa/alert-channel.json` 不存在），也就是说现在线上出 5xx、模型额度被打满、磁盘不够时，只会落在后台告警列表里，**不会有人收到通知**。

这轮用临时实例 + 本地假接收端把这条链路演了一遍，生产未动。

## 一、为什么先做

「告警 webhook」一直挂在待办里等一个地址。地址没给之前，先确认就算给了、代码能不能用——尤其是三件容易出错的事：推不出去时告警会不会丢、改了地址要不要重启、接收端能不能验签防伪造。

## 二、怎么搭的

| 角色 | 位置 | 说明 |
| --- | --- | --- |
| 临时实例 | `127.0.0.1:8803` | 同一份服务端代码，`DATA_DIR=/tmp/vq-alert-e2e/data` |
| 假接收端 | `127.0.0.1:2526` | 一个 HTTP 口，把每次 POST 的方法、头、原始 body 落盘 |
| 「打不通」 | `127.0.0.1:2527` | 不发任何服务，用来制造首推失败 |
| 生产 | `127.0.0.1:8799` | 完全没参与；测完仍是 `/api/health` 200、`alert-channel.json` 不存在 |

## 三、跑出来的证据

| 步骤 | 结果 |
| --- | --- |
| 配之前 `GET /api/admin/alerts` | `channel.configured: false`，队列 `pending 0 / dead 0 / total 0 / sentCount 0` |
| `PUT /api/admin/alerts/channel`（指向打不通的端口） | 200，`configured: true`，**首次保存回一次签名密钥**（之后只给掩码） |
| `POST /api/admin/alerts/test`（打不通） | 201；告警落库，外推失败 → 队列里出现 `odb_068507d8`、`state: pending`、`lastError: fetch failed` |
| `PUT channel`（换成能收的地址，不换密钥） | 200，`secretKept: true` —— **换地址不用重启、不用重配接收端** |
| `POST /api/admin/alerts/test`（能收） | 201；接收端收到 `POST /hook`，`user-agent: VisionQA-alert/1` |
| 签名 | 头里 `x-vq-signature` 存在，且**与用密钥重算的 HMAC-SHA256 完全一致** |
| 正文 | `{"source":"visionqa","alert":{"kind":"test",…},"text":"[测试告警] 测试告警：后台链路正常 · …"}` |
| 手动重试那条失败的 | `POST /api/admin/alerts/outbox/odb_068507d8/retry` → 200，`state: sent`；接收端**再收到一条**，签名同样对得上 |
| 收尾状态 | 队列 `pending 0 / dead 0`，`sentCount: 2`，`lastSentStatus: 200`；告警列表 `open 1`（两条测试告警按 kind 合并计数） |

一句话：**推不出去不会丢**（进队列等重试），**地址能热改**，**接收端可以验签**，**补发是真的一发就通**。

## 四、可复跑

```bash
ALERT_E2E_DIR=/tmp/vq-alert-e2e VQ_APP_ROOT=/opt/visionqa bash scripts/alert-e2e/run.sh
```

退出码 0 = 全链路通过。脚本在 `scripts/alert-e2e/`（复用 `scripts/mail-e2e/seed-user.mjs` 建测试账号）。

## 五、边界（重要）

- **我们的正文是通用 JSON**（`{text, alert, source}`）。飞书 / 钉钉 / Slack 的机器人各自要求自己的结构（飞书要 `{"msg_type":"text","content":{"text":…}}`、钉钉要 `{"msgtype":"text","text":{"content":…}}`），**直接把机器人地址填进来，多半会被回 400**——队列会一直重试、日志会显示失败，但人还是收不到。要真发进群，需要两选一：接一个中转（n8n / 自建 webhook / 企业微信中转），或者我们加一层按域名判定的适配器。
- 假接收端只能证明「请求发出去了、签名对、重试生效」，不能证明第三方机器人一定接受这个结构。
- 本轮没有向任何外部地址发过请求（全部指到 `127.0.0.1`），也没碰生产的告警队列文件（`alert-outbox.json` 仍是 11-13 的旧文件）。
